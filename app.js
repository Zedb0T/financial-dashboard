// ============================================================================
// Financial Dashboard — single-file app
// ============================================================================

const STORAGE_KEY = 'fd:v1';
const PUSH_SERVER = 'https://debt-free-push.zedbotjak.workers.dev';
const VAPID_PUBLIC = 'BAE2OEYbupNmY3SdmdA8QKx3XFNDlAT8SOlOcvMejHDRI9HlL8yXosVRI8t8NepIEtMR7c4peGjTgU2heGot474';
const PALETTE = [
  '#6ee7a8', '#6ba9f0', '#f5c06a', '#ef6868',
  '#c78bf0', '#7ae0d5', '#f09a6b', '#8ae66e',
];

const FREQ_TO_MONTHLY = {
  weekly: 52 / 12,
  biweekly: 26 / 12,
  semimonthly: 2,
  monthly: 1,
};
const FREQ_LABELS = {
  weekly: 'Weekly',
  biweekly: 'Bi-weekly',
  semimonthly: 'Semi-monthly',
  monthly: 'Monthly',
};

const DEBT_TYPES = { card: 'Credit Card', loan: 'Loan / Fixed' };
const CARD_MIN_FLOOR = 25;

// Credit utilization tier thresholds. Returns 'good' | 'okay' | 'warn' | 'bad'.
// Standard advice: <10% excellent, <30% good, <50% warning, otherwise hurts score.
function utilizationTier(pct) {
  if (pct < 10) return 'good';
  if (pct < 30) return 'okay';
  if (pct < 50) return 'warn';
  return 'bad';
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
const defaultState = () => ({
  debts: [],
  incomes: [],
  expenses: [],
  bonuses: [],
  snapshots: [],
  reminders: [],
  settings: {
    strategy: 'avalanche',
    extra: 0,
    bankBalance: 0,
    emergencyFund: 6000,
    useEmergencyRule: false,
    scheduleLimit: 36,
  },
});

function migrate(s) {
  const base = defaultState();
  const out = { ...base, ...s };
  out.settings = { ...base.settings, ...(s.settings || {}) };
  // Migrate old `payments` (debt-tied) to new `bonuses` (bank inflow) for history continuity
  if (Array.isArray(s.payments) && !Array.isArray(s.bonuses)) {
    out.bonuses = s.payments.map((p) => ({
      id: p.id || uid(),
      amount: Number(p.amount) || 0,
      date: p.date || todayISO(),
      note: p.note || (p.debtName ? `Was payment to ${p.debtName}` : ''),
    }));
  }
  out.bonuses = out.bonuses || [];
  out.reminders = out.reminders || [];
  delete out.payments;
  out.incomes = (out.incomes || []).map((i) => ({
    frequency: 'monthly',
    ...i,
  }));
  // Default existing debts to credit-card type with derived minPct
  out.debts = (out.debts || []).map((d) => {
    const balance = Number(d.balance) || 0;
    const minimum = Number(d.minimum) || 0;
    const type = d.type || 'card';
    const minPct =
      d.minPct != null
        ? Number(d.minPct)
        : balance > 0 ? minimum / balance : 0;
    const creditLimit = d.creditLimit != null ? Number(d.creditLimit) : 0;
    const inCollections = !!d.inCollections;
    return { ...d, type, minPct, creditLimit, inCollections };
  });
  return out;
}

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultState();
    return migrate(JSON.parse(raw));
  } catch {
    return defaultState();
  }
}

function save() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

let state = loadState();
let charts = {};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const uid = () =>
  (crypto.randomUUID && crypto.randomUUID()) ||
  Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

const fmt = (n) =>
  (isNaN(n) ? 0 : n).toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 2,
  });

const fmt0 = (n) =>
  (isNaN(n) ? 0 : n).toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  });

const sum = (arr, k) => arr.reduce((a, b) => a + (Number(b[k]) || 0), 0);

function monthlyAmount(income) {
  return (Number(income.amount) || 0) * (FREQ_TO_MONTHLY[income.frequency] || 1);
}

function totalMonthlyIncome() {
  return state.incomes.reduce((a, i) => a + monthlyAmount(i), 0);
}

function dateInMonths(n) {
  const d = new Date();
  d.setMonth(d.getMonth() + n);
  return d.toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
}

function humanMonths(m) {
  if (m <= 0) return 'Already debt free';
  const y = Math.floor(m / 12);
  const r = m % 12;
  if (y === 0) return `${r} mo`;
  if (r === 0) return `${y} yr`;
  return `${y} yr ${r} mo`;
}

function todayISO() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}
function easternHour() {
  return Number(new Date().toLocaleString('en-US', { timeZone: 'America/New_York', hour: 'numeric', hour12: false }));
}

// Months from today until bank balance reaches `target`, treating the
// emergency fund as something you build AFTER becoming debt-free.
// While debts exist, the buffer kept during payoff doesn't count as savings.
// Returns 0 if already saved (no debts), null if unreachable.
function monthsToHitBankTarget(sim, target, netCashflow, currentBank) {
  const hasActiveDebt = sim && sim.months > 0 && !sim.stuck;
  if (sim && sim.stuck) return null;

  if (!hasActiveDebt) {
    // No debt to clear — bank grows directly from current value.
    if (currentBank >= target) return 0;
    if (netCashflow <= 0) return null;
    return Math.ceil((target - currentBank) / netCashflow);
  }

  // Debt exists: savings timer starts at debt-free month with whatever bank
  // is left after the final debt payment.
  const bankAtDebtFree = sim.finalBank;
  if (bankAtDebtFree >= target) return sim.months;
  if (netCashflow <= 0) return null;
  const moreMonths = Math.ceil((target - bankAtDebtFree) / netCashflow);
  return sim.months + Math.max(1, moreMonths);
}

// Effective monthly minimum given current balance.
// Cards scale: max(floor, balance * pct), capped at balance.
// Loans: fixed value.
function effectiveMin(d) {
  const balance = Number(d.balance) || 0;
  if ((d.type || 'card') === 'loan') {
    return Math.min(balance, Number(d.minimum) || 0);
  }
  if (balance <= 0) return 0;
  const pct = Number(d.minPct) || 0;
  if (pct <= 0) return 0;
  return Math.min(balance, Math.max(CARD_MIN_FLOOR, balance * pct));
}

function toast(msg, kind = 'success') {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = `toast show ${kind}`;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (el.className = 'toast'), 2200);
}

