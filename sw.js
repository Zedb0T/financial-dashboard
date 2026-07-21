const CACHE_NAME = 'debt-free-v23';
const ASSETS = [
  '/financial-dashboard/',
  '/financial-dashboard/index.html',
  '/financial-dashboard/styles.css',
  '/financial-dashboard/app.js',
  '/financial-dashboard/manifest.json',
  '/financial-dashboard/icon-192.png',
  '/financial-dashboard/icon-512.png',
  // CORS mode (not opaque) so the cached copy can satisfy the SRI-tagged
  // script element when offline
  new Request('https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js', { mode: 'cors' })
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('push', e => {
  let data = { title: 'Reminder', body: 'You have a task due!' };
  try { if (e.data) data = e.data.json(); } catch (_) {}
  // Keep the icon badge (days until debt free) fresh even when the app
  // is closed — every push carries the current count.
  if (typeof data.badge === 'number' && 'setAppBadge' in navigator) {
    navigator.setAppBadge(data.badge).catch(() => {});
  }
  e.waitUntil(
    self.registration.showNotification(data.title || 'Reminder', {
      body: data.body || '',
      tag: data.tag || 'push-' + Date.now(),
      renotify: true,
      icon: '/financial-dashboard/icon-192.png',
    })
  );
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      for (const c of list) {
        if (c.url.includes('financial-dashboard') || c.url.includes('index.html')) {
          return c.focus();
        }
      }
      return clients.openWindow('./');
    })
  );
});

self.addEventListener('fetch', e => {
  e.respondWith(
    fetch(e.request)
      .then(res => {
        const clone = res.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(e.request, clone));
        return res;
      })
      .catch(() => caches.match(e.request))
  );
});
