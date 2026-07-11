// Web Push Cloudflare Worker — sends reminder notifications every 2 min

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}

// --- Base64url helpers ---
function b64url(buf) {
  const bytes = buf instanceof ArrayBuffer ? new Uint8Array(buf) : buf;
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(str) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  str = str.replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '');
  const out = [];
  let bits = 0, value = 0;
  for (const c of str) {
    value = (value << 6) | chars.indexOf(c);
    bits += 6;
    if (bits >= 8) { bits -= 8; out.push((value >> bits) & 0xff); }
  }
  return new Uint8Array(out);
}

// --- VAPID JWT ---
async function createVapidJwt(endpoint, vapidSubject, vapidPrivateB64, vapidPublicB64) {
  const aud = new URL(endpoint).origin;
  const exp = Math.floor(Date.now() / 1000) + 60 * 60 * 12;

  const header = b64url(new TextEncoder().encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const payload = b64url(new TextEncoder().encode(JSON.stringify({ aud, exp, sub: vapidSubject })));
  const unsigned = `${header}.${payload}`;

  const pubRaw = b64urlDecode(vapidPublicB64);
  const x = b64url(pubRaw.slice(1, 33));
  const y = b64url(pubRaw.slice(33, 65));
  const d = vapidPrivateB64.trim();

  const key = await crypto.subtle.importKey(
    'jwk',
    { kty: 'EC', crv: 'P-256', x, y, d, ext: true },
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign']
  );

  const sig = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    key,
    new TextEncoder().encode(unsigned)
  );

  const rawSig = derToRaw(new Uint8Array(sig));
  return `${unsigned}.${b64url(rawSig)}`;
}

function derToRaw(der) {
  // ECDSA signature: DER -> raw r||s (each 32 bytes)
  if (der[0] !== 0x30) return der; // already raw
  let offset = 2;
  if (der[1] & 0x80) offset += (der[1] & 0x7f);

  function readInt(pos) {
    if (der[pos] !== 0x02) throw new Error('bad DER');
    const len = der[pos + 1];
    let start = pos + 2;
    let bytes = der.slice(start, start + len);
    // Remove leading zero padding
    while (bytes.length > 32 && bytes[0] === 0) bytes = bytes.slice(1);
    // Pad to 32 bytes
    const padded = new Uint8Array(32);
    padded.set(bytes, 32 - bytes.length);
    return { value: padded, next: start + len };
  }

  const r = readInt(offset);
  const s = readInt(r.next);
  const raw = new Uint8Array(64);
  raw.set(r.value, 0);
  raw.set(s.value, 32);
  return raw;
}

// --- Web Push Encryption (RFC 8291 aes128gcm) ---
async function encryptPayload(subscription, payload) {
  const p256dh = b64urlDecode(subscription.keys.p256dh);
  const auth = b64urlDecode(subscription.keys.auth);

  // Import subscriber's public key
  const subPubKey = await crypto.subtle.importKey(
    'raw', p256dh, { name: 'ECDH', namedCurve: 'P-256' }, false, []
  );

  // Generate local ECDH key pair
  const localKeyPair = await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']
  );
  const localPubRaw = new Uint8Array(await crypto.subtle.exportKey('raw', localKeyPair.publicKey));

  // ECDH shared secret
  const sharedSecret = new Uint8Array(await crypto.subtle.deriveBits(
    { name: 'ECDH', public: subPubKey }, localKeyPair.privateKey, 256
  ));

  // HKDF to derive IKM from auth secret
  const authInfo = concatBytes(
    new TextEncoder().encode('WebPush: info\0'),
    p256dh,
    localPubRaw
  );
  const prk = await hkdfSha256(auth, sharedSecret, authInfo, 32);

  // Random salt
  const salt = crypto.getRandomValues(new Uint8Array(16));

  // Derive content encryption key and nonce
  const cekInfo = new TextEncoder().encode('Content-Encoding: aes128gcm\0');
  const nonceInfo = new TextEncoder().encode('Content-Encoding: nonce\0');
  const cek = await hkdfSha256(salt, prk, cekInfo, 16);
  const nonce = await hkdfSha256(salt, prk, nonceInfo, 12);

  // Pad plaintext (add delimiter byte 0x02)
  const plaintext = new TextEncoder().encode(payload);
  const padded = new Uint8Array(plaintext.length + 1);
  padded.set(plaintext);
  padded[plaintext.length] = 2; // padding delimiter

  // Encrypt with AES-128-GCM
  const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const encrypted = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonce }, key, padded
  ));

  // Build aes128gcm body: salt(16) + rs(4) + idlen(1) + keyid(65) + encrypted
  const recordSize = new Uint8Array(4);
  new DataView(recordSize.buffer).setUint32(0, padded.length + 16, false); // +16 for GCM tag
  const body = concatBytes(salt, recordSize, new Uint8Array([65]), localPubRaw, encrypted);

  return body;
}