// ---------------------------------------------------------------------------
// Payoff Simulation (with optional emergency-fund rule)
// ---------------------------------------------------------------------------
function simulatePayoff(opts) {
  const {
    debts,
    strategy = 'avalanche',
    extra = 0,
    monthlyIncome = 0,
    monthlyExpenses = 0,
    bankStart = 0,
    threshold = 6000,
    useRule = false,
    holdZeroPct = false,
  } = opts;

  const empty = {
    months: 0,
    totalInterest: 0,
    totalPaid: 0,
    history: [],
    order: [],
    schedule: [],
    stuck: false,
    finalBank: bankStart,
  };
  if (!debts.length) return empty;

  const sim = debts.map((d) => ({
    id: d.id,
    name: d.name,
    balance: Number(d.balance) || 0,
    apr: Number(d.apr) || 0,
    minimum: Number(d.minimum) || 0,
    type: d.type || 'card',
    minPct: Number(d.minPct) || 0,
    creditLimit: Number(d.creditLimit) || 0,
    inCollections: !!d.inCollections,
    paidOffMonth: null,
    originalBalance: Number(d.balance) || 0,
  }));

  let bank = Number(bankStart) || 0;
  const netCashflow = monthlyIncome - monthlyExpenses;
  let totalInterest = 0;
  let totalPaid = 0;
  const history = [
    { month: 0, total: sum(sim, 'balance'), bank },
  ];
  const schedule = [];

  const MAX_MONTHS = 1200;
  let month = 0;

  const sortByStrategy = (list) => {
    if (strategy === 'snowball')
      return [...list].sort((a, b) => a.balance - b.balance);
    if (strategy === 'credit-score')
      return [...list].sort((a, b) => {
        // Collections first
        if (a.inCollections !== b.inCollections) return a.inCollections ? -1 : 1;
        // Among non-collections cards, highest utilization first
        const utilA = a.creditLimit > 0 ? a.balance / a.creditLimit : 0;
        const utilB = b.creditLimit > 0 ? b.balance / b.creditLimit : 0;
        if (utilA !== utilB) return utilB - utilA;
        // Tie-break: highest APR
        return b.apr - a.apr;
      });
    if (strategy === 'cashflow')
      return [...list].sort((a, b) => {
        // Lowest balance-to-minimum ratio first — fewest months to
        // eliminate that minimum payment from the budget
        const minA = effectiveMin(a);
        const minB = effectiveMin(b);
        const ratioA = minA > 0 ? a.balance / minA : Infinity;
        const ratioB = minB > 0 ? b.balance / minB : Infinity;
        if (ratioA !== ratioB) return ratioA - ratioB;
        // Tie-break: higher minimum freed first
        return minB - minA;
      });
    return [...list].sort((a, b) => b.apr - a.apr);
  };

  while (sim.some((d) => d.balance > 0.005) && month < MAX_MONTHS) {
    month++;
    const perDebt = {};
    for (const d of sim) {
      perDebt[d.id] = { name: d.name, payment: 0, remaining: 0 };
    }

    // 1) compute this month's effective minimum BEFORE interest accrues,
    //    so card mins reflect the balance the user can see on the statement.
    const monthMin = new Map();
    for (const d of sim) {
      monthMin.set(d.id, effectiveMin(d));
    }

    // 2) apply monthly interest
    for (const d of sim) {
      if (d.balance <= 0) continue;
      const interest = d.balance * (d.apr / 100 / 12);
      d.balance += interest;
      totalInterest += interest;
    }

    // 3) bank receives net cashflow
    bank += netCashflow;

    // 4) pay minimums (priority order, capped by balance)
    let minimumsPaid = 0;
    const activeAtStart = sim.filter((d) => d.balance > 0.005);
    const sorted = sortByStrategy(activeAtStart);
    for (const d of sorted) {
      if (d.balance <= 0.005) continue;
      const min = monthMin.get(d.id) || 0;
      const pay = Math.min(min, d.balance);
      d.balance -= pay;
      bank -= pay;
      totalPaid += pay;
      minimumsPaid += pay;
      perDebt[d.id].payment += pay;
    }

    // 5) extra payments
    let extraBudget;
    if (useRule) {
      // Pay extra only if bank above threshold
      extraBudget = Math.max(0, bank - threshold);
    } else {
      // Fixed extra (capped at available bank if bank is tracked, else just extra)
      extraBudget = Math.max(0, Number(extra) || 0);
    }

    const activeAfterMins = sortByStrategy(
      sim.filter((d) => d.balance > 0.005)
    );
    const targetId = activeAfterMins.length > 0 ? activeAfterMins[0].id : null;
    const holdTarget = holdZeroPct && activeAfterMins.length > 0
      && activeAfterMins[0].apr === 0;

    if (holdTarget) {
      const d = activeAfterMins[0];
      if (bank - d.balance >= threshold) {
        const pay = d.balance;
        d.balance = 0;
        bank -= pay;
        totalPaid += pay;
        perDebt[d.id].payment += pay;
        extraBudget = Math.max(0, extraBudget - pay);
      }
    }

    {
      const remaining = sortByStrategy(
        sim.filter((d) => d.balance > 0.005)
      );
      let surplus = useRule ? Math.max(0, bank - threshold) : extraBudget;
      for (const d of remaining) {
        if (surplus <= 0.005) break;
        const pay = Math.min(surplus, d.balance);
        d.balance -= pay;
        bank -= pay;
        surplus -= pay;
        totalPaid += pay;
        perDebt[d.id].payment += pay;
      }
    }

    // 6) record per-debt remaining + payoff month
    for (const d of sim) {
      if (d.balance <= 0.005 && d.paidOffMonth == null) {
        d.paidOffMonth = month;
        d.balance = 0;
      }
      perDebt[d.id].remaining = Math.max(0, d.balance);
    }

    const totalRemaining = sim.reduce((a, d) => a + Math.max(0, d.balance), 0);
    history.push({ month, total: totalRemaining, bank });
    schedule.push({
      month,
      bank,
      perDebt,
      minimumsPaid,
      targetId,
      totalPaidThisMonth: Object.values(perDebt).reduce((a, x) => a + x.payment, 0),
      totalRemaining,
    });

    // 7) stuck check — debt not dropping AND bank not climbing
    if (month > 3) {
      const a = history[history.length - 1];
      const b = history[history.length - 4];
      const debtDown = a.total < b.total - 0.5;
      const bankUp = a.bank > b.bank + 0.5;
      if (!debtDown && !bankUp) break;
    }
  }

  const order = sim
    .slice()
    .sort((a, b) => (a.paidOffMonth || 9999) - (b.paidOffMonth || 9999));

  return {
    months: month,
    totalInterest,
    totalPaid,
    history,
    order,
    schedule,
    finalBank: bank,
    stuck: sim.some((d) => d.balance > 0.005),
  };
}

// ---------------------------------------------------------------------------
// Computed aggregates
// ---------------------------------------------------------------------------
function aggregates() {
  const totalDebt = sum(state.debts, 'balance');
  const totalIncome = totalMonthlyIncome();
  const totalExpenses = sum(state.expenses, 'amount');
  const totalMins = state.debts.reduce((a, d) => a + effectiveMin(d), 0);
  const totalMonthly = totalExpenses + totalMins;
  const available = totalIncome - totalMonthly;
  const extra = Number(state.settings.extra) || 0;

  const monthlyInterest = state.debts.reduce(
    (a, d) => a + ((Number(d.balance) || 0) * (Number(d.apr) || 0)) / 100 / 12,
    0
  );

  return {
    totalDebt,
    totalIncome,
    totalExpenses,
    totalMins,
    totalMonthly,
    available,
    extra,
    monthlyInterest,
    bankBalance: Number(state.settings.bankBalance) || 0,
    emergencyFund: Number(state.settings.emergencyFund) || 0,
    useRule: !!state.settings.useEmergencyRule,
  };
}

function simOpts() {
  const a = aggregates();
  return {
    debts: state.debts,
    strategy: state.settings.strategy,
    extra: a.extra,
    monthlyIncome: a.totalIncome,
    monthlyExpenses: a.totalExpenses,
    bankStart: a.bankBalance,
    threshold: a.emergencyFund,
    useRule: a.useRule,
    holdZeroPct: !!state.settings.holdZeroPct,
  };
}

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------
function initTabs() {
  document.querySelectorAll('.nav-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const tab = btn.dataset.tab;
      document.querySelectorAll('.nav-btn').forEach((b) => b.classList.remove('active'));
      document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById(`tab-${tab}`).classList.add('active');
      renderAll();
    });
  });
}

