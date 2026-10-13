// Deterministic world generator: same seed => byte-identical state.
import { Rng } from './prng.js';
import {
  TRADES, ZONES, ZONE_NAMES, COMPANY_TEMPLATES, SERVICES, PARTS_CODE, PAYMENT_METHODS,
  FIRST_NAMES, LAST_NAMES, BUSINESS_WORDS, STREETS, STREET_SUFFIXES,
} from './catalog.js';
import { addDays, dayOfWeek, daysBetween, pad } from './util.js';
import { emptyState, nextId, computeTotals, recomputeInvoice, itemsDuration, techDistance } from './model.js';

export const DEFAULT_SEED = 42;
export const SEED_CONFIG = { customers: 1000, daysBack: 120, daysAhead: 14 };

const TRADE_WEIGHTS = [['hvac', 0.45], ['plumbing', 0.3], ['electrical', 0.25]];

export function generateState(seed = DEFAULT_SEED) {
  const rng = new Rng(`fieldforge:${seed}`);
  const state = emptyState(seed);
  const today = state.meta.today;
  const nowMin = state.meta.nowMin;

  // ---- companies ---------------------------------------------------------
  for (const t of COMPANY_TEMPLATES) {
    state.companies.push({
      id: t.id, name: t.name, city: t.city, state: t.state, taxRate: t.taxRate,
      zones: ZONE_NAMES.slice(), phone: `(555) 010-${pad(state.companies.length + 1, 4)}`,
    });
  }

  // ---- technicians -------------------------------------------------------
  const usedNames = new Set();
  const uniqueName = () => {
    for (;;) {
      const n = `${rng.pick(FIRST_NAMES)} ${rng.pick(LAST_NAMES)}`;
      if (!usedNames.has(n)) { usedNames.add(n); return n; }
    }
  };
  const palette = ['#e4572e', '#17bebb', '#ffc914', '#76b041', '#7d5ba6', '#ff8c42', '#2e86ab', '#c3423f', '#5bc0eb', '#9bc53d', '#e55934', '#fa7921', '#3f88c5', '#d1495b'];
  for (const t of COMPANY_TEMPLATES) {
    const primaries = rng.shuffle(Array.from({ length: t.technicians }, (_, i) => TRADES[i % 3]));
    primaries.forEach((primary, i) => {
      const trades = [primary];
      if (rng.chance(0.2)) trades.push(rng.pick(TRADES.filter((x) => x !== primary)));
      const zone = rng.pick(ZONE_NAMES);
      const early = rng.chance(0.3);
      state.technicians.push({
        id: nextId(state, 'technician'),
        companyId: t.id,
        name: uniqueName(),
        trades,
        zone,
        homeX: Math.round((ZONES[zone].x + rng.range(-2, 2)) * 100) / 100,
        homeY: Math.round((ZONES[zone].y + rng.range(-2, 2)) * 100) / 100,
        shiftStart: early ? 420 : 480,
        shiftEnd: early ? 960 : 1020,
        hourlyRateCents: rng.int(30, 52) * 100,
        phone: `(555) 020-${pad(state.technicians.length + 1, 4)}`,
        color: palette[i % palette.length],
        active: true,
      });
    });
  }

  // ---- customers & locations --------------------------------------------
  const companyWeights = COMPANY_TEMPLATES.map((t) => [t.id, t.technicians]);
  const makeAddress = () => `${rng.int(10, 9899)} ${rng.pick(STREETS)} ${rng.pick(STREET_SUFFIXES)}`;
  const locationsByCustomer = new Map();
  for (let i = 0; i < SEED_CONFIG.customers; i++) {
    const companyId = rng.weighted(companyWeights);
    const company = state.companies.find((c) => c.id === companyId);
    const commercial = rng.chance(0.15);
    const first = rng.pick(FIRST_NAMES);
    const last = rng.pick(LAST_NAMES);
    const name = commercial ? `${last} ${rng.pick(BUSINESS_WORDS)}` : `${first} ${last}`;
    const id = nextId(state, 'customer');
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '');
    state.customers.push({
      id,
      companyId,
      name,
      type: commercial ? 'commercial' : 'residential',
      phone: `(${rng.int(201, 989)}) 555-${pad(rng.int(0, 9999), 4)}`,
      email: commercial ? `office@${slug}${i}.example.com` : `${first}.${last}${i}@example.com`.toLowerCase(),
      prefersSms: rng.chance(0.6),
      notes: '',
      createdAt: addDays(today, -rng.int(30, 1200)),
    });
    const nLoc = commercial ? rng.weighted([[1, 0.6], [2, 0.3], [3, 0.1]]) : rng.chance(0.06) ? 2 : 1;
    const locs = [];
    for (let k = 0; k < nLoc; k++) {
      const zone = rng.pick(ZONE_NAMES);
      const loc = {
        id: nextId(state, 'location'),
        customerId: id,
        companyId,
        label: k === 0 ? (commercial ? 'Main site' : 'Home') : commercial ? `Site ${k + 1}` : 'Rental property',
        address: makeAddress(),
        city: company.city,
        zone,
        x: Math.round((ZONES[zone].x + rng.range(-3.5, 3.5)) * 100) / 100,
        y: Math.round((ZONES[zone].y + rng.range(-3.5, 3.5)) * 100) / 100,
      };
      state.locations.push(loc);
      locs.push(loc);
    }
    locationsByCustomer.set(id, locs);
  }

  const customersByCompany = new Map(state.companies.map((c) => [c.id, []]));
  for (const c of state.customers) customersByCompany.get(c.companyId).push(c);
  const techsBy = new Map();
  for (const t of state.technicians) {
    for (const tr of t.trades) {
      const k = `${t.companyId}|${tr}`;
      if (!techsBy.has(k)) techsBy.set(k, []);
      techsBy.get(k).push(t);
    }
  }
  const servicesByTrade = Object.fromEntries(TRADES.map((tr) => [tr, SERVICES.filter((s) => s.trade === tr).map((s) => [s, s.weight])]));
  const taxOf = Object.fromEntries(state.companies.map((c) => [c.id, c.taxRate]));

  // tech|date -> [[start,end], ...]
  const booked = new Map();
  const freeStarts = (tech, date, dur) => {
    const list = booked.get(`${tech.id}|${date}`) || [];
    const out = [];
    for (let s = tech.shiftStart; s + dur <= tech.shiftEnd; s += 30) {
      if (!list.some(([a, b]) => s < b && a < s + dur)) out.push(s);
    }
    return out;
  };
  const book = (tech, date, s, dur) => {
    const k = `${tech.id}|${date}`;
    if (!booked.has(k)) booked.set(k, []);
    booked.get(k).push([s, s + dur]);
  };

  const makeItems = (svc) => {
    const items = [{ code: svc.code, description: svc.name, qty: 1, unitPriceCents: svc.priceCents }];
    if (svc.kind !== 'maintenance' && svc.kind !== 'inspection' && rng.chance(0.35)) {
      items.push({ code: PARTS_CODE, description: 'Materials & parts', qty: 1, unitPriceCents: rng.int(3, 36) * 500 });
    }
    return items;
  };

  const newEstimate = (fields) => {
    const est = {
      id: nextId(state, 'estimate'),
      companyId: fields.companyId,
      customerId: fields.customerId,
      locationId: fields.locationId,
      trade: fields.trade,
      summary: fields.summary,
      items: fields.items,
      ...computeTotals(fields.items, taxOf[fields.companyId]),
      status: fields.status,
      createdAt: fields.createdAt,
      sentAt: fields.sentAt ?? null,
      decidedAt: fields.decidedAt ?? null,
      declineReason: fields.declineReason ?? null,
      jobId: fields.jobId ?? null,
    };
    state.estimates.push(est);
    return est;
  };

  // ---- jobs ----------------------------------------------------------------
  for (let d = -SEED_CONFIG.daysBack; d < SEED_CONFIG.daysAhead; d++) {
    const date = addDays(today, d);
    const dow = dayOfWeek(date);
    if (dow === 0) continue; // closed Sundays
    for (const company of state.companies) {
      const nTech = state.technicians.filter((t) => t.companyId === company.id).length;
      const n = Math.round(nTech * (dow === 6 ? rng.range(0.2, 0.35) : rng.range(1.05, 1.5)));
      const customers = customersByCompany.get(company.id);
      for (let k = 0; k < n; k++) {
        const customer = rng.pick(customers);
        const location = rng.pick(locationsByCustomer.get(customer.id));
        const trade = rng.weighted(TRADE_WEIGHTS);
        const svc = rng.weighted(servicesByTrade[trade]);
        const items = makeItems(svc);
        const durationMin = svc.durationMin;
        const priority = rng.weighted([['emergency', 0.05], ['high', 0.13], ['normal', 0.74], ['low', 0.08]]);
        const job = {
          id: null,
          companyId: company.id,
          customerId: customer.id,
          locationId: location.id,
          trade,
          jobType: svc.kind,
          priority,
          summary: svc.name,
          items,
          durationMin,
          status: 'unscheduled',
          techId: null,
          date: null,
          startMin: null,
          estimateId: null,
          createdAt: addDays(date, -rng.int(0, 10)),
          completedAt: null,
          canceledAt: null,
          cancelReason: null,
          notes: '',
        };
        const backlog = d > 0 && rng.chance(0.1);
        if (!backlog) {
          // prefer closer technicians (weighted), fall back to anyone qualified
          const cands = rng.shuffle(techsBy.get(`${company.id}|${trade}`))
            .sort((a, b) => techDistance(a, location) - techDistance(b, location));
          let placed = false;
          for (const tech of cands) {
            if (rng.chance(0.35)) continue; // spread work around
            const starts = freeStarts(tech, date, durationMin);
            if (starts.length === 0) continue;
            const s = rng.pick(starts);
            book(tech, date, s, durationMin);
            Object.assign(job, { techId: tech.id, date, startMin: s, status: 'scheduled' });
            placed = true;
            break;
          }
          if (!placed && d < 0) continue; // history only contains jobs that happened
        }
        if (job.date && job.createdAt > today) job.createdAt = today;
        if (job.status === 'unscheduled') job.createdAt = addDays(today, -rng.int(0, 12));
        if (job.status === 'scheduled') {
          if (d < 0) {
            if (rng.chance(0.06)) {
              Object.assign(job, { status: 'canceled', canceledAt: addDays(date, -rng.int(0, 2)), cancelReason: rng.pick(['customer request', 'no access', 'rescheduled by customer', 'duplicate']) });
            } else {
              Object.assign(job, { status: 'completed', completedAt: date });
            }
          } else if (d === 0) {
            if (job.startMin + durationMin <= nowMin) Object.assign(job, { status: 'completed', completedAt: date });
            else if (job.startMin <= nowMin) job.status = 'in_progress';
          }
        }
        job.id = nextId(state, 'job');
        if (svc.kind === 'install' && svc.priceCents >= 50000 && rng.chance(0.75)) {
          const created = addDays(job.createdAt, -rng.int(2, 10));
          const est = newEstimate({
            companyId: company.id, customerId: customer.id, locationId: location.id, trade,
            summary: svc.name, items: job.items.map((i) => ({ ...i })), status: 'approved',
            createdAt: created, sentAt: created, decidedAt: job.createdAt, jobId: job.id,
          });
          job.estimateId = est.id;
        }
        state.jobs.push(job);
      }
    }
  }

  // ---- open / historical estimates ----------------------------------------
  const bigServices = SERVICES.filter((s) => s.kind === 'install' || s.priceCents >= 40000);
  for (let i = 0; i < 380; i++) {
    const customer = rng.pick(state.customers);
    const location = rng.pick(locationsByCustomer.get(customer.id));
    const svc = rng.pick(bigServices);
    const items = makeItems(svc);
    if (rng.chance(0.3)) {
      const extra = rng.pick(SERVICES.filter((s) => s.trade === svc.trade && s.priceCents < 40000));
      items.push({ code: extra.code, description: extra.name, qty: 1, unitPriceCents: extra.priceCents });
    }
    const createdAt = addDays(today, -rng.int(0, 75));
    const status = rng.weighted([['draft', 0.14], ['sent', 0.46], ['declined', 0.25], ['approved', 0.15]]);
    const est = newEstimate({
      companyId: customer.companyId, customerId: customer.id, locationId: location.id, trade: svc.trade,
      summary: svc.name, items, status, createdAt,
      sentAt: status === 'draft' ? null : addDays(createdAt, rng.int(0, 1)) > today ? today : addDays(createdAt, rng.int(0, 1)),
    });
    if (status === 'declined') {
      est.decidedAt = addDays(est.sentAt, rng.int(1, 9)) > today ? today : addDays(est.sentAt, rng.int(1, 9));
      est.declineReason = rng.pick(['price too high', 'went with another contractor', 'postponed project', 'no response']);
    } else if (status === 'approved') {
      // approved recently -> job waiting in the unscheduled queue
      est.decidedAt = est.sentAt;
      const job = {
        id: nextId(state, 'job'),
        companyId: est.companyId, customerId: est.customerId, locationId: est.locationId, trade: est.trade,
        jobType: svc.kind, priority: 'normal', summary: est.summary, items: est.items.map((x) => ({ ...x })),
        durationMin: itemsDuration(est.items), status: 'unscheduled', techId: null, date: null, startMin: null,
        estimateId: est.id, createdAt: est.decidedAt, completedAt: null, canceledAt: null, cancelReason: null, notes: '',
      };
      est.jobId = job.id;
      state.jobs.push(job);
    }
  }

  // ---- invoices & payments -------------------------------------------------
  const customerById = new Map(state.customers.map((c) => [c.id, c]));
  for (const job of state.jobs) {
    if (job.status !== 'completed' || !rng.chance(0.97)) continue;
    const customer = customerById.get(job.customerId);
    const age = daysBetween(job.date, today);
    const draft = age <= 2 && rng.chance(0.35);
    const terms = customer.type === 'commercial' ? 30 : 15;
    const inv = {
      id: nextId(state, 'invoice'),
      companyId: job.companyId,
      customerId: job.customerId,
      jobId: job.id,
      items: job.items.map((i) => ({ ...i })),
      ...computeTotals(job.items, taxOf[job.companyId]),
      amountPaidCents: 0,
      status: draft ? 'draft' : 'sent',
      createdAt: job.date,
      sentAt: draft ? null : job.date,
      dueDate: draft ? null : addDays(job.date, terms),
      voidedAt: null,
      voidReason: null,
    };
    state.invoices.push(inv);
    if (draft) continue;
    const r = rng.next();
    const pPaid = age > 60 ? 0.94 : age > 30 ? 0.84 : age > 14 ? 0.62 : 0.38;
    const addPayment = (amountCents) => {
      const date = addDays(inv.sentAt, rng.int(0, Math.min(age, 40)));
      state.payments.push({
        id: nextId(state, 'payment'),
        companyId: inv.companyId,
        customerId: inv.customerId,
        invoiceId: inv.id,
        amountCents,
        method: rng.weighted(PAYMENT_METHODS.map((m, i) => [m, [0.55, 0.2, 0.1, 0.15][i]])),
        date,
        status: 'completed',
        refundedAt: null,
        note: '',
      });
    };
    if (r < pPaid) addPayment(inv.totalCents);
    else if (r < pPaid + 0.05) addPayment(Math.round(inv.totalCents * rng.range(0.3, 0.7)));
    else if (r < pPaid + 0.07) {
      inv.status = 'void';
      inv.voidedAt = addDays(inv.sentAt, rng.int(0, Math.min(age, 10)));
      inv.voidReason = rng.pick(['billing error', 'warranty work', 'duplicate']);
    }
    recomputeInvoice(state, inv);
  }

  return state;
}
