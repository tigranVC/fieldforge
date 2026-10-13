// Read-only queries shared by the UI, window.fieldforge and the REST server.
import { TRADES, SERVICES } from './catalog.js';
import { isDate, parseTime, addDays, daysBetween } from './util.js';
import { ActionError, byId, mustGet, techDistance, slotProblem, isPastSlot, invoiceBalance, occupies } from './model.js';

function filterBy(list, p, keys) {
  return list.filter((e) => keys.every((k) => p[k] == null || p[k] === '' || e[k] === p[k]));
}

function page(list, p) {
  const offset = Math.max(0, Number(p.offset) || 0);
  const limit = p.limit == null ? list.length : Math.max(0, Number(p.limit));
  return { total: list.length, offset, items: list.slice(offset, offset + limit) };
}

/**
 * Technicians who can take a job at date/start, sorted by distance from their
 * home base to the job location (ties broken by technician id).
 */
export function findAvailableTechs(state, p) {
  let job;
  if (p.jobId) {
    job = mustGet(state, 'jobs', p.jobId, 'job');
  } else {
    if (!TRADES.includes(p.trade)) throw new ActionError('INVALID_PARAMS', 'trade or jobId is required');
    const companyId = p.companyId;
    if (!state.companies.some((c) => c.id === companyId)) throw new ActionError('INVALID_PARAMS', 'companyId is required when jobId is not given');
    job = { id: null, companyId, trade: p.trade, durationMin: Number(p.durationMin) || 60, locationId: p.locationId };
  }
  const durationMin = p.durationMin != null ? Number(p.durationMin) : job.durationMin;
  if (!isDate(p.date)) throw new ActionError('INVALID_PARAMS', 'date must be YYYY-MM-DD');
  const start = parseTime(p.start);
  if (!Number.isInteger(start)) throw new ActionError('INVALID_PARAMS', 'start is required');
  if (isPastSlot(state, p.date, start)) return [];
  const location = job.locationId ? byId(state, 'locations', job.locationId) : null;
  const out = [];
  for (const t of state.technicians) {
    if (slotProblem(state, t, job, p.date, start, durationMin)) continue;
    out.push({ techId: t.id, name: t.name, trades: t.trades, zone: t.zone, distance: location ? techDistance(t, location) : null });
  }
  out.sort((a, b) => (a.distance ?? 0) - (b.distance ?? 0) || (a.techId < b.techId ? -1 : 1));
  return out;
}

export function techSchedule(state, p) {
  const tech = mustGet(state, 'technicians', p.techId, 'technician');
  const jobs = state.jobs
    .filter((j) => j.techId === tech.id && (!p.date || j.date === p.date) && occupies(j))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.startMin - b.startMin));
  return { technician: tech, jobs };
}

export function freeSlots(state, p) {
  const tech = mustGet(state, 'technicians', p.techId, 'technician');
  if (!isDate(p.date)) throw new ActionError('INVALID_PARAMS', 'date must be YYYY-MM-DD');
  const dur = Number(p.durationMin) || 60;
  const step = Number(p.step) || 30;
  const probe = { id: p.jobId || null, companyId: tech.companyId, trade: tech.trades[0] };
  const out = [];
  for (let s = Math.ceil(tech.shiftStart / step) * step; s + dur <= tech.shiftEnd; s += step) {
    if (isPastSlot(state, p.date, s)) continue;
    if (!slotProblem(state, tech, probe, p.date, s, dur)) out.push(s);
  }
  return out;
}

export function customerSummary(state, p) {
  const customer = mustGet(state, 'customers', p.customerId, 'customer');
  const own = (coll) => state[coll].filter((e) => e.customerId === customer.id);
  const invoices = own('invoices');
  return {
    customer,
    locations: own('locations'),
    jobs: own('jobs'),
    estimates: own('estimates'),
    invoices,
    payments: own('payments'),
    notifications: own('notifications'),
    balanceCents: invoices.reduce((a, i) => a + invoiceBalance(i), 0),
  };
}