// ---------------------------------------------------------------------------
// Forms
// ---------------------------------------------------------------------------
function initForms() {
  document.getElementById('form-debt').addEventListener('submit', (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const balance = parseFloat(fd.get('balance')) || 0;
    const minimum = parseFloat(fd.get('minimum')) || 0;
    const type = fd.get('type') || 'card';
    const minPct = type === 'card' && balance > 0 ? minimum / balance : 0;
    const creditLimit = parseFloat(fd.get('creditLimit')) || 0;
    state.debts.push({
      id: uid(),
      name: fd.get('name').trim(),
      balance,
      apr: parseFloat(fd.get('apr')) || 0,
      minimum,
      type,
      minPct,
      creditLimit,
      inCollections: !!fd.get('inCollections'),
    });
    save();
    e.target.reset();
    renderAll();
    toast('Debt added');
  });

  document.getElementById('form-income').addEventListener('submit', (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    state.incomes.push({
      id: uid(),
      name: fd.get('name').trim(),
      amount: parseFloat(fd.get('amount')),
      category: fd.get('category'),
      frequency: fd.get('frequency') || 'monthly',
    });
    save();
    e.target.reset();
    renderAll();
    toast('Income added');
  });

  document.getElementById('form-expense').addEventListener('submit', (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    state.expenses.push({
      id: uid(),
      name: fd.get('name').trim(),
      amount: parseFloat(fd.get('amount')),
      category: fd.get('category'),
    });
    save();
    e.target.reset();
    renderAll();
    toast('Expense added');
  });

  // One-time bonus form (adds to bank balance)
  document.getElementById('form-bonus').addEventListener('submit', (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const amount = parseFloat(fd.get('amount'));
    if (!(amount > 0)) {
      toast('Enter a positive amount', 'error');
      return;
    }
    state.settings.bankBalance =
      (Number(state.settings.bankBalance) || 0) + amount;
    state.bonuses.push({
      id: uid(),
      amount,
      date: fd.get('date') || todayISO(),
      note: (fd.get('note') || '').trim(),
    });
    save();
    e.target.reset();
    renderAll();
    toast(`Added ${fmt(amount)} to bank`);
  });

  // Strategy radios
  document.querySelectorAll('input[name="strategy"]').forEach((r) => {
    r.addEventListener('change', () => {
      state.settings.strategy = r.value;
      save();
      renderAll();
    });
  });

  // Extra payment
  const extraEl = document.getElementById('extra-payment');
  extraEl.addEventListener('input', () => {
    state.settings.extra = parseFloat(extraEl.value) || 0;
    save();
    renderAll();
  });

  // Bank balance
  const bankEl = document.getElementById('bank-balance');
  bankEl.addEventListener('input', () => {
    state.settings.bankBalance = parseFloat(bankEl.value) || 0;
    save();
    renderAll();
  });

  // Emergency fund threshold
  const efEl = document.getElementById('emergency-fund');
  efEl.addEventListener('input', () => {
    state.settings.emergencyFund = parseFloat(efEl.value) || 0;
    save();
    renderAll();
  });

  // Efficiency apply-amount
  document.getElementById('eff-amount').addEventListener('input', () => {
    renderEfficiency();
  });

  // Use rule toggle
  const useRuleEl = document.getElementById('use-rule');
  useRuleEl.addEventListener('change', () => {
    state.settings.useEmergencyRule = useRuleEl.checked;
    save();
    renderAll();
  });

  // Hold 0% toggle
  const holdZeroEl = document.getElementById('hold-zero-pct');
  holdZeroEl.addEventListener('change', () => {
    state.settings.holdZeroPct = holdZeroEl.checked;
    save();
    renderAll();
  });

  // Schedule limit
  const schedLimitEl = document.getElementById('schedule-limit');
  schedLimitEl.addEventListener('change', () => {
    state.settings.scheduleLimit = parseInt(schedLimitEl.value, 10) || 36;
    save();
    renderPlan();
  });

  // Snapshot
  document.getElementById('btn-snapshot').addEventListener('click', () => {
    const total = sum(state.debts, 'balance');
    const breakdown = state.debts.map((d) => ({
      name: d.name,
      balance: Number(d.balance) || 0,
    }));
    state.snapshots.push({
      id: uid(),
      date: new Date().toISOString(),
      total,
      breakdown,
    });
    save();
    renderAll();
    toast('Snapshot saved');
  });

  // Settings
  document.getElementById('btn-export').addEventListener('click', () => {
    const blob = new Blob([JSON.stringify(state, null, 2)], {
      type: 'application/json',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `financial-dashboard-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
    toast('Exported');
  });

  document.getElementById('btn-standalone').addEventListener('click', () => {
    toast('Run build-standalone.ps1 in the project folder to generate standalone.html', 'success');
  });

  const fileInput = document.getElementById('file-import');
  document.getElementById('btn-import').addEventListener('click', () =>
    fileInput.click()
  );
  fileInput.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const text = await file.text();
      const parsed = JSON.parse(text);
      state = migrate(parsed);
      save();
      renderAll();
      toast('Imported');
    } catch {
      toast('Import failed — bad JSON', 'error');
    }
    e.target.value = '';
  });

  document.getElementById('btn-reset').addEventListener('click', () => {
    if (!confirm('Delete all your data? This cannot be undone.')) return;
    state = defaultState();
    save();
    renderAll();
    toast('Reset complete');
  });

  document.getElementById('btn-sample').addEventListener('click', () => {
    state = sampleState();
    save();
    renderAll();
    toast('Sample data loaded');
  });
}

function sampleState() {
  const d1 = uid();
  const d2 = uid();
  const d3 = uid();
  const d4 = uid();
  return migrate({
    debts: [
      { id: d1, name: 'Chase Credit Card', balance: 4200, apr: 22.99, minimum: 120, type: 'card', creditLimit: 6000 },
      { id: d2, name: 'Student Loan', balance: 18500, apr: 5.8, minimum: 210, type: 'loan' },
      { id: d3, name: 'Car Loan', balance: 9800, apr: 6.5, minimum: 275, type: 'loan' },
      { id: d4, name: 'Medical Debt', balance: 1200, apr: 0, minimum: 50, type: 'loan' },
    ],
    incomes: [
      { id: uid(), name: 'Main Job', amount: 1200, category: 'Salary', frequency: 'weekly' },
      { id: uid(), name: 'Freelance Gig', amount: 600, category: 'Side Hustle', frequency: 'monthly' },
    ],
    expenses: [
      { id: uid(), name: 'Rent', amount: 1350, category: 'Housing' },
      { id: uid(), name: 'Groceries', amount: 450, category: 'Food' },
      { id: uid(), name: 'Car Insurance', amount: 130, category: 'Insurance' },
      { id: uid(), name: 'Gas', amount: 180, category: 'Transport' },
      { id: uid(), name: 'Internet', amount: 65, category: 'Utilities' },
      { id: uid(), name: 'Streaming', amount: 45, category: 'Subscriptions' },
      { id: uid(), name: 'Phone', amount: 55, category: 'Utilities' },
      { id: uid(), name: 'Dining Out', amount: 160, category: 'Food' },
    ],
    bonuses: [
      {
        id: uid(),
        amount: 500,
        date: todayISO(),
        note: 'Tax refund',
      },
    ],
    snapshots: [],
    settings: {
      strategy: 'snowball',
      extra: 0,
      bankBalance: 2500,
      emergencyFund: 6000,
      useEmergencyRule: true,
      scheduleLimit: 36,
    },
  });
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------
function renderAll() {
  renderOverview();
  renderDebts();
  renderIncome();
  renderExpenses();
  renderEfficiency();
  renderReminders();
  renderPlan();
  renderProgress();
}

// ---- Overview ------------------------------------------------------------
function renderOverview() {
  const a = aggregates();
  document.getElementById('stat-debt').textContent = fmt0(a.totalDebt);
  document.getElementById('stat-debt-sub').textContent =
    `${state.debts.length} account${state.debts.length === 1 ? '' : 's'}`;
  document.getElementById('stat-bank').textContent = fmt0(a.bankBalance);
  document.getElementById('stat-bank-sub').textContent =
    a.useRule
      ? a.bankBalance >= a.emergencyFund
        ? `${fmt0(a.bankBalance - a.emergencyFund)} above threshold`
        : `${fmt0(a.emergencyFund - a.bankBalance)} to threshold`
      : 'Emergency rule off';
  document.getElementById('stat-income').textContent = fmt0(a.totalIncome);
  document.getElementById('stat-income-sub').textContent =
    `${state.incomes.length} source${state.incomes.length === 1 ? '' : 's'}`;
  document.getElementById('stat-expenses').textContent = fmt0(a.totalMonthly);
  const debtsWithMin = state.debts.filter(d => effectiveMin(d) > 0).length;
  const parts = [`${state.expenses.length} expense${state.expenses.length === 1 ? '' : 's'}`];
  if (debtsWithMin > 0) parts.push(`${debtsWithMin} min pmt${debtsWithMin === 1 ? '' : 's'}`);
  document.getElementById('stat-expenses-sub').textContent = parts.join(' + ');
  document.getElementById('stat-available').textContent = fmt0(a.available);
  const avEl = document.getElementById('stat-available');
  avEl.classList.toggle('pos', a.available > 0);
  avEl.classList.toggle('neg', a.available < 0);

  // Bank account card inputs
  const bankEl = document.getElementById('bank-balance');
  if (document.activeElement !== bankEl) bankEl.value = a.bankBalance || '';
  const efEl = document.getElementById('emergency-fund');
  if (document.activeElement !== efEl) efEl.value = a.emergencyFund || '';
  document.getElementById('use-rule').checked = a.useRule;

  // Buffer status
  const buffer = a.bankBalance - a.emergencyFund;
  const bufVal = document.getElementById('bank-buffer-value');
  const bufSub = document.getElementById('bank-buffer-sub');
  if (buffer >= 0) {
    bufVal.textContent = `+${fmt0(buffer)}`;
    bufVal.className = 'stat-value pos';
    bufSub.textContent = a.useRule
      ? 'Excess flows to debt at month-end'
      : 'Buffer healthy';
  } else {
    bufVal.textContent = fmt0(buffer);
    bufVal.className = 'stat-value neg';
    bufSub.textContent = a.useRule
      ? 'Building up — only minimums apply'
      : `${fmt0(-buffer)} below threshold`;
  }

  // Countdown
  const sim = simulatePayoff(simOpts());
  if (!state.debts.length) {
    document.getElementById('countdown-date').textContent = '—';
    document.getElementById('countdown-sub').textContent =
      'Add debts & a budget to see your free date.';
  } else if (sim.stuck) {
    document.getElementById('countdown-date').textContent = 'Stuck';
    document.getElementById('countdown-sub').textContent =
      a.useRule
        ? 'Net cashflow not covering minimums. Reduce expenses or raise income.'
        : 'Interest outpaces payments. Add extra or reduce expenses.';
  } else {
    document.getElementById('countdown-date').textContent = dateInMonths(sim.months);
    document.getElementById('countdown-sub').textContent =
      `${humanMonths(sim.months)} from today`;
  }

  // Progress bar: paid vs. original (from earliest snapshot if any, else current = 0 paid)
  const earliest = state.snapshots[0];
  const original = earliest ? earliest.total : a.totalDebt;
  const paid = Math.max(0, original - a.totalDebt);
  const pct = original > 0 ? Math.min(100, (paid / original) * 100) : 0;
  document.getElementById('overview-progress').style.width = `${pct}%`;
  document.getElementById('overview-paid').textContent = `${fmt0(paid)} paid`;
  document.getElementById('overview-total').textContent = `of ${fmt0(original)} original`;

  // Charts
  renderBreakdownChart();
  renderProjectionChart(sim);

  renderBonuses();
}

function renderBreakdownChart() {
  const ctx = document.getElementById('chart-breakdown');
  if (!ctx) return;
  if (charts.breakdown) charts.breakdown.destroy();

  if (!state.debts.length) {
    charts.breakdown = new Chart(ctx, {
      type: 'doughnut',
      data: {
        labels: ['No debts'],
        datasets: [{ data: [1], backgroundColor: ['#2a3240'], borderWidth: 0 }],
      },
      options: chartOpts({ cutout: '65%', legend: true }),
    });
    return;
  }

  charts.breakdown = new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels: state.debts.map((d) => d.name),
      datasets: [
        {
          data: state.debts.map((d) => Number(d.balance) || 0),
          backgroundColor: state.debts.map((_, i) => PALETTE[i % PALETTE.length]),
          borderColor: '#171d26',
          borderWidth: 2,
        },
      ],
    },
    options: chartOpts({ cutout: '65%', legend: true, money: true }),
  });
}

function renderProjectionChart(sim) {
  const ctx = document.getElementById('chart-projection');
  if (!ctx) return;
  if (charts.projection) charts.projection.destroy();

  const labels = sim.history.map((p) => p.month);
  const debtData = sim.history.map((p) => p.total);
  const bankData = sim.history.map((p) => p.bank);

  charts.projection = new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [
        {
          label: 'Total Debt',
          data: debtData,
          borderColor: '#ef6868',
          backgroundColor: 'rgba(239, 104, 104, 0.12)',
          fill: true,
          tension: 0.25,
          pointRadius: 0,
          borderWidth: 2,
        },
        {
          label: 'Bank Balance',
          data: bankData,
          borderColor: '#6ee7a8',
          backgroundColor: 'rgba(110, 231, 168, 0.08)',
          fill: false,
          tension: 0.25,
          pointRadius: 0,
          borderWidth: 2,
          borderDash: [4, 4],
        },
      ],
    },
    options: chartOpts({
      legend: true,
      money: true,
      xTitle: 'Months from today',
    }),
  });
}

// ---- Debts ---------------------------------------------------------------
function utilizationCellHtml(d) {
  const type = d.type || 'card';
  if (type !== 'card') {
    return `<span class="util-text muted">—</span>`;
  }
  const balance = Number(d.balance) || 0;
  const limit = Number(d.creditLimit) || 0;
  if (limit <= 0) {
    return `<span class="util-text muted">set limit</span>`;
  }
  const pct = (balance / limit) * 100;
  const tier = utilizationTier(pct);
  const barWidth = Math.min(100, pct);
  return `
    <div class="util-row">
      <div class="util-bar-shell">
        <div class="util-bar ${tier}" style="width:${barWidth.toFixed(1)}%"></div>
      </div>
      <div class="util-text ${tier}">${pct.toFixed(1)}%</div>
    </div>
  `;
}

function renderDebts() {
  const tbody = document.querySelector('#table-debts tbody');
  tbody.innerHTML = '';

  const costPerDay = (d) => (Number(d.balance) || 0) * (Number(d.apr) || 0) / 100 / 365;
  const sortedDebts = [...state.debts].sort((a, b) => costPerDay(b) - costPerDay(a));

  if (!sortedDebts.length) {
    tbody.innerHTML = `<tr class="empty-row"><td colspan="11">No debts yet — add one above.</td></tr>`;
  } else {
    sortedDebts.forEach((d) => {
      const balance = Number(d.balance) || 0;
      const dailyCost = costPerDay(d);
      const monthlyInt = (balance * (Number(d.apr) || 0)) / 100 / 12;
      const type = d.type || 'card';
      const effMin = effectiveMin(d);
      const pctNote =
        type === 'card' && balance > 0
          ? `<div class="cell-sub">${((Number(d.minPct) || 0) * 100).toFixed(2)}% of balance</div>`
          : '';
      const minVal = type === 'card' ? effMin.toFixed(2) : (d.minimum ?? 0);
      const limit = Number(d.creditLimit) || 0;
      const limitCell =
        type === 'card'
          ? `<input data-id="${d.id}" data-field="creditLimit" type="number" step="0.01" min="0" value="${limit || ''}" placeholder="set limit" />`
          : `<span class="cell-na">—</span>`;
      const utilCell = utilizationCellHtml(d);
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td class="cell-edit"><input data-id="${d.id}" data-field="name" value="${escape(d.name)}" /></td>
        <td class="cell-edit"><input data-id="${d.id}" data-field="balance" type="number" step="0.01" min="0" value="${balance}" /></td>
        <td class="cell-edit">${limitCell}</td>
        <td class="util-cell">${utilCell}</td>
        <td class="cell-edit"><input data-id="${d.id}" data-field="apr" type="number" step="0.01" min="0" value="${d.apr}" /></td>
        <td class="cell-edit">
          <select data-id="${d.id}" data-field="type">
            ${Object.entries(DEBT_TYPES)
              .map(([v, lbl]) => `<option value="${v}" ${v === type ? 'selected' : ''}>${lbl}</option>`)
              .join('')}
          </select>
        </td>
        <td class="cell-edit cell-center"><input data-id="${d.id}" data-field="inCollections" type="checkbox" ${d.inCollections ? 'checked' : ''} /></td>
        <td class="cell-edit">
          <input data-id="${d.id}" data-field="minimum" type="number" step="0.01" min="0" value="${minVal}" />
          ${pctNote}
        </td>
        <td>${fmt(monthlyInt)}</td>
        <td class="${dailyCost > 0 ? 'neg' : ''}">${fmt(dailyCost)}</td>
        <td><button class="btn ghost" data-del="${d.id}">Delete</button></td>
      `;
      tbody.appendChild(tr);
    });
  }

  document.getElementById('debts-total').textContent = fmt(sum(state.debts, 'balance'));
  document.getElementById('debts-min-total').textContent = fmt(
    state.debts.reduce((a, d) => a + effectiveMin(d), 0)
  );
  const monthlyInt = state.debts.reduce(
    (a, d) => a + ((Number(d.balance) || 0) * (Number(d.apr) || 0)) / 100 / 12,
    0
  );
  document.getElementById('debts-interest-total').textContent = fmt(monthlyInt);
  const dailyTotal = state.debts.reduce(
    (a, d) => a + (Number(d.balance) || 0) * (Number(d.apr) || 0) / 100 / 365,
    0
  );
  document.getElementById('debts-daily-total').textContent = fmt(dailyTotal);

  // Footer totals for credit cards
  const cardDebts = state.debts.filter((d) => (d.type || 'card') === 'card');
  const totalLimit = cardDebts.reduce(
    (a, d) => a + (Number(d.creditLimit) || 0),
    0
  );
  const totalCardBalance = cardDebts.reduce(
    (a, d) => a + (Number(d.balance) || 0),
    0
  );
  document.getElementById('debts-limit-total').textContent =
    totalLimit > 0 ? fmt(totalLimit) : '—';
  const utilEl = document.getElementById('debts-util-total');
  if (totalLimit > 0) {
    const overallPct = (totalCardBalance / totalLimit) * 100;
    const tier = utilizationTier(overallPct);
    utilEl.innerHTML = `<span class="util-text ${tier}">${overallPct.toFixed(1)}%</span>`;
  } else {
    utilEl.textContent = '—';
  }

  // Handle both <input> and <select> edits
  tbody.querySelectorAll('[data-field]').forEach((el) => {
    el.addEventListener('change', () => {
      const d = state.debts.find((x) => x.id === el.dataset.id);
      if (!d) return;
      const f = el.dataset.field;
      if (f === 'name') {
        d.name = el.value.trim();
      } else if (f === 'type') {
        d.type = el.value;
        // Switching to card: derive minPct from current min/balance
        if (d.type === 'card') {
          const bal = Number(d.balance) || 0;
          d.minPct = bal > 0 ? (Number(d.minimum) || 0) / bal : 0;
        }
      } else if (f === 'minimum') {
        d.minimum = parseFloat(el.value) || 0;
        // Recompute minPct so the new minimum is treated as the policy
        if ((d.type || 'card') === 'card') {
          const bal = Number(d.balance) || 0;
          d.minPct = bal > 0 ? d.minimum / bal : 0;
        }
      } else if (f === 'inCollections') {
        d.inCollections = el.checked;
      } else if (f === 'balance') {
        d.balance = parseFloat(el.value) || 0;
        if ((d.type || 'card') === 'card') {
          d.minimum = effectiveMin(d);
        }
      } else {
        d[f] = parseFloat(el.value) || 0;
      }
      save();
      renderAll();
    });
  });
  tbody.querySelectorAll('button[data-del]').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.debts = state.debts.filter((d) => d.id !== btn.dataset.del);
      save();
      renderAll();
      toast('Debt removed');
    });
  });
}