async function hkdfSha256(salt, ikm, info, length) {
  // Extract: PRK = HMAC-SHA256(salt, IKM) — salt is the HMAC key
  const saltKey = await crypto.subtle.importKey(
    'raw', salt.length ? salt : new Uint8Array(32),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const prk = new Uint8Array(await crypto.subtle.sign('HMAC', saltKey, ikm));

  // Expand: T(1) = HMAC-SHA256(PRK, info || 0x01)
  const prkKey = await crypto.subtle.importKey('raw', prk, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const out = new Uint8Array(await crypto.subtle.sign('HMAC', prkKey, concatBytes(info, new Uint8Array([1]))));
  return out.slice(0, length);
}

function concatBytes(...arrays) {
  const len = arrays.reduce((a, b) => a + b.length, 0);
  const result = new Uint8Array(len);
  let offset = 0;
  for (const arr of arrays) { result.set(arr, offset); offset += arr.length; }
  return result;
}

// --- Send Push ---
async function sendPush(env, subscription, payload) {
  const body = await encryptPayload(subscription, JSON.stringify(payload));
  const jwt = await createVapidJwt(subscription.endpoint, env.VAPID_SUBJECT, env.VAPID_PRIVATE, env.VAPID_PUBLIC);

  const resp = await fetch(subscription.endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Encoding': 'aes128gcm',
      'TTL': '60',
      'Authorization': `vapid t=${jwt}, k=${env.VAPID_PUBLIC}`,
    },
    body,
  });

  return { status: resp.status, ok: resp.ok };
}

// --- Cron: check all subs and send pushes ---
async function cronCheck(env) {
  const now = new Date();
  const eastern = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const hour = eastern.getHours();
  if (hour < 8 || hour >= 21) return 0;
  const today = eastern.toISOString().slice(0, 10);
  const list = await env.SUBS.list();
  let sent = 0;

  // Once a day, on the 2:30pm ET cron tick, send a digest of everything due
  // within the next 7 days (including overdue).
  const minute = eastern.getMinutes();
  const digestTick = hour === 14 && minute >= 30 && minute < 45;
  const weekEnd = new Date(eastern);
  weekEnd.setDate(weekEnd.getDate() + 6);
  const weekEndISO = weekEnd.toISOString().slice(0, 10);

  // Intentionally re-sends for every due reminder each cron tick (every 15 min).
  // This is not an oversight — persistent nagging until the user marks them done.
  for (const key of list.keys) {
    const data = JSON.parse(await env.SUBS.get(key.name));
    if (!data?.subscription?.endpoint) continue;
    if (data.snoozeUntil && Date.now() < data.snoozeUntil) continue;

    if (digestTick) {
      const dueSoon = (data.reminders || [])
        .filter(r => !r.done && r.due && r.due <= weekEndISO)
        .sort((a, b) => a.due.localeCompare(b.due));
      if (dueSoon.length) {
        const names = dueSoon.slice(0, 4).map(r => r.title).join(', ');
        const extra = dueSoon.length > 4 ? ` +${dueSoon.length - 4} more` : '';
        const result = await sendPush(env, data.subscription, {
          title: 'Tasks This Week',
          body: `${dueSoon.length} due by ${weekEndISO}: ${names}${extra}`,
          tag: 'week-digest',
        });
        if (result.ok) sent++;
      }
    }

    const dueToday = (data.reminders || []).filter(r => !r.done && r.due === today);
    for (const r of dueToday) {
      const result = await sendPush(env, data.subscription, {
        title: 'Due Today',
        body: r.title,
        tag: 'today-' + r.id,
      });
      if (result.status === 410 || result.status === 404) {
        await env.SUBS.delete(key.name);
        break;
      }
      if (result.ok) sent++;
    }
  }
  return sent;
}

// --- Worker entry ---
export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS });
    }

    const url = new URL(request.url);

    if (url.pathname === '/subscribe' && request.method === 'POST') {
      const { subscription, reminders } = await request.json();
      if (!subscription?.endpoint) return json({ error: 'no subscription' }, 400);
      const id = b64url(new TextEncoder().encode(subscription.endpoint)).slice(0, 64);
      await env.SUBS.put(id, JSON.stringify({ subscription, reminders: reminders || [] }));
      return json({ ok: true, id });
    }

    if (url.pathname === '/sync' && request.method === 'POST') {
      const { subscription, reminders, snoozeUntil } = await request.json();
      if (!subscription?.endpoint) return json({ error: 'no subscription' }, 400);
      const id = b64url(new TextEncoder().encode(subscription.endpoint)).slice(0, 64);
      const existing = await env.SUBS.get(id);
      if (!existing) return json({ error: 'not subscribed' }, 404);
      const data = JSON.parse(existing);
      data.reminders = reminders || [];
      data.snoozeUntil = snoozeUntil || 0;
      await env.SUBS.put(id, JSON.stringify(data));
      return json({ ok: true });
    }

    if (url.pathname === '/unsubscribe' && request.method === 'POST') {
      const { subscription } = await request.json();
      if (!subscription?.endpoint) return json({ error: 'no subscription' }, 400);
      const id = b64url(new TextEncoder().encode(subscription.endpoint)).slice(0, 64);
      await env.SUBS.delete(id);
      return json({ ok: true });
    }

    if (url.pathname === '/test' && request.method === 'POST') {
      const { subscription } = await request.json();
      if (!subscription?.endpoint) return json({ error: 'no subscription' }, 400);
      const result = await sendPush(env, subscription, {
        title: 'Test Notification',
        body: 'Push notifications are working!',
        tag: 'test-' + Date.now(),
      });
      return json({ ok: result.ok, status: result.status });
    }

    if (url.pathname === '/check') {
      // Manual trigger for debugging only — requires the CHECK_KEY secret,
      // otherwise anyone could spam re-notifications (the URL is public in the repo)
      if (!env.CHECK_KEY || url.searchParams.get('key') !== env.CHECK_KEY) {
        return json({ error: 'not found' }, 404);
      }
      const sent = await cronCheck(env);
      return json({ ok: true, sent });
    }

    return json({ error: 'not found' }, 404);
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(cronCheck(env));
  },
};