/** KPI report. from/to bound job dates, invoice createdAt and payment dates (inclusive). */
export function report(state, p = {}) {
  const today = state.meta.today;
  const to = p.to || today;
  const from = p.from || addDays(to, -29);
  const inCo = (e) => !p.companyId || e.companyId === p.companyId;
  const inRange = (d) => d && d >= from && d <= to;
  const jobs = state.jobs.filter(inCo);
  const invoices = state.invoices.filter(inCo);
  const payments = state.payments.filter(inCo);
  const estimates = state.estimates.filter(inCo);

  const jobsInRange = jobs.filter((j) => inRange(j.date));
  const jobsByStatus = {};
  for (const j of jobsInRange) jobsByStatus[j.status] = (jobsByStatus[j.status] || 0) + 1;
  const completed = jobsInRange.filter((j) => j.status === 'completed');
  const byTrade = {};
  for (const tr of TRADES) byTrade[tr] = { jobs: 0, completed: 0, invoicedCents: 0 };
  for (const j of jobsInRange) {
    byTrade[j.trade].jobs++;
    if (j.status === 'completed') byTrade[j.trade].completed++;
  }
  const jobById = new Map(jobs.map((j) => [j.id, j]));
  let invoicedCents = 0;
  for (const i of invoices) {
    if (i.status === 'void' || !inRange(i.createdAt)) continue;
    invoicedCents += i.totalCents;
    const j = jobById.get(i.jobId);
    if (j) byTrade[j.trade].invoicedCents += i.totalCents;
  }
  const collected = payments.filter((x) => x.status === 'completed' && inRange(x.date));
  const collectedCents = collected.reduce((a, x) => a + x.amountCents, 0);

  const aging = { current: 0, d1_30: 0, d31_60: 0, d61_90: 0, d90_plus: 0 };
  let arCents = 0;
  for (const i of invoices) {
    const bal = invoiceBalance(i);
    if (bal <= 0 || !i.dueDate || i.status === 'draft') continue;
    arCents += bal;
    const late = daysBetween(i.dueDate, today);
    if (late <= 0) aging.current += bal;
    else if (late <= 30) aging.d1_30 += bal;
    else if (late <= 60) aging.d31_60 += bal;
    else if (late <= 90) aging.d61_90 += bal;
    else aging.d90_plus += bal;
  }

  const est = estimates.filter((e) => inRange(e.createdAt));
  const decided = est.filter((e) => e.status === 'approved' || e.status === 'declined');
  const approved = est.filter((e) => e.status === 'approved');

  const techs = state.technicians.filter(inCo).map((t) => {
    const tj = jobsInRange.filter((j) => j.techId === t.id && j.status !== 'canceled' && j.status !== 'unscheduled');
    const bookedMin = tj.reduce((a, j) => a + j.durationMin, 0);
    const days = new Set();
    for (let d = from; d <= to; d = addDays(d, 1)) if (new Date(`${d}T00:00:00Z`).getUTCDay() !== 0) days.add(d);
    const capacity = days.size * (t.shiftEnd - t.shiftStart);
    const revenue = tj.reduce((a, j) => a + j.items.reduce((s, it) => s + it.qty * it.unitPriceCents, 0), 0);
    return { techId: t.id, name: t.name, companyId: t.companyId, trades: t.trades, jobs: tj.length, bookedMin, utilization: capacity ? Math.round((bookedMin / capacity) * 1000) / 1000 : 0, revenueCents: revenue };
  });

  return {
    companyId: p.companyId || null,
    from,
    to,
    jobs: { total: jobsInRange.length, byStatus: jobsByStatus, byTrade, completed: completed.length, avgTicketCents: completed.length ? Math.round(completed.reduce((a, j) => a + j.items.reduce((s, it) => s + it.qty * it.unitPriceCents, 0), 0) / completed.length) : 0 },
    revenue: { invoicedCents, collectedCents, payments: collected.length },
    receivables: { openCents: arCents, aging },
    estimates: { created: est.length, approved: approved.length, declined: decided.length - approved.length, open: est.filter((e) => e.status === 'draft' || e.status === 'sent').length, closeRate: decided.length ? Math.round((approved.length / decided.length) * 1000) / 1000 : 0 },
    technicians: techs,
    unscheduledJobs: jobs.filter((j) => j.status === 'unscheduled').length,
  };
}