function renderBonuses() {
  const dateInp = document.querySelector('#form-bonus input[name="date"]');
  if (dateInp && !dateInp.value) dateInp.value = todayISO();

  const tbody = document.querySelector('#table-bonuses tbody');
  if (!tbody) return;
  tbody.innerHTML = '';
  if (!state.bonuses.length) {
    tbody.innerHTML = `<tr class="empty-row"><td colspan="4">No bonuses yet — add a windfall above.</td></tr>`;
    document.getElementById('bonuses-total').textContent = fmt(0);
    return;
  }
  const sorted = state.bonuses.slice().sort((a, b) => b.date.localeCompare(a.date));
  sorted.forEach((p) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${p.date}</td>
      <td>${fmt(p.amount)}</td>
      <td>${escape(p.note || '')}</td>
      <td><button class="btn ghost" data-del-bonus="${p.id}">Delete</button></td>
    `;
    tbody.appendChild(tr);
  });
  document.getElementById('bonuses-total').textContent = fmt(sum(state.bonuses, 'amount'));

  tbody.querySelectorAll('button[data-del-bonus]').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.bonuses = state.bonuses.filter((p) => p.id !== btn.dataset.delBonus);
      save();
      renderAll();
      toast('Bonus removed');
    });
  });
}

// ---- Income --------------------------------------------------------------
function renderIncome() {
  const tbody = document.querySelector('#table-income tbody');
  tbody.innerHTML = '';
  if (!state.incomes.length) {
    tbody.innerHTML = `<tr class="empty-row"><td colspan="7">No income yet — add a job above.</td></tr>`;
  } else {
    state.incomes.forEach((i) => {
      const tr = document.createElement('tr');
      const freq = i.frequency || 'monthly';
      const daily = monthlyAmount(i) / 30.44;
      tr.innerHTML = `
        <td class="cell-edit"><input data-kind="inc" data-id="${i.id}" data-field="name" value="${escape(i.name)}" /></td>
        <td class="cell-edit">
          <select data-kind="inc" data-id="${i.id}" data-field="category">
            ${['Salary','Side Hustle','Investment','Gift','Other']
              .map((o) => `<option ${o === i.category ? 'selected' : ''}>${o}</option>`).join('')}
          </select>
        </td>
        <td class="cell-edit"><input data-kind="inc" data-id="${i.id}" data-field="amount" type="number" step="0.01" min="0" value="${i.amount}" /></td>
        <td class="cell-edit">
          <select data-kind="inc" data-id="${i.id}" data-field="frequency">
            ${Object.entries(FREQ_LABELS)
              .map(([v, lbl]) => `<option value="${v}" ${v === freq ? 'selected' : ''}>${lbl}</option>`).join('')}
          </select>
        </td>
        <td>${fmt(monthlyAmount(i))}</td>
        <td class="pos">${fmt(daily)}</td>
        <td><button class="btn ghost" data-del-inc="${i.id}">Delete</button></td>
      `;
      tbody.appendChild(tr);
    });
  }
  const totalMonthly = totalMonthlyIncome();
  document.getElementById('income-total').textContent = fmt(totalMonthly);
  document.getElementById('income-daily-total').textContent = fmt(totalMonthly / 30.44);

  tbody.querySelectorAll('[data-kind="inc"]').forEach((el) => {
    el.addEventListener('change', () => {
      const i = state.incomes.find((x) => x.id === el.dataset.id);
      if (!i) return;
      const f = el.dataset.field;
      if (f === 'amount') i.amount = parseFloat(el.value) || 0;
      else i[f] = el.value.trim ? el.value.trim() : el.value;
      save();
      renderAll();
    });
  });
  tbody.querySelectorAll('button[data-del-inc]').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.incomes = state.incomes.filter((i) => i.id !== btn.dataset.delInc);
      save();
      renderAll();
      toast('Income removed');
    });
  });
}

// ---- Expenses ------------------------------------------------------------
function renderExpenses() {
  const tbody = document.querySelector('#table-expenses tbody');
  tbody.innerHTML = '';
  const sortedExpenses = [...state.expenses].sort(
    (a, b) => (Number(b.amount) || 0) - (Number(a.amount) || 0)
  );
  if (!sortedExpenses.length) {
    tbody.innerHTML = `<tr class="empty-row"><td colspan="5">No expenses yet — add one above.</td></tr>`;
  } else {
    sortedExpenses.forEach((x) => {
      const daily = (Number(x.amount) || 0) / 30.44;
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td class="cell-edit"><input data-kind="exp" data-id="${x.id}" data-field="name" value="${escape(x.name)}" /></td>
        <td class="cell-edit">
          <select data-kind="exp" data-id="${x.id}" data-field="category">
            ${['Housing','Food','Transport','Utilities','Insurance','Subscriptions','Personal','Other']
              .map((o) => `<option ${o === x.category ? 'selected' : ''}>${o}</option>`).join('')}
          </select>
        </td>
        <td class="cell-edit"><input data-kind="exp" data-id="${x.id}" data-field="amount" type="number" step="0.01" min="0" value="${x.amount}" /></td>
        <td>${fmt(daily)}</td>
        <td><button class="btn ghost" data-del-exp="${x.id}">Delete</button></td>
      `;
      tbody.appendChild(tr);
    });
  }
  const expTotal = sum(state.expenses, 'amount');
  document.getElementById('expenses-total').textContent = fmt(expTotal);
  document.getElementById('expenses-daily-total').textContent = fmt(expTotal / 30.44);

  // Debt minimums row in footer
  const debtMinsMonthly = state.debts.reduce((a, d) => a + effectiveMin(d), 0);
  document.getElementById('expenses-mins-monthly').textContent = fmt(debtMinsMonthly);
  document.getElementById('expenses-mins-daily').textContent = fmt(debtMinsMonthly / 30.44);

  // Debt interest row in footer
  const debtDailyTotal = state.debts.reduce(
    (a, d) => a + (Number(d.balance) || 0) * (Number(d.apr) || 0) / 100 / 365, 0
  );
  const debtMonthlyTotal = state.debts.reduce(
    (a, d) => a + (Number(d.balance) || 0) * (Number(d.apr) || 0) / 100 / 12, 0
  );
  document.getElementById('expenses-debt-monthly').textContent = fmt(debtMonthlyTotal);
  document.getElementById('expenses-debt-daily').textContent = fmt(debtDailyTotal);

  // Total outflow (expenses + debt minimums — interest is already inside minimums)
  const totalOutflowMonthly = expTotal + debtMinsMonthly;
  document.getElementById('expenses-total').textContent = fmt(totalOutflowMonthly);
  document.getElementById('expenses-daily-total').textContent = fmt(totalOutflowMonthly / 30.44);

  // Income row
  const incomeMonthly = totalMonthlyIncome();
  document.getElementById('expenses-income-monthly').textContent = fmt(incomeMonthly);
  document.getElementById('expenses-income-daily').textContent = fmt(incomeMonthly / 30.44);

  // Net row
  const netMonthly = incomeMonthly - totalOutflowMonthly;
  const netEl = document.getElementById('expenses-net-monthly');
  const netDailyEl = document.getElementById('expenses-net-daily');
  netEl.textContent = fmt(Math.abs(netMonthly));
  netDailyEl.textContent = fmt(Math.abs(netMonthly) / 30.44);
  netEl.className = netMonthly >= 0 ? 'pos' : 'neg';
  netDailyEl.className = netMonthly >= 0 ? 'pos' : 'neg';
  netEl.textContent = (netMonthly >= 0 ? '+' : '−') + fmt(Math.abs(netMonthly));
  netDailyEl.textContent = (netMonthly >= 0 ? '+' : '−') + fmt(Math.abs(netMonthly) / 30.44);

  tbody.querySelectorAll('[data-kind="exp"]').forEach((el) => {
    el.addEventListener('change', () => {
      const x = state.expenses.find((e) => e.id === el.dataset.id);
      if (!x) return;
      const f = el.dataset.field;
      x[f] = f === 'amount' ? parseFloat(el.value) || 0 : el.value.trim();
      save();
      renderAll();
    });
  });
  tbody.querySelectorAll('button[data-del-exp]').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.expenses = state.expenses.filter((x) => x.id !== btn.dataset.delExp);
      save();
      renderAll();
      toast('Expense removed');
    });
  });
}

