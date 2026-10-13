// Shared model helpers used by the seed generator, actions and queries.
import { SERVICE_BY_CODE, ZONES, PARTS_CODE } from './catalog.js';
import { TODAY, NOW_MIN, fmtTime } from './util.js';
import { hashSeed } from './prng.js';

export class ActionError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'ActionError';
    this.code = code;
    if (details) this.details = details;
  }
}

export const ID_FORMATS = {
  customer: ['CUS', 5],
  location: ['LOC', 5],
  technician: ['TEC', 3],
  job: ['JOB', 6],
  estimate: ['EST', 5],
  invoice: ['INV', 5],
  payment: ['PAY', 5],
  notification: ['NTF', 5],
};

export const COLLECTION_OF = {
  customer: 'customers',
  location: 'locations',
  technician: 'technicians',
  job: 'jobs',
  estimate: 'estimates',
  invoice: 'invoices',
  payment: 'payments',
  notification: 'notifications',
  company: 'companies',
};

export function nextId(state, kind) {
  const [prefix, width] = ID_FORMATS[kind];
  const n = (state.meta.counters[kind] || 0) + 1;
  state.meta.counters[kind] = n;
  return `${prefix}-${String(n).padStart(width, '0')}`;
}

// id -> entity index cache. Entities are only ever appended (never removed),
// so an index is valid as long as the array length is unchanged.
const indexCache = new WeakMap();
export function byId(state, collection, id) {
  const arr = state[collection];
  if (!arr) return undefined;
  let entry = indexCache.get(arr);
  if (!entry || entry.len !== arr.length) {
    entry = { len: arr.length, map: new Map(arr.map((e) => [e.id, e])) };
    indexCache.set(arr, entry);
  }
  return entry.map.get(id);
}

export function mustGet(state, collection, id, label) {
  if (typeof id !== 'string' || !id) throw new ActionError('INVALID_PARAMS', `${label}Id is required`);
  const e = byId(state, collection, id);
  if (!e) throw new ActionError('NOT_FOUND', `${label} ${id} not found`);
  return e;
}

export function companyOf(state, companyId) {
  return state.companies.find((c) => c.id === companyId);
}

export function computeTotals(items, taxRate) {
  const subtotalCents = items.reduce((a, it) => a + it.qty * it.unitPriceCents, 0);
  const taxCents = Math.round(Math.max(subtotalCents, 0) * taxRate);
  return { subtotalCents, taxCents, totalCents: subtotalCents + taxCents };
}

/**
 * Normalize line items. Accepts price-book items ({code, qty}) — price and
 * description come from the price book — or custom items
 * ({description, qty, unitPriceCents}). Negative custom prices are allowed
 * (discounts).
 */
export function normalizeItems(items, trade) {
  if (!Array.isArray(items) || items.length === 0) throw new ActionError('INVALID_PARAMS', 'items must be a non-empty array');
  return items.map((raw, i) => {
    if (!raw || typeof raw !== 'object') throw new ActionError('INVALID_PARAMS', `items[${i}] must be an object`);
    const qty = raw.qty == null ? 1 : Number(raw.qty);
    if (!Number.isInteger(qty) || qty <= 0) throw new ActionError('INVALID_PARAMS', `items[${i}].qty must be a positive integer`);
    if (raw.code && raw.code !== PARTS_CODE) {
      const svc = SERVICE_BY_CODE[raw.code];
      if (!svc) throw new ActionError('INVALID_PARAMS', `items[${i}].code ${raw.code} is not in the price book`);
      if (trade && svc.trade !== trade) throw new ActionError('INVALID_PARAMS', `items[${i}].code ${raw.code} is a ${svc.trade} service, not ${trade}`);
      return { code: svc.code, description: svc.name, qty, unitPriceCents: raw.unitPriceCents ?? svc.priceCents };
    }
    const description = typeof raw.description === 'string' ? raw.description.trim() : '';
    if (!description) throw new ActionError('INVALID_PARAMS', `items[${i}] needs a price-book code or a description`);
    const price = Number(raw.unitPriceCents);
    if (!Number.isInteger(price)) throw new ActionError('INVALID_PARAMS', `items[${i}].unitPriceCents must be an integer (cents)`);
    return { code: raw.code === PARTS_CODE ? PARTS_CODE : null, description, qty, unitPriceCents: price };
  });
}