// params: [name, type, required, description]
export const QUERIES = {
  listCustomers: {
    description: 'List customers (filters: companyId, type, q = name/phone/email substring).',
    params: [['companyId', 'string', false, ''], ['type', 'string', false, ''], ['q', 'string', false, ''], ['offset', 'integer', false, ''], ['limit', 'integer', false, '']],
    run(state, p) {
      let list = filterBy(state.customers, p, ['companyId', 'type']);
      if (p.q) {
        const q = String(p.q).toLowerCase();
        list = list.filter((c) => c.name.toLowerCase().includes(q) || c.phone.includes(q) || c.email.toLowerCase().includes(q) || c.id.toLowerCase() === q);
      }
      return page(list, p);
    },
  },
  getCustomer: { description: 'Customer with locations, jobs, estimates, invoices, payments, notifications and balance.', params: [['customerId', 'string', true, '']], run: customerSummary },
  listLocations: { description: 'List locations (filters: customerId, companyId, zone).', params: [['customerId', 'string', false, ''], ['companyId', 'string', false, ''], ['zone', 'string', false, '']], run: (s, p) => page(filterBy(s.locations, p, ['customerId', 'companyId', 'zone']), p) },
  listTechnicians: {
    description: 'List technicians (filters: companyId, trade, zone, active).',
    params: [['companyId', 'string', false, ''], ['trade', 'string', false, ''], ['zone', 'string', false, ''], ['active', 'boolean', false, '']],
    run(state, p) {
      let list = filterBy(state.technicians, p, ['companyId', 'zone']);
      if (p.trade) list = list.filter((t) => t.trades.includes(p.trade));
      if (p.active != null && p.active !== '') list = list.filter((t) => t.active === (p.active === true || p.active === 'true'));
      return list;
    },
  },
  listJobs: {
    description: 'List jobs (filters: companyId, customerId, locationId, techId, status, trade, priority, date, from, to).',
    params: [['companyId', 'string', false, ''], ['customerId', 'string', false, ''], ['techId', 'string', false, ''], ['status', 'string', false, ''], ['trade', 'string', false, ''], ['priority', 'string', false, ''], ['date', 'YYYY-MM-DD', false, ''], ['from', 'YYYY-MM-DD', false, ''], ['to', 'YYYY-MM-DD', false, ''], ['offset', 'integer', false, ''], ['limit', 'integer', false, '']],
    run(state, p) {
      let list = filterBy(state.jobs, p, ['companyId', 'customerId', 'locationId', 'techId', 'status', 'trade', 'priority', 'date']);
      if (p.from) list = list.filter((j) => j.date && j.date >= p.from);
      if (p.to) list = list.filter((j) => j.date && j.date <= p.to);
      return page(list, p);
    },
  },
  getJob: {
    description: 'Job with customer, location, technician, estimate and invoices.',
    params: [['jobId', 'string', true, '']],
    run(state, p) {
      const job = mustGet(state, 'jobs', p.jobId, 'job');
      return {
        job,
        customer: byId(state, 'customers', job.customerId),
        location: byId(state, 'locations', job.locationId),
        technician: job.techId ? byId(state, 'technicians', job.techId) : null,
        estimate: job.estimateId ? byId(state, 'estimates', job.estimateId) : null,
        invoices: state.invoices.filter((i) => i.jobId === job.id),
      };
    },
  },
  listEstimates: { description: 'List estimates (filters: companyId, customerId, status, trade).', params: [['companyId', 'string', false, ''], ['customerId', 'string', false, ''], ['status', 'string', false, ''], ['trade', 'string', false, '']], run: (s, p) => page(filterBy(s.estimates, p, ['companyId', 'customerId', 'status', 'trade']), p) },
  listInvoices: {
    description: 'List invoices (filters: companyId, customerId, jobId, status, overdue=true).',
    params: [['companyId', 'string', false, ''], ['customerId', 'string', false, ''], ['jobId', 'string', false, ''], ['status', 'string', false, ''], ['overdue', 'boolean', false, '']],
    run(state, p) {
      let list = filterBy(state.invoices, p, ['companyId', 'customerId', 'jobId', 'status']);
      if (p.overdue === true || p.overdue === 'true') list = list.filter((i) => invoiceBalance(i) > 0 && i.dueDate && i.dueDate < state.meta.today);
      return page(list, p);
    },
  },
  listPayments: { description: 'List payments (filters: companyId, customerId, invoiceId, method, status).', params: [['companyId', 'string', false, ''], ['customerId', 'string', false, ''], ['invoiceId', 'string', false, ''], ['method', 'string', false, ''], ['status', 'string', false, '']], run: (s, p) => page(filterBy(s.payments, p, ['companyId', 'customerId', 'invoiceId', 'method', 'status']), p) },
  listNotifications: { description: 'Notification log (filters: companyId, customerId, channel, refType, refId).', params: [['companyId', 'string', false, ''], ['customerId', 'string', false, ''], ['channel', 'string', false, ''], ['refType', 'string', false, ''], ['refId', 'string', false, '']], run: (s, p) => page(filterBy(s.notifications, p, ['companyId', 'customerId', 'channel', 'refType', 'refId']), p) },
  findAvailableTechs: {
    description: 'Technicians free for a slot, nearest first. Pass jobId (uses its trade/company/location/duration) or companyId+trade(+locationId, durationMin).',
    params: [['jobId', 'string', false, ''], ['companyId', 'string', false, ''], ['trade', 'string', false, ''], ['locationId', 'string', false, ''], ['durationMin', 'integer', false, ''], ['date', 'YYYY-MM-DD', true, ''], ['start', 'minutes|"HH:MM"', true, '']],
    run: findAvailableTechs,
  },
  techSchedule: { description: "A technician's booked jobs (optionally for one date).", params: [['techId', 'string', true, ''], ['date', 'YYYY-MM-DD', false, '']], run: techSchedule },
  freeSlots: { description: 'Start times (step minutes, default 30) at which a tech can take a job of durationMin on date.', params: [['techId', 'string', true, ''], ['date', 'YYYY-MM-DD', true, ''], ['durationMin', 'integer', false, ''], ['step', 'integer', false, '']], run: freeSlots },
  priceBook: { description: 'Price-book services (filter: trade).', params: [['trade', 'string', false, '']], run: (s, p) => SERVICES.filter((x) => !p.trade || x.trade === p.trade).map(({ weight, ...rest }) => rest) },
  report: { description: 'KPI report: jobs, revenue, receivables aging, estimate close rate, tech utilization.', params: [['companyId', 'string', false, ''], ['from', 'YYYY-MM-DD', false, 'Default: 30 days ending at to'], ['to', 'YYYY-MM-DD', false, 'Default: today']], run: report },
};