// ---- Efficiency ----------------------------------------------------------
// What minimum would this debt have at a given balance?
function minAtBalance(d, bal) {
  if (bal <= 0) return 0;
  if ((d.type || 'card') === 'loan')
    return Math.min(bal, Number(d.minimum) || 0);
  const pct = Number(d.minPct) || 0;
  if (pct <= 0) return 0;
  return Math.min(bal, Math.max(CARD_MIN_FLOOR, bal * pct));
}

function renderEfficiency() {
  const tbody = document.querySelector('#table-efficiency tbody');
  tbody.innerHTML = '';
  const amount = Number(document.getElementById('eff-amount').value) || 10;

  const rows = state.debts
    .filter((d) => (Number(d.balance) || 0) > 0)
    .map((d) => {
      const balance = Number(d.balance) || 0;
      const type = d.type || 'card';
      const curMin = effectiveMin(d);
      const newBal = Math.max(0, balance - amount);
      const newMin = minAtBalance(d, newBal);
      const freed = curMin - newMin;
      return { d, balance, type, curMin, newMin, freed };
    })
    .sort((a, b) => b.freed - a.freed);

  if (!rows.length) {
    tbody.innerHTML =
      '<tr class="empty-row"><td colspan="8">No active debts.</td></tr>';
  } else {
    rows.forEach((r, i) => {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${i + 1}</td>
        <td>${escape(r.d.name)}</td>
        <td>${r.type === 'loan' ? 'Loan' : 'Card'}</td>
        <td>${fmt(r.balance)}</td>
        <td>${fmt(r.curMin)}</td>
        <td>${fmt(r.newMin)}</td>
        <td class="${r.freed > 0 ? 'pos' : ''}">${r.freed > 0 ? '+' : ''}${fmt(r.freed)}/mo</td>
        <td>${fmt(r.balance)}</td>
      `;
      tbody.appendChild(tr);
    });
  }
}

// ---- Plan ----------------------------------------------------------------
function renderPlan() {
  // sync controls with state
  document.querySelectorAll('input[name="strategy"]').forEach((r) => {
    r.checked = r.value === state.settings.strategy;
  });
  const extraEl = document.getElementById('extra-payment');
  if (document.activeElement !== extraEl) extraEl.value = state.settings.extra || '';

  const a = aggregates();
  const helpEl = document.getElementById('extra-help');
  if (a.useRule) {
    helpEl.textContent =
      'Emergency Fund Rule is ON — extra payments are auto-calculated each month (anything over threshold).';
    helpEl.style.color = 'var(--info)';
  } else {
    if (a.available < 0) {
      helpEl.textContent = `⚠ Available (${fmt0(a.available)}) is negative. Reduce expenses or extra won't apply.`;
      helpEl.style.color = 'var(--danger)';
    } else if (a.totalMins > 0) {
      helpEl.textContent = `${fmt0(a.available)} available after expenses & minimums. Consider using it here.`;
      helpEl.style.color = '';
    } else {
      helpEl.textContent = 'Beyond minimums.';
      helpEl.style.color = '';
    }
  }
  // Disable extra input when rule is on
  extraEl.disabled = a.useRule;
  extraEl.style.opacity = a.useRule ? 0.5 : 1;

  // Sync hold-zero checkbox
  document.getElementById('hold-zero-pct').checked = !!state.settings.holdZeroPct;

  const sim = simulatePayoff(simOpts());

  if (!state.debts.length) {
    document.getElementById('plan-months').textContent = '—';
    document.getElementById('plan-date').textContent = 'Add debts to see a plan';
    document.getElementById('plan-interest').textContent = fmt0(0);
    document.getElementById('plan-total').textContent = fmt0(0);
    document.getElementById('plan-monthly').textContent = fmt0(0);
  } else if (sim.stuck) {
    document.getElementById('plan-months').textContent = '∞';
    document.getElementById('plan-date').textContent = 'Payments not covering interest';
    document.getElementById('plan-interest').textContent = fmt0(sim.totalInterest);
    document.getElementById('plan-total').textContent = fmt0(sim.totalPaid);
    document.getElementById('plan-monthly').textContent = fmt0(a.totalMins + (a.useRule ? 0 : a.extra));
  } else {
    document.getElementById('plan-months').textContent = humanMonths(sim.months);
    document.getElementById('plan-date').textContent = `Free on ${dateInMonths(sim.months)}`;
    document.getElementById('plan-interest').textContent = fmt0(sim.totalInterest);
    document.getElementById('plan-total').textContent = fmt0(sim.totalPaid);
    const monthlyAlloc = a.useRule
      ? sim.totalPaid / Math.max(1, sim.months)
      : a.totalMins + a.extra;
    document.getElementById('plan-monthly').textContent = fmt0(monthlyAlloc);
  }

  // Bank milestones (3 / 6 / 12 months of expenses saved)
  const netCashflow = a.totalIncome - a.totalExpenses;
  [3, 6, 12].forEach((m) => {
    const target = a.totalExpenses * m;
    const valEl = document.getElementById(`milestone-${m}`);
    const subEl = document.getElementById(`milestone-${m}-sub`);
    if (a.totalExpenses <= 0) {
      valEl.textContent = '—';
      subEl.textContent = 'add expenses first';
      return;
    }
    const months = monthsToHitBankTarget(sim, target, netCashflow, a.bankBalance);
    if (months == null) {
      valEl.textContent = '∞';
      subEl.textContent = `target ${fmt0(target)} • net cashflow not positive`;
    } else if (months === 0) {
      valEl.textContent = 'Now';
      subEl.textContent = `target ${fmt0(target)} • already saved`;
    } else {
      valEl.textContent = humanMonths(months);
      subEl.textContent = `target ${fmt0(target)} • ${dateInMonths(months)}`;
    }
  });

  // Order table
  const tbody = document.querySelector('#table-order tbody');
  tbody.innerHTML = '';
  if (!sim.order.length) {
    tbody.innerHTML = `<tr class="empty-row"><td colspan="6">Add debts to see payoff order.</td></tr>`;
  } else {
    sim.order.forEach((d, idx) => {
      const tr = document.createElement('tr');
      const paidIn = d.paidOffMonth ? humanMonths(d.paidOffMonth) : '—';
      const date = d.paidOffMonth ? dateInMonths(d.paidOffMonth) : '—';
      tr.innerHTML = `
        <td>${idx + 1}</td>
        <td>${escape(d.name)}</td>
        <td>${fmt(d.originalBalance)}</td>
        <td>${d.apr}%</td>
        <td>${paidIn}</td>
        <td>${date}</td>
      `;
      tbody.appendChild(tr);
    });
  }

  renderSchedule(sim);
}

function renderSchedule(sim) {
  const thead = document.querySelector('#table-schedule thead');
  const tbody = document.querySelector('#table-schedule tbody');
  const limitSel = document.getElementById('schedule-limit');
  const summary = document.getElementById('schedule-summary');
  if (!thead || !tbody) return;

  thead.innerHTML = '';
  tbody.innerHTML = '';

  // sync limit control
  if (limitSel && document.activeElement !== limitSel) {
    limitSel.value = state.settings.scheduleLimit || 36;
  }

  if (!sim.schedule || !sim.schedule.length) {
    thead.innerHTML = '<tr><th>Month</th></tr>';
    tbody.innerHTML = `<tr class="empty-row"><td>Add debts and a budget to see your schedule.</td></tr>`;
    summary.textContent = '—';
    return;
  }

  const debts = state.debts;
  const monthlyExpenses = sum(state.expenses, 'amount');
  const monthlyIncome = totalMonthlyIncome();
  // Header rows
  const groupRow = document.createElement('tr');
  groupRow.innerHTML =
    `<th class="group-head" colspan="2">When</th>` +
    `<th class="group-head" colspan="3">Cash Flow</th>` +
    debts
      .map((d, i) => {
        const cls = ' col-divider';
        return `<th class="group-head${cls}" colspan="2" style="color:${PALETTE[i % PALETTE.length]}">${escape(d.name)}</th>`;
      })
      .join('') +
    `<th class="group-head col-divider" colspan="2">Total</th>`;
  thead.appendChild(groupRow);

  const subRow = document.createElement('tr');
  subRow.innerHTML =
    `<th>#</th><th>Date</th>` +
    `<th>Bank</th><th class="col-expense">Min Expenses</th><th class="col-extra">Extra Cash</th>` +
    debts
      .map(() => {
        return `<th class="col-paid col-divider">Paid</th><th class="col-remaining">Remaining</th>`;
      })
      .join('') +
    `<th class="col-paid col-divider">Paid</th><th class="col-remaining">Remaining</th>`;
  thead.appendChild(subRow);

  const limit = Number(state.settings.scheduleLimit) || 36;
  const shown = sim.schedule.slice(0, limit);
  shown.forEach((row) => {
    const tr = document.createElement('tr');
    const paidOff = row.totalRemaining < 0.005;
    if (paidOff) tr.classList.add('paid-off');
    const dateLabel = dateInMonths(row.month);
    const perDebtCells = debts
      .map((d) => {
        const pd = row.perDebt[d.id] || { payment: 0, remaining: 0 };
        const isTarget = row.targetId === d.id;
        const star = isTarget ? ' ★' : '';
        const targetClass = isTarget ? ' schedule-target' : '';
        const payTxt = pd.payment > 0.005 ? fmt0(pd.payment) + star : '—';
        const remTxt = pd.remaining > 0.005 ? fmt0(pd.remaining) : '✓';
        return `<td class="col-paid col-divider${targetClass}">${payTxt}</td><td class="col-remaining">${remTxt}</td>`;
      })
      .join('');
    const minExp = monthlyExpenses + (row.minimumsPaid || 0);
    const extraCash = monthlyIncome - minExp;
    const extraClass = extraCash >= 0 ? 'col-extra pos' : 'col-extra neg';
    tr.innerHTML = `
      <td>${row.month}</td>
      <td>${dateLabel}</td>
      <td class="col-bank">${fmt0(row.bank)}</td>
      <td class="col-expense">${fmt0(minExp)}</td>
      <td class="${extraClass}">${fmt0(extraCash)}</td>
      ${perDebtCells}
      <td class="col-paid col-divider">${fmt0(row.totalPaidThisMonth)}</td>
      <td class="col-remaining">${row.totalRemaining > 0.005 ? fmt0(row.totalRemaining) : '✓'}</td>
    `;
    tbody.appendChild(tr);
  });

  const total = sim.schedule.length;
  const showing = Math.min(limit, total);
  summary.textContent =
    showing < total
      ? `Showing first ${showing} of ${total} months. Increase the limit to see more.`
      : `Showing all ${total} months.`;

  // Mobile cards
  const cardsEl = document.getElementById('schedule-cards');
  const useRule = !!state.settings.useEmergencyRule;
  const efThreshold = Number(state.settings.emergencyFund) || 0;
  let efReached = false;
  if (cardsEl) {
    cardsEl.innerHTML = shown.map(row => {
      const paidOff = row.totalRemaining < 0.005;
      const dateLabel = dateInMonths(row.month);
      if (useRule && !efReached && row.bank >= efThreshold) efReached = true;
      const cardTitle = useRule && !efReached
        ? `${row.month} - ${dateLabel} · ${fmt0(row.bank)}`
        : `${row.month} - ${dateLabel}`;
      const minExp = monthlyExpenses + (row.minimumsPaid || 0);
      const extraCash = monthlyIncome - minExp;
      const debtRows = debts.map((d, i) => {
        const pd = row.perDebt[d.id] || { payment: 0, remaining: 0 };
        const isTarget = row.targetId === d.id;
        const color = PALETTE[i % PALETTE.length];
        const paid = pd.payment > 0.005 ? fmt0(pd.payment) : '—';
        const rem = pd.remaining > 0.005 ? fmt0(pd.remaining) : '✓';
        return `<div class="sc-debt${isTarget ? ' sc-target' : ''}">
          <span class="sc-dot" style="background:${color}"></span>
          <span class="sc-debt-name">${escape(d.name)}</span>
          <span class="sc-debt-paid">${paid}</span>
          <span class="sc-debt-rem">${rem}</span>
        </div>`;
      }).join('');
      return `<div class="sc-card${paidOff ? ' sc-done' : ''}">
        <div class="sc-head">
          <span class="sc-num">${cardTitle}</span>
        </div>
        <div class="sc-flow">
          <div class="sc-flow-item"><span>Bank</span><span class="sc-bank">${fmt0(row.bank)}</span></div>
          <div class="sc-flow-item"><span>Expenses</span><span class="sc-exp">${fmt0(minExp)}</span></div>
          <div class="sc-flow-item"><span>Extra</span><span class="sc-extra ${extraCash >= 0 ? 'pos' : 'neg'}">${fmt0(extraCash)}</span></div>
        </div>
        <div class="sc-debts">${debtRows}</div>
        <div class="sc-total">
          <span>Paid <strong>${fmt0(row.totalPaidThisMonth)}</strong></span>
          <span>Left <strong>${row.totalRemaining > 0.005 ? fmt0(row.totalRemaining) : '✓'}</strong></span>
        </div>
      </div>`;
    }).join('');
  }
}

// ---- Reminders -----------------------------------------------------------
const REMIND_CATEGORIES = {
  bill: { label: 'Bill', color: '#f5c06a' },
  debt: { label: 'Debt', color: '#ef6868' },
  check: { label: 'Check', color: '#6ba9f0' },
  savings: { label: 'Savings', color: '#6ee7a8' },
  other: { label: 'Other', color: '#c78bf0' },
};

const REMIND_PRESETS = {
  rent: { title: 'Pay Rent / Mortgage', category: 'bill', recur: 'monthly' },
  electric: { title: 'Pay Electric Bill', category: 'bill', recur: 'monthly' },
  water: { title: 'Pay Water Bill', category: 'bill', recur: 'monthly' },
  internet: { title: 'Pay Internet Bill', category: 'bill', recur: 'monthly' },
  phone: { title: 'Pay Phone Bill', category: 'bill', recur: 'monthly' },
  insurance: { title: 'Pay Insurance', category: 'bill', recur: 'monthly' },
  creditcard: { title: 'Pay Credit Card', category: 'debt', recur: 'monthly' },
  checkbank: { title: 'Check Bank Balance', category: 'check', recur: 'weekly' },
};

function remindDaysUntil(dateStr) {
  if (!dateStr) return null;
  const today = new Date(todayISO());
  const due = new Date(dateStr);
  return Math.round((due - today) / 86400000);
}

function remindNextDate(dateStr, recur) {
  const d = new Date(dateStr);
  switch (recur) {
    case 'weekly': d.setDate(d.getDate() + 7); break;
    case 'biweekly': d.setDate(d.getDate() + 14); break;
    case 'monthly': d.setMonth(d.getMonth() + 1); break;
    case 'quarterly': d.setMonth(d.getMonth() + 3); break;
    case 'yearly': d.setFullYear(d.getFullYear() + 1); break;
  }
  return d.toISOString().slice(0, 10);
}

function remindUrgencyLabel(days) {
  if (days === null) return '';
  if (days < 0) return `${Math.abs(days)}d overdue`;
  if (days === 0) return 'Due today';
  if (days === 1) return 'Due tomorrow';
  if (days <= 7) return `${days}d left`;
  return new Date(todayISO().replace(/-/g, '/').replace(/T.*/, '') + ' 00:00').toISOString().slice(0, 10) ? `${days}d` : `${days}d`;
}

function renderRemindItem(r) {
  const cat = REMIND_CATEGORIES[r.category] || REMIND_CATEGORIES.other;
  const days = remindDaysUntil(r.due);
  let urgClass = '';
  let urgText = '';
  if (days !== null) {
    if (days < 0) { urgClass = 'overdue'; urgText = `${Math.abs(days)}d overdue`; }
    else if (days === 0) { urgClass = 'today'; urgText = 'Today'; }
    else if (days === 1) { urgClass = 'tomorrow'; urgText = 'Tomorrow'; }
    else if (days <= 3) { urgClass = 'soon'; urgText = `${days} days`; }
    else if (days <= 7) { urgClass = 'thisweek'; urgText = `${days} days`; }
    else { urgText = new Date(r.due).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }); }
  }
  const recurLabel = r.recur ? ` &middot; repeats` : '';
  const doneCheck = r.done ? ' checked' : '';
  return `<div class="remind-item ${urgClass} ${r.done ? 'done' : ''}" data-id="${r.id}">
    <label class="remind-check"><input type="checkbox"${doneCheck} data-remind-toggle="${r.id}" /><span class="remind-checkmark"></span></label>
    <div class="remind-body">
      <div class="remind-title">${escape(r.title)}</div>
      <div class="remind-meta">
        <span class="remind-cat" style="--cat-color:${cat.color}">${cat.label}</span>
        ${urgText ? `<span class="remind-urg ${urgClass}">${urgText}</span>` : ''}
        ${recurLabel ? `<span class="remind-recur">${recurLabel}</span>` : ''}
      </div>
    </div>
    <button class="remind-del" data-remind-del="${r.id}" title="Delete">&times;</button>
  </div>`;
}