/** Default labor duration for a set of line items (sum of price-book durations). */
export function itemsDuration(items) {
  let total = 0;
  for (const it of items) {
    const svc = it.code && SERVICE_BY_CODE[it.code];
    if (svc) total += svc.durationMin * it.qty;
  }
  if (total === 0) total = 60;
  return Math.min(Math.ceil(total / 30) * 30, 540);
}

export function primaryKind(items) {
  for (const it of items) {
    const svc = it.code && SERVICE_BY_CODE[it.code];
    if (svc) return svc.kind;
  }
  return 'service';
}

export function zoneJitter(text, zone) {
  const h = hashSeed(text);
  const c = ZONES[zone];
  const dx = ((h & 0xffff) / 0xffff - 0.5) * 7;
  const dy = (((h >>> 16) & 0xffff) / 0xffff - 0.5) * 7;
  return { x: Math.round((c.x + dx) * 100) / 100, y: Math.round((c.y + dy) * 100) / 100 };
}

export function distance(a, b) {
  return Math.round(Math.hypot(a.x - b.x, a.y - b.y) * 100) / 100;
}

export function techDistance(tech, location) {
  return distance({ x: tech.homeX, y: tech.homeY }, location);
}

/** Jobs that occupy a technician's time (anything with a tech and a slot except canceled). */
export function occupies(job) {
  return job.techId != null && job.date != null && job.status !== 'canceled' && job.status !== 'unscheduled';
}

export function findConflict(state, techId, date, start, end, excludeJobId) {
  for (const j of state.jobs) {
    if (j.techId !== techId || j.date !== date || j.id === excludeJobId || !occupies(j)) continue;
    if (start < j.startMin + j.durationMin && j.startMin < end) return j;
  }
  return null;
}

export function isPastSlot(state, date, start) {
  const today = state.meta.today;
  return date < today || (date === today && start < state.meta.nowMin);
}

/** Returns null when the tech can take the slot, or an ActionError describing why not. */
export function slotProblem(state, tech, job, date, start, durationMin) {
  if (!tech.active) return new ActionError('TECH_INACTIVE', `technician ${tech.id} is inactive`);
  if (tech.companyId !== job.companyId) return new ActionError('WRONG_COMPANY', `technician ${tech.id} works for ${tech.companyId}, job belongs to ${job.companyId}`);
  if (!tech.trades.includes(job.trade)) return new ActionError('TRADE_MISMATCH', `technician ${tech.id} is not qualified for ${job.trade}`);
  if (start < tech.shiftStart || start + durationMin > tech.shiftEnd) {
    return new ActionError('OUTSIDE_SHIFT', `slot ${fmtTime(start)}-${fmtTime(start + durationMin)} is outside ${tech.id}'s shift ${fmtTime(tech.shiftStart)}-${fmtTime(tech.shiftEnd)}`);
  }
  const c = findConflict(state, tech.id, date, start, start + durationMin, job.id);
  if (c) return new ActionError('CONFLICT', `technician ${tech.id} is already booked on ${c.id} ${date} ${fmtTime(c.startMin)}-${fmtTime(c.startMin + c.durationMin)}`, { conflictJobId: c.id });
  return null;
}

export function invoiceBalance(inv) {
  return inv.status === 'void' ? 0 : inv.totalCents - inv.amountPaidCents;
}

/** Recompute amountPaidCents and status from completed payments. */
export function recomputeInvoice(state, inv) {
  const paid = state.payments
    .filter((p) => p.invoiceId === inv.id && p.status === 'completed')
    .reduce((a, p) => a + p.amountCents, 0);
  inv.amountPaidCents = paid;
  if (inv.status === 'void') return inv;
  if (paid >= inv.totalCents && inv.totalCents > 0) inv.status = 'paid';
  else if (paid > 0) inv.status = 'partially_paid';
  else inv.status = inv.sentAt ? 'sent' : 'draft';
  return inv;
}

export function nowStamp(state) {
  return `${state.meta.today}T${fmtTime(state.meta.nowMin)}`;
}

export function emptyState(seed) {
  return {
    meta: { schema: 1, product: 'FieldForge', seed, today: TODAY, nowMin: NOW_MIN, counters: {} },
    companies: [],
    technicians: [],
    customers: [],
    locations: [],
    jobs: [],
    estimates: [],
    invoices: [],
    payments: [],
    notifications: [],
    actionLog: [],
  };
}