function renderReminders() {
  const items = state.reminders || [];
  const active = items.filter(r => !r.done);
  const done = items.filter(r => r.done);

  const overdue = [];
  const today = [];
  const upcoming = [];
  const nodue = [];

  active.forEach(r => {
    const days = remindDaysUntil(r.due);
    if (days === null) nodue.push(r);
    else if (days < 0) overdue.push(r);
    else if (days === 0) today.push(r);
    else upcoming.push(r);
  });

  overdue.sort((a, b) => (a.due > b.due ? 1 : -1));
  today.sort((a, b) => a.title.localeCompare(b.title));
  upcoming.sort((a, b) => (a.due > b.due ? 1 : -1));

  const groups = [
    { id: 'overdue', items: overdue },
    { id: 'today', items: today },
    { id: 'upcoming', items: upcoming },
    { id: 'nodue', items: nodue },
  ];

  groups.forEach(g => {
    const wrap = document.getElementById(`remind-${g.id}`);
    const list = document.getElementById(`remind-${g.id}-list`);
    if (!wrap || !list) return;
    if (g.items.length) {
      wrap.style.display = '';
      list.innerHTML = g.items.map(renderRemindItem).join('');
    } else {
      wrap.style.display = 'none';
      list.innerHTML = '';
    }
  });

  const emptyEl = document.getElementById('remind-empty');
  if (emptyEl) emptyEl.style.display = active.length ? 'none' : '';

  const doneWrap = document.getElementById('remind-done-wrap');
  const doneList = document.getElementById('remind-done-list');
  if (doneWrap) doneWrap.style.display = done.length ? '' : 'none';
  if (doneList) doneList.innerHTML = done.map(renderRemindItem).join('');
}

function initReminders() {
  const form = document.getElementById('form-reminder');
  if (!form) return;
  form.addEventListener('submit', e => {
    e.preventDefault();
    const fd = new FormData(form);
    state.reminders.push({
      id: uid(),
      title: fd.get('title').trim(),
      due: fd.get('due') || '',
      category: fd.get('category') || 'other',
      recur: fd.get('recur') || '',
      done: false,
      created: todayISO(),
    });
    save(); renderReminders(); syncRemindersToServer();
    form.reset();
    toast('Reminder added');
  });

  document.querySelectorAll('.remind-quick-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const preset = REMIND_PRESETS[btn.dataset.preset];
      if (!preset) return;
      const oneWeek = new Date();
      oneWeek.setDate(oneWeek.getDate() + 7);
      state.reminders.push({
        id: uid(),
        title: preset.title,
        due: oneWeek.toISOString().slice(0, 10),
        category: preset.category,
        recur: preset.recur,
        done: false,
        created: todayISO(),
      });
      save(); renderReminders(); syncRemindersToServer();
      toast(`Added: ${preset.title}`);
    });
  });

  const toggleBtn = document.getElementById('remind-toggle-done');
  const doneDiv = document.getElementById('remind-done');
  if (toggleBtn && doneDiv) {
    toggleBtn.addEventListener('click', () => {
      const show = doneDiv.style.display === 'none';
      doneDiv.style.display = show ? '' : 'none';
      toggleBtn.textContent = show ? 'Hide Completed' : 'Show Completed';
    });
  }

  const clearBtn = document.getElementById('remind-clear-done');
  if (clearBtn) {
    clearBtn.addEventListener('click', () => {
      state.reminders = state.reminders.filter(r => !r.done);
      save(); renderReminders(); syncRemindersToServer();
      toast('Cleared completed');
    });
  }

  document.getElementById('tab-reminders').addEventListener('click', e => {
    const toggleId = e.target.dataset?.remindToggle;
    if (toggleId) {
      const r = state.reminders.find(x => x.id === toggleId);
      if (r) {
        r.done = !r.done;
        if (r.done && r.recur && r.due) {
          state.reminders.push({
            id: uid(),
            title: r.title,
            due: remindNextDate(r.due, r.recur),
            category: r.category,
            recur: r.recur,
            done: false,
            created: todayISO(),
          });
        }
        save(); renderReminders(); syncRemindersToServer();
        if (r.done) toast('Done! Nice work.');
      }
    }
    const delId = e.target.dataset?.remindDel;
    if (delId) {
      state.reminders = state.reminders.filter(x => x.id !== delId);
      save(); renderReminders(); syncRemindersToServer();
    }
  });
}

// ---- Notifications -------------------------------------------------------
function getSwReg() {
  if (!('serviceWorker' in navigator)) return Promise.resolve(null);
  return navigator.serviceWorker.ready;
}

function notifyPermissionGranted() {
  return typeof Notification !== 'undefined' && Notification.permission === 'granted';
}

function swNotify(title, opts) {
  return getSwReg().then(reg => {
    if (reg) return reg.showNotification(title, opts);
    if (typeof Notification !== 'undefined') return new Notification(title, opts);
  });
}

function checkAndNotify() {
  if (!notifyPermissionGranted()) return;
  if (getSnoozeRemaining() > 0) return;
  const h = easternHour();
  if (h < 8 || h >= 21) return;
  const today = todayISO();

  const active = (state.reminders || []).filter(r => !r.done && r.due);

  // Overdue: notify once per day per item
  const notifiedKey = 'fd:notified:' + today;
  const alreadyNotified = JSON.parse(localStorage.getItem(notifiedKey) || '[]');
  const overdue = active.filter(r => r.due < today && !alreadyNotified.includes(r.id));
  const newlyNotified = [];

  overdue.forEach(r => {
    const days = Math.abs(remindDaysUntil(r.due));
    swNotify('Overdue Reminder', {
      body: `${r.title} — ${days} day${days > 1 ? 's' : ''} overdue`,
      icon: 'icon-192.png',
      tag: r.id,
    });
    newlyNotified.push(r.id);
  });

  if (newlyNotified.length) {
    localStorage.setItem(notifiedKey, JSON.stringify([...alreadyNotified, ...newlyNotified]));
  }

  // Due today: always nag every cycle until completed
  const dueToday = active.filter(r => r.due === today);
  dueToday.forEach(r => {
    swNotify('Due Today', {
      body: r.title,
      icon: 'icon-192.png',
      tag: 'today-' + r.id,
      renotify: true,
    });
  });
}

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - base64String.length % 4) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; i++) outputArray[i] = rawData.charCodeAt(i);
  return outputArray;
}

let pushSub = null;

async function subscribeToPush() {
  if (!PUSH_SERVER || !VAPID_PUBLIC) return null;
  const reg = await getSwReg();
  if (!reg) return null;
  let sub = await reg.pushManager.getSubscription();
  if (!sub) {
    sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC),
    });
  }
  pushSub = sub;
  await fetch(PUSH_SERVER + '/subscribe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      subscription: sub.toJSON(),
      reminders: (state.reminders || []).filter(r => !r.done && r.due),
    }),
  }).catch(() => {});
  return sub;
}

function syncRemindersToServer() {
  if (!PUSH_SERVER || !pushSub) return;
  const snoozeUntil = Number(localStorage.getItem('fd:snoozeUntil')) || 0;
  fetch(PUSH_SERVER + '/sync', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      subscription: pushSub.toJSON(),
      reminders: (state.reminders || []).filter(r => !r.done && r.due),
      snoozeUntil,
    }),
  }).catch(() => {});
}

function getSnoozeRemaining() {
  const until = Number(localStorage.getItem('fd:snoozeUntil')) || 0;
  return Math.max(0, until - Date.now());
}

function formatCountdown(ms) {
  const totalSec = Math.ceil(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function setSnooze(minutes) {
  const until = Date.now() + minutes * 60 * 1000;
  localStorage.setItem('fd:snoozeUntil', String(until));
  syncRemindersToServer();
  updateSnoozeUI();
}

function cancelSnooze() {
  localStorage.removeItem('fd:snoozeUntil');
  syncRemindersToServer();
  updateSnoozeUI();
}

let snoozeInterval = null;
function updateSnoozeUI() {
  const snoozeDiv = document.getElementById('remind-snooze');
  const activeDiv = document.getElementById('snooze-active');
  const btnsDiv = document.getElementById('snooze-btns');
  const countdown = document.getElementById('snooze-countdown');
  if (!snoozeDiv) return;

  const remaining = getSnoozeRemaining();
  if (remaining > 0) {
    activeDiv.style.display = '';
    btnsDiv.style.display = 'none';
    countdown.textContent = 'Snoozed — ' + formatCountdown(remaining);
    if (!snoozeInterval) {
      snoozeInterval = setInterval(() => {
        const r = getSnoozeRemaining();
        if (r <= 0) {
          cancelSnooze();
          toast('Notifications resumed');
        } else {
          countdown.textContent = 'Snoozed — ' + formatCountdown(r);
        }
      }, 1000);
    }
  } else {
    activeDiv.style.display = 'none';
    btnsDiv.style.display = '';
    if (snoozeInterval) { clearInterval(snoozeInterval); snoozeInterval = null; }
  }
}

function initNotifications() {
  const btn = document.getElementById('remind-notify-btn');
  const testBtn = document.getElementById('remind-notify-test');
  const status = document.getElementById('remind-notify-status');
  if (!btn || !status) return;

  function updateUI() {
    if (typeof Notification === 'undefined') {
      btn.textContent = 'Not Supported';
      btn.disabled = true;
      status.textContent = 'Your browser does not support notifications.';
      if (testBtn) testBtn.style.display = 'none';
      return;
    }
    if (Notification.permission === 'granted') {
      btn.textContent = 'Notifications On';
      btn.classList.add('active');
      btn.disabled = false;
      status.textContent = 'You\'ll get notified about overdue and due-today tasks.';
      if (testBtn) testBtn.style.display = '';
    } else if (Notification.permission === 'denied') {
      btn.textContent = 'Blocked';
      btn.disabled = true;
      status.textContent = 'Notifications were blocked. Enable them in your browser settings.';
      if (testBtn) testBtn.style.display = 'none';
    } else {
      btn.textContent = 'Enable Notifications';
      btn.classList.remove('active');
      btn.disabled = false;
      status.textContent = 'Get alerted when tasks are due or overdue.';
      if (testBtn) testBtn.style.display = 'none';
    }
  }

  updateUI();

  btn.addEventListener('click', () => {
    if (Notification.permission === 'granted') {
      swNotify('Reminders Active', {
        body: 'You\'re all set — notifications are working!',
        icon: 'icon-192.png',
      });
      return;
    }
    Notification.requestPermission().then(async perm => {
      updateUI();
      if (perm === 'granted') {
        checkAndNotify();
        await subscribeToPush();
        if (snoozeDiv) { snoozeDiv.style.display = ''; updateSnoozeUI(); }
        toast(pushSub ? 'Push notifications enabled!' : 'Notifications enabled!');
      }
    });
  });

  if (testBtn) {
    testBtn.addEventListener('click', () => {
      swNotify('Test Notification', {
        body: 'If you see this, push notifications are working!',
        icon: 'icon-192.png',
        tag: 'debug-test-' + Date.now(),
      }).then(() => {
        toast('Test notification sent');
      }).catch(err => {
        toast('Notification failed: ' + err.message, 'error');
      });
    });
  }

  // Snooze
  const snoozeGoBtn = document.getElementById('snooze-go');
  const snoozeInput = document.getElementById('snooze-minutes');
  if (snoozeGoBtn && snoozeInput) {
    snoozeGoBtn.addEventListener('click', () => {
      const mins = Math.max(1, Math.min(1440, Number(snoozeInput.value) || 30));
      setSnooze(mins);
      toast('Snoozed for ' + mins + ' min');
    });
  }
  const snoozeCancelBtn = document.getElementById('snooze-cancel');
  if (snoozeCancelBtn) snoozeCancelBtn.addEventListener('click', cancelSnooze);

  // Show snooze bar when notifications are on
  const snoozeDiv = document.getElementById('remind-snooze');
  if (snoozeDiv && notifyPermissionGranted()) {
    snoozeDiv.style.display = '';
    updateSnoozeUI();
  }

  // Check on load and every 2 minutes
  checkAndNotify();
  setInterval(checkAndNotify, 15 * 60 * 1000);

  // Re-register push subscription if already granted
  if (notifyPermissionGranted()) subscribeToPush();
}

// ---- Progress ------------------------------------------------------------
function renderProgress() {
  const total = sum(state.debts, 'balance');
  document.getElementById('snapshot-current').textContent = fmt(total);

  renderHistoryChart();

  const tbody = document.querySelector('#table-history tbody');
  tbody.innerHTML = '';
  if (!state.snapshots.length) {
    tbody.innerHTML = `<tr class="empty-row"><td colspan="4">No snapshots yet. Save one above.</td></tr>`;
    return;
  }
  const sorted = state.snapshots.slice().sort((a, b) => a.date.localeCompare(b.date));
  sorted.forEach((s, i) => {
    const prev = i > 0 ? sorted[i - 1] : null;
    const delta = prev ? s.total - prev.total : null;
    const d = new Date(s.date);
    const tr = document.createElement('tr');
    const deltaHtml =
      delta == null
        ? '—'
        : delta < 0
        ? `<span style="color:var(--accent)">▼ ${fmt(Math.abs(delta))}</span>`
        : delta > 0
        ? `<span style="color:var(--danger)">▲ ${fmt(delta)}</span>`
        : '—';
    tr.innerHTML = `
      <td>${d.toLocaleDateString()} ${d.toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'})}</td>
      <td>${fmt(s.total)}</td>
      <td>${deltaHtml}</td>
      <td><button class="btn ghost" data-del-snap="${s.id}">Delete</button></td>
    `;
    tbody.appendChild(tr);
  });
  tbody.querySelectorAll('button[data-del-snap]').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.snapshots = state.snapshots.filter((s) => s.id !== btn.dataset.delSnap);
      save();
      renderAll();
    });
  });
}

function renderHistoryChart() {
  const ctx = document.getElementById('chart-history');
  if (!ctx) return;
  if (charts.history) charts.history.destroy();

  const sorted = state.snapshots.slice().sort((a, b) => a.date.localeCompare(b.date));
  const labels = sorted.map((s) =>
    new Date(s.date).toLocaleDateString([], { month: 'short', day: 'numeric' })
  );
  const data = sorted.map((s) => s.total);

  labels.push('Now');
  data.push(sum(state.debts, 'balance'));

  charts.history = new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [
        {
          label: 'Total Debt',
          data,
          borderColor: '#6ba9f0',
          backgroundColor: 'rgba(107, 169, 240, 0.12)',
          fill: true,
          tension: 0.2,
          pointRadius: 4,
          pointBackgroundColor: '#6ba9f0',
          borderWidth: 2,
        },
      ],
    },
    options: chartOpts({ legend: false, money: true }),
  });
}

// ---------------------------------------------------------------------------
// Chart options builder
// ---------------------------------------------------------------------------
function chartOpts({ legend = false, money = false, cutout, xTitle } = {}) {
  const grid = { color: '#2a3240', drawBorder: false };
  const ticks = { color: '#9aa7b8', font: { size: 11 } };
  const opts = {
    responsive: true,
    maintainAspectRatio: false,
    animation: { duration: 400 },
    plugins: {
      legend: {
        display: legend,
        position: 'right',
        labels: { color: '#e6edf3', font: { size: 12 }, boxWidth: 12 },
      },
      tooltip: {
        backgroundColor: '#1f2630',
        borderColor: '#3a4454',
        borderWidth: 1,
        titleColor: '#e6edf3',
        bodyColor: '#e6edf3',
        callbacks: money
          ? {
              label: (c) => {
                const v = c.parsed.y ?? c.parsed;
                return ` ${c.dataset.label || c.label}: ${fmt(v)}`;
              },
            }
          : {},
      },
    },
    scales: {},
  };
  if (cutout) opts.cutout = cutout;
  opts.scales.x = {
    grid,
    ticks,
    title: xTitle ? { display: true, text: xTitle, color: '#9aa7b8' } : undefined,
  };
  opts.scales.y = {
    grid,
    ticks: {
      ...ticks,
      callback: (v) => (money ? fmt0(v) : v),
    },
    beginAtZero: true,
  };
  return opts;
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------
function escape(str) {
  return String(str ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------
initTabs();
initForms();
initReminders();
initNotifications();
renderAll();
