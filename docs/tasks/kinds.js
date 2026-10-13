// Task kinds: each kind knows how to pick concrete entities from a seeded
// world (candidates), phrase the instruction (prompt), solve it through the
// public API (reference solution) and verify the resulting state (check).
//
// check(final, initial, params) returns a list of failure reasons; [] = pass.
import {
  TRADE_LABELS, SERVICE_BY_CODE, SERVICES, FIRST_NAMES, LAST_NAMES, STREETS, STREET_SUFFIXES,
  byId, techDistance, findAvailableTechs, validateState, invoiceBalance, itemsDuration, fmtTime, fmtMoney,
  addDays, dayOfWeek, isPastSlot, slotProblem, computeTotals, BUSINESS_WORDS, PARTS_CODE,
} from '../core/index.js';

// ---- helpers -----------------------------------------------------------------
const created = (initial, final, coll) => {
  const ids = new Set(initial[coll].map((e) => e.id));
  return final[coll].filter((e) => !ids.has(e.id));
};
const get = (s, coll, id) => byId(s, coll, id);
const nextWorkday = (date, n = 1) => {
  let d = addDays(date, n);
  while (dayOfWeek(d) === 0) d = addDays(d, 1);
  return d;
};
function checker() {
  const reasons = [];
  return { reasons, need(cond, msg) { if (!cond) reasons.push(msg); return Boolean(cond); } };
}
function integrity(c, final) {
  const problems = validateState(final);
  c.need(problems.length === 0, `state invariants violated: ${problems.slice(0, 3).join('; ')}`);
}
function describeJob(s, job) {
  const cust = get(s, 'customers', job.customerId);
  const loc = get(s, 'locations', job.locationId);
  const tech = job.techId ? get(s, 'technicians', job.techId) : null;
  const when = job.date ? `, scheduled ${job.date} ${fmtTime(job.startMin)}${tech ? ` with ${tech.name} (${tech.id})` : ''}` : '';
  return `${job.id} (${TRADE_LABELS[job.trade]}: "${job.summary}" for ${cust.name} at ${loc.address}${when})`;
}
function newNotes(initial, final, filter) {
  return created(initial, final, 'notifications').filter(filter);
}
const minDistance = (list) => (list.length ? Math.min(...list.map((t) => t.distance)) : null);
const futureScheduled = (s) => s.jobs.filter((j) => j.status === 'scheduled' && !isPastSlot(s, j.date, j.startMin));
const custName = (s, id) => get(s, 'customers', id).name;

// ---- kinds ---------------------------------------------------------------------
export const KINDS = {
  reassign_nearest: {
    title: 'Reassign a job to the nearest free qualified technician and notify by SMS',
    candidates(s, rng, v) {
      return rng.shuffle(futureScheduled(s).filter((j) => j.trade === v.trade)).map((j) => ({ jobId: j.id, fromTechId: j.techId }));
    },
    feasible(s, p) {
      const j = get(s, 'jobs', p.jobId);
      return findAvailableTechs(s, { jobId: j.id, date: j.date, start: j.startMin }).filter((t) => t.techId !== p.fromTechId).length > 0;
    },
    prompt(s, p) {
      const j = get(s, 'jobs', p.jobId);
      const t = get(s, 'technicians', p.fromTechId);
      return `Technician ${t.name} (${t.id}) can no longer make job ${describeJob(s, j)}. Reassign the job to the nearest available ${TRADE_LABELS[j.trade]} technician other than ${t.name} — nearest means the shortest distance from the technician's home base to the job location — keeping the same date and start time. Then notify the customer of the change by SMS.`;
    },
    solve(env, p) {
      const j = get(env.state, 'jobs', p.jobId);
      const best = env.query('findAvailableTechs', { jobId: j.id, date: j.date, start: j.startMin }).filter((t) => t.techId !== p.fromTechId)[0];
      env.act('scheduleJob', { jobId: j.id, techId: best.techId, date: j.date, start: j.startMin, notify: 'sms' });
    },
    check(final, initial, p) {
      const c = checker();
      const j0 = get(initial, 'jobs', p.jobId);
      const j = get(final, 'jobs', p.jobId);
      const avail = findAvailableTechs(initial, { jobId: j0.id, date: j0.date, start: j0.startMin }).filter((t) => t.techId !== p.fromTechId);
      c.need(j.status === 'scheduled', `job should be scheduled, is ${j.status}`);
      c.need(j.techId && j.techId !== p.fromTechId, 'job must move to a different technician');
      c.need(j.date === j0.date && j.startMin === j0.startMin, 'date and start time must not change');
      const tech = j.techId && get(final, 'technicians', j.techId);
      if (tech) c.need(techDistance(tech, get(final, 'locations', j.locationId)) === minDistance(avail), `assigned ${tech.id} is not the nearest available technician`);
      c.need(newNotes(initial, final, (n) => n.customerId === j.customerId && n.channel === 'sms' && n.refId === j.id).length > 0, 'customer was not notified by SMS about the job');
      integrity(c, final);
      return c.reasons;
    },
  },

  create_estimate: {
    title: 'Create and send an estimate from price-book items',
    candidates(s, rng, v) {
      const big = SERVICES.filter((x) => x.trade === v.trade && x.priceCents >= 40000);
      const small = SERVICES.filter((x) => x.trade === v.trade && x.priceCents < 40000 && x.kind !== 'service');
      return rng.shuffle(s.customers).slice(0, 20).map((cu) => {
        const loc = rng.pick(s.locations.filter((l) => l.customerId === cu.id));
        return { customerId: cu.id, locationId: loc.id, trade: v.trade, items: [{ code: rng.pick(big).code, qty: 1 }, { code: rng.pick(small).code, qty: rng.int(1, 3) }] };
      });
    },
    prompt(s, p) {
      const cu = get(s, 'customers', p.customerId);
      const loc = get(s, 'locations', p.locationId);
      const list = p.items.map((i) => `${i.qty} x ${SERVICE_BY_CODE[i.code].name} [${i.code}]`).join(' and ');
      return `Customer ${cu.name} (${cu.id}) asked for a ${TRADE_LABELS[p.trade]} quote at their location ${loc.address} (${loc.id}): ${list}. Create an estimate for that location using standard price-book pricing and send it to the customer.`;
    },
    solve(env, p) {
      const { estimate } = env.act('createEstimate', { customerId: p.customerId, locationId: p.locationId, trade: p.trade, items: p.items });
      env.act('sendEstimate', { estimateId: estimate.id });
    },
    check(final, initial, p) {
      const c = checker();
      const ests = created(initial, final, 'estimates').filter((e) => e.customerId === p.customerId);
      if (!c.need(ests.length === 1, `expected exactly 1 new estimate for ${p.customerId}, found ${ests.length}`)) return c.reasons;
      const e = ests[0];
      c.need(e.locationId === p.locationId, 'estimate is for the wrong location');
      c.need(e.trade === p.trade, 'estimate has the wrong trade');
      c.need(e.status === 'sent', `estimate should be sent, is ${e.status}`);
      const want = p.items.map((i) => `${i.code}x${i.qty}@${SERVICE_BY_CODE[i.code].priceCents}`).sort().join(',');
      const got = e.items.map((i) => `${i.code}x${i.qty}@${i.unitPriceCents}`).sort().join(',');
      c.need(want === got, `line items mismatch: want ${want}, got ${got}`);
      integrity(c, final);
      return c.reasons;
    },
  },

  collect_full_payment: {
    title: 'Record a full payment on an open invoice',
    candidates(s, rng, v) {
      return rng.shuffle(s.invoices.filter((i) => i.status === 'sent' && i.amountPaidCents === 0)).map((i) => ({ invoiceId: i.id, method: v.method }));
    },
    prompt(s, p) {
      const i = get(s, 'invoices', p.invoiceId);
      const how = { check: 'mailed a check', card: 'paid by credit card over the phone' }[p.method];
      return `${custName(s, i.customerId)} (${i.customerId}) ${how} for the full balance of invoice ${i.id} (${fmtMoney(invoiceBalance(i))}). Record the payment with method "${p.method}".`;
    },
    solve(env, p) {
      const i = get(env.state, 'invoices', p.invoiceId);
      env.act('recordPayment', { invoiceId: i.id, amountCents: invoiceBalance(i), method: p.method });
    },
    check(final, initial, p) {
      const c = checker();
      const i0 = get(initial, 'invoices', p.invoiceId);
      const i = get(final, 'invoices', p.invoiceId);
      c.need(i.status === 'paid', `invoice should be paid, is ${i.status}`);
      const pays = created(initial, final, 'payments');
      c.need(pays.length === 1 && pays[0].invoiceId === i.id, `expected exactly one new payment on ${i.id}`);
      if (pays[0]) {
        c.need(pays[0].method === p.method, `payment method should be ${p.method}`);
        c.need(pays[0].amountCents === invoiceBalance(i0), 'payment amount must equal the open balance');
      }
      integrity(c, final);
      return c.reasons;
    },
  },

  void_invoice: {
    title: 'Void an invoice issued in error',
    candidates(s, rng) {
      return rng.shuffle(s.invoices.filter((i) => (i.status === 'sent' || i.status === 'draft') && i.amountPaidCents === 0)).map((i) => ({ invoiceId: i.id }));
    },
    prompt(s, p) {
      const i = get(s, 'invoices', p.invoiceId);
      return `Invoice ${i.id} (${fmtMoney(i.totalCents)}, ${custName(s, i.customerId)}) was issued in error — the work was covered under warranty. Void the invoice with reason "warranty". Do not touch any other invoice.`;
    },
    solve(env, p) { env.act('voidInvoice', { invoiceId: p.invoiceId, reason: 'warranty' }); },
    check(final, initial, p) {
      const c = checker();
      const i = get(final, 'invoices', p.invoiceId);
      c.need(i.status === 'void', `invoice should be void, is ${i.status}`);
      c.need(/warranty/i.test(i.voidReason || ''), 'void reason should mention warranty');
      const changed = final.invoices.filter((x) => x.id !== i.id && get(initial, 'invoices', x.id) && get(initial, 'invoices', x.id).status !== x.status);
      c.need(changed.length === 0, `other invoices changed status: ${changed.map((x) => x.id).join(', ')}`);
      integrity(c, final);
      return c.reasons;
    },
  },

  approve_and_schedule: {
    title: 'Approve an estimate and schedule the resulting job with the nearest free technician',
    candidates(s, rng) {
      const today = s.meta.today;
      return rng.shuffle(s.estimates.filter((e) => e.status === 'sent')).map((e) => ({ estimateId: e.id, date: nextWorkday(today, rng.int(2, 6)), start: 540 }));
    },
    feasible(s, p) { return availableForEstimate(s, p).length > 0; },
    prompt(s, p) {
      const e = get(s, 'estimates', p.estimateId);
      return `${custName(s, e.customerId)} (${e.customerId}) approved estimate ${e.id} ("${e.summary}", ${fmtMoney(e.totalCents)}). Mark the estimate approved, then schedule the resulting job on ${p.date} at ${fmtTime(p.start)} with the nearest available qualified technician (shortest distance from the technician's home base to the job location).`;
    },
    solve(env, p) {
      const { job } = env.act('approveEstimate', { estimateId: p.estimateId });
      const best = env.query('findAvailableTechs', { jobId: job.id, date: p.date, start: p.start })[0];
      env.act('scheduleJob', { jobId: job.id, techId: best.techId, date: p.date, start: p.start });
    },
    check(final, initial, p) {
      const c = checker();
      const e = get(final, 'estimates', p.estimateId);
      if (!c.need(e.status === 'approved' && e.jobId, 'estimate should be approved with a linked job')) return c.reasons;
      const j = get(final, 'jobs', e.jobId);
      c.need(j.status === 'scheduled' && j.date === p.date && j.startMin === p.start, `job ${j.id} should be scheduled ${p.date} ${fmtTime(p.start)}`);
      const avail = availableForEstimate(initial, p);
      if (j.techId) c.need(techDistance(get(final, 'technicians', j.techId), get(final, 'locations', j.locationId)) === minDistance(avail), `technician ${j.techId} is not the nearest available`);
      integrity(c, final);
      return c.reasons;
    },
  },

  complete_and_invoice: {
    title: 'Complete an in-progress job, invoice it and send the invoice',
    candidates(s, rng) {
      return rng.shuffle(s.jobs.filter((j) => j.status === 'in_progress')).map((j) => ({ jobId: j.id }));
    },
    prompt(s, p) {
      const j = get(s, 'jobs', p.jobId);
      return `The technician just finished job ${describeJob(s, j)}. Mark the job completed, create an invoice from the job's line items, and send the invoice to the customer.`;
    },
    solve(env, p) {
      env.act('completeJob', { jobId: p.jobId });
      const { invoice } = env.act('createInvoice', { jobId: p.jobId });
      env.act('sendInvoice', { invoiceId: invoice.id });
    },
    check(final, initial, p) {
      const c = checker();
      const j = get(final, 'jobs', p.jobId);
      c.need(j.status === 'completed', `job should be completed, is ${j.status}`);
      const invs = final.invoices.filter((i) => i.jobId === j.id && i.status !== 'void');
      if (!c.need(invs.length === 1, `expected one invoice for ${j.id}, found ${invs.length}`)) return c.reasons;
      const inv = invs[0];
      c.need(inv.status === 'sent', `invoice should be sent, is ${inv.status}`);
      const sub = j.items.reduce((a, it) => a + it.qty * it.unitPriceCents, 0);
      c.need(inv.subtotalCents === sub, 'invoice subtotal must match the job line items');
      integrity(c, final);
      return c.reasons;
    },
  },

  new_customer_job: {
    title: 'Create a new customer and book a job',
    candidates(s, rng) {
      const today = s.meta.today;
      return Array.from({ length: 10 }, () => {
        const first = rng.pick(FIRST_NAMES);
        const last = rng.pick(LAST_NAMES);
        const svc = rng.pick(SERVICES.filter((x) => x.kind === 'repair' && x.durationMin <= 90));
        return {
          companyId: rng.pick(s.companies).id,
          name: `${first} ${last}`,
          phone: `(555) 7${rng.int(10, 99)}-${String(rng.int(0, 9999)).padStart(4, '0')}`,
          email: `${first}.${last}@example.net`.toLowerCase(),
          address: `${rng.int(100, 999)} ${rng.pick(STREETS)} ${rng.pick(STREET_SUFFIXES)}`,
          zone: rng.pick(['North', 'South', 'East', 'West', 'Central']),
          trade: svc.trade,
          serviceCode: svc.code,
          date: nextWorkday(today, 1),
          start: 13 * 60,
        };
      });
    },
    feasible(s, p) {
      return findAvailableTechs(s, { companyId: p.companyId, trade: p.trade, durationMin: SERVICE_BY_CODE[p.serviceCode].durationMin, date: p.date, start: p.start }).length > 0;
    },
    prompt(s, p) {
      const co = s.companies.find((x) => x.id === p.companyId);
      return `New residential customer for ${co.name} (${co.id}): ${p.name}, phone ${p.phone}, email ${p.email}, address ${p.address} (${p.zone} zone). Create the customer, then book a "${SERVICE_BY_CODE[p.serviceCode].name}" job (price-book code ${p.serviceCode}) at that address on ${p.date} at ${fmtTime(p.start)} with any available qualified technician.`;
    },
    solve(env, p) {
      const { customer, location } = env.act('createCustomer', { companyId: p.companyId, name: p.name, phone: p.phone, email: p.email, address: p.address, zone: p.zone });
      const tech = env.query('findAvailableTechs', { companyId: p.companyId, trade: p.trade, locationId: location.id, durationMin: SERVICE_BY_CODE[p.serviceCode].durationMin, date: p.date, start: p.start })[0];
      env.act('createJob', { customerId: customer.id, trade: p.trade, serviceCode: p.serviceCode, techId: tech.techId, date: p.date, start: p.start });
    },
    check(final, initial, p) {
      const c = checker();
      const custs = created(initial, final, 'customers').filter((x) => x.name.trim().toLowerCase() === p.name.toLowerCase() && x.companyId === p.companyId);
      if (!c.need(custs.length === 1, `expected one new customer named ${p.name} in ${p.companyId}`)) return c.reasons;
      const cu = custs[0];
      c.need(cu.phone.replace(/\D/g, '') === p.phone.replace(/\D/g, ''), 'phone does not match');
      c.need(cu.email.toLowerCase() === p.email, 'email does not match');
      const loc = final.locations.find((l) => l.customerId === cu.id && l.address.toLowerCase() === p.address.toLowerCase());
      c.need(loc && loc.zone === p.zone, 'location with the given address/zone not found');
      const jobs = final.jobs.filter((j) => j.customerId === cu.id && j.items.some((i) => i.code === p.serviceCode));
      if (c.need(jobs.length === 1, `expected one ${p.serviceCode} job for the new customer`)) {
        const j = jobs[0];
        c.need(j.status === 'scheduled' && j.date === p.date && j.startMin === p.start, `job should be scheduled ${p.date} ${fmtTime(p.start)}`);
        c.need(loc && j.locationId === loc.id, 'job should be at the new location');
      }
      integrity(c, final);
      return c.reasons;
    },
  },

  partial_payment: {
    title: 'Record a partial cash payment',
    candidates(s, rng) {
      return rng.shuffle(s.invoices.filter((i) => i.status === 'sent' && i.amountPaidCents === 0 && i.totalCents > 30000))
        .map((i) => ({ invoiceId: i.id, amountCents: Math.floor(i.totalCents / 200) * 100 }));
    },
    prompt(s, p) {
      const i = get(s, 'invoices', p.invoiceId);
      return `${custName(s, i.customerId)} handed the technician ${fmtMoney(p.amountCents)} in cash toward invoice ${i.id} (total ${fmtMoney(i.totalCents)}). Record the cash payment; the remaining balance stays open.`;
    },
    solve(env, p) { env.act('recordPayment', { invoiceId: p.invoiceId, amountCents: p.amountCents, method: 'cash' }); },
    check(final, initial, p) {
      const c = checker();
      const i = get(final, 'invoices', p.invoiceId);
      const pays = created(initial, final, 'payments');
      c.need(pays.length === 1 && pays[0].invoiceId === i.id && pays[0].method === 'cash' && pays[0].amountCents === p.amountCents, `expected one cash payment of ${p.amountCents} cents on ${i.id}`);
      c.need(i.status === 'partially_paid' && i.amountPaidCents === p.amountCents, `invoice should be partially_paid with ${p.amountCents} paid`);
      integrity(c, final);
      return c.reasons;
    },
  },

  cancel_and_notify: {
    title: 'Cancel a job and email the customer',
    candidates(s, rng) { return rng.shuffle(futureScheduled(s)).map((j) => ({ jobId: j.id })); },
    prompt(s, p) {
      const j = get(s, 'jobs', p.jobId);
      return `${custName(s, j.customerId)} called to cancel job ${describeJob(s, j)}. Cancel the job with reason "customer request" and send the customer a cancellation confirmation by email.`;
    },
    solve(env, p) { env.act('cancelJob', { jobId: p.jobId, reason: 'customer request', notify: 'email' }); },
    check(final, initial, p) {
      const c = checker();
      const j = get(final, 'jobs', p.jobId);
      c.need(j.status === 'canceled', `job should be canceled, is ${j.status}`);
      c.need(newNotes(initial, final, (n) => n.customerId === j.customerId && n.channel === 'email' && n.refId === j.id).length > 0, 'no cancellation email referencing the job');
      integrity(c, final);
      return c.reasons;
    },
  },

  refund_payment: {
    title: 'Refund a payment',
    candidates(s, rng) {
      const since = addDays(s.meta.today, -30);
      return rng.shuffle(s.payments.filter((x) => x.status === 'completed' && x.date >= since && get(s, 'invoices', x.invoiceId).status === 'paid')).map((x) => ({ paymentId: x.id }));
    },
    prompt(s, p) {
      const x = get(s, 'payments', p.paymentId);
      return `Payment ${x.id} (${fmtMoney(x.amountCents)} by ${x.method} on ${x.date}) from ${custName(s, x.customerId)} toward invoice ${x.invoiceId} was charged by mistake. Refund the payment so the invoice balance reopens.`;
    },
    solve(env, p) { env.act('refundPayment', { paymentId: p.paymentId, reason: 'charged by mistake' }); },
    check(final, initial, p) {
      const c = checker();
      const x = get(final, 'payments', p.paymentId);
      c.need(x.status === 'refunded', `payment should be refunded, is ${x.status}`);
      const i = get(final, 'invoices', x.invoiceId);
      c.need(i.status !== 'paid' && i.amountPaidCents === get(initial, 'invoices', x.invoiceId).amountPaidCents - x.amountCents, 'invoice balance did not reopen by the payment amount');
      c.need(created(initial, final, 'payments').length === 0, 'no new payments should be recorded');
      integrity(c, final);
      return c.reasons;
    },
  },

  decline_estimate: {
    title: 'Record an estimate decline',
    candidates(s, rng) { return rng.shuffle(s.estimates.filter((e) => e.status === 'sent')).map((e) => ({ estimateId: e.id })); },
    prompt(s, p) {
      const e = get(s, 'estimates', p.estimateId);
      return `${custName(s, e.customerId)} decided not to go ahead with estimate ${e.id} ("${e.summary}", ${fmtMoney(e.totalCents)}) because the price is too high. Record the decline with reason "price too high". Do not create a job.`;
    },
    solve(env, p) { env.act('declineEstimate', { estimateId: p.estimateId, reason: 'price too high' }); },
    check(final, initial, p) {
      const c = checker();
      const e = get(final, 'estimates', p.estimateId);
      c.need(e.status === 'declined', `estimate should be declined, is ${e.status}`);
      c.need(/price/i.test(e.declineReason || ''), 'decline reason should mention price');
      c.need(!final.jobs.some((j) => j.estimateId === e.id), 'no job should exist for the estimate');
      integrity(c, final);
      return c.reasons;
    },
  },

  emergency_dispatch: {
    title: 'Create an emergency job and dispatch the nearest free technician',
    candidates(s, rng, v) {
      return rng.shuffle(s.customers).slice(0, 30).map((cu) => {
        const loc = rng.pick(s.locations.filter((l) => l.customerId === cu.id));
        return { customerId: cu.id, locationId: loc.id, trade: v.trade, serviceCode: v.serviceCode, issue: v.issue, date: s.meta.today, start: v.start };
      });
    },
    feasible(s, p) { return emergencyAvail(s, p).length > 0; },
    prompt(s, p) {
      const loc = get(s, 'locations', p.locationId);
      return `EMERGENCY: ${custName(s, p.customerId)} (${p.customerId}) reports ${p.issue} at ${loc.address} (${loc.id}). Create an emergency-priority ${TRADE_LABELS[p.trade]} job at that location using price-book service ${p.serviceCode}, assign it today (${p.date}) at ${fmtTime(p.start)} to the nearest available qualified technician, and text (SMS) the customer a confirmation.`;
    },
    solve(env, p) {
      const best = env.query('findAvailableTechs', { companyId: get(env.state, 'customers', p.customerId).companyId, trade: p.trade, locationId: p.locationId, durationMin: SERVICE_BY_CODE[p.serviceCode].durationMin, date: p.date, start: p.start })[0];
      env.act('createJob', { customerId: p.customerId, locationId: p.locationId, trade: p.trade, serviceCode: p.serviceCode, priority: 'emergency', techId: best.techId, date: p.date, start: p.start, notify: 'sms' });
    },
    check(final, initial, p) {
      const c = checker();
      const jobs = created(initial, final, 'jobs').filter((j) => j.customerId === p.customerId);
      if (!c.need(jobs.length === 1, `expected one new job for ${p.customerId}, found ${jobs.length}`)) return c.reasons;
      const j = jobs[0];
      c.need(j.priority === 'emergency', 'job priority should be emergency');
      c.need(j.trade === p.trade && j.items.some((i) => i.code === p.serviceCode), `job should be ${p.trade} with item ${p.serviceCode}`);
      c.need(j.locationId === p.locationId, 'job is at the wrong location');
      c.need(j.status === 'scheduled' && j.date === p.date && j.startMin === p.start, `job should be scheduled ${p.date} ${fmtTime(p.start)}`);
      if (j.techId) c.need(techDistance(get(final, 'technicians', j.techId), get(final, 'locations', p.locationId)) === minDistance(emergencyAvail(initial, p)), `technician ${j.techId} is not the nearest available`);
      c.need(newNotes(initial, final, (n) => n.customerId === p.customerId && n.channel === 'sms' && n.refId === j.id).length > 0, 'customer was not sent an SMS about the job');
      integrity(c, final);
      return c.reasons;
    },
  },

  earliest_slot: {
    title: 'Schedule a queued job at the earliest possible time on a date',
    candidates(s, rng) {
      const date = nextWorkday(s.meta.today, 1);
      return rng.shuffle(s.jobs.filter((j) => j.status === 'unscheduled')).map((j) => ({ jobId: j.id, date }));
    },
    feasible(s, p) { return earliestOptions(s, p).techs.length > 0; },
    prompt(s, p) {
      const j = get(s, 'jobs', p.jobId);
      return `Job ${describeJob(s, j)} is waiting in the unscheduled queue. Schedule it on ${p.date} at the earliest possible start time on the half-hour grid (07:00, 07:30, 08:00, ...) with any qualified technician who is free for the job's full duration. If several technicians are free at that earliest time, choose the nearest one to the job location.`;
    },
    solve(env, p) {
      const { start, techs } = earliestOptions(env.state, p);
      env.act('scheduleJob', { jobId: p.jobId, techId: techs[0].techId, date: p.date, start });
    },
    check(final, initial, p) {
      const c = checker();
      const j = get(final, 'jobs', p.jobId);
      const { start, techs } = earliestOptions(initial, p);
      c.need(j.status === 'scheduled' && j.date === p.date, `job should be scheduled on ${p.date}`);
      c.need(j.startMin === start, `start should be the earliest feasible time ${fmtTime(start)}, got ${fmtTime(j.startMin)}`);
      c.need(techs.filter((t) => t.distance === techs[0].distance).some((t) => t.techId === j.techId), 'technician is not the nearest of those free at the earliest time');
      integrity(c, final);
      return c.reasons;
    },
  },

  tech_out_day: {
    title: 'Technician out sick: redistribute a day of jobs',
    candidates(s, rng) {
      const by = new Map();
      for (const j of futureScheduled(s)) {
        if (j.date <= s.meta.today) continue;
        const k = `${j.techId}|${j.date}`;
        by.set(k, (by.get(k) || 0) + 1);
      }
      return rng.shuffle([...by].filter(([, n]) => n >= 2 && n <= 4).map(([k]) => k)).map((k) => { const [techId, date] = k.split('|'); return { techId, date }; });
    },
    prompt(s, p) {
      const t = get(s, 'technicians', p.techId);
      return `Technician ${t.name} (${t.id}) called in sick for ${p.date}. Every job assigned to them that day must be handed to another qualified technician at the same start time — pick the nearest available one (distance from home base to the job location). If no qualified technician is free at that time, unschedule the job so it goes back to the queue. Send every affected customer an SMS about the change.`;
    },
    solve(env, p) {
      const jobs = env.query('techSchedule', { techId: p.techId, date: p.date }).jobs.filter((j) => j.status === 'scheduled');
      for (const j of jobs) {
        const best = env.query('findAvailableTechs', { jobId: j.id, date: j.date, start: j.startMin }).filter((t) => t.techId !== p.techId)[0];
        if (best) env.act('scheduleJob', { jobId: j.id, techId: best.techId, date: j.date, start: j.startMin, notify: 'sms' });
        else {
          env.act('unscheduleJob', { jobId: j.id });
          env.act('notifyCustomer', { customerId: j.customerId, channel: 'sms', refType: 'job', refId: j.id, message: `Your appointment ${j.id} on ${j.date} needs to be rescheduled; we will call you with a new time.` });
        }
      }
    },
    check(final, initial, p) {
      const c = checker();
      const affected = initial.jobs.filter((j) => j.techId === p.techId && j.date === p.date && j.status === 'scheduled');
      for (const j0 of affected) {
        const j = get(final, 'jobs', j0.id);
        if (j.status === 'scheduled') {
          if (!c.need(j.techId !== p.techId, `${j.id} is still assigned to ${p.techId}`)) continue;
          c.need(j.date === j0.date && j.startMin === j0.startMin, `${j.id} must keep its date and start time`);
          const mine = techDistance(get(final, 'technicians', j.techId), get(final, 'locations', j.locationId));
          const closer = findAvailableTechs(final, { jobId: j.id, date: j.date, start: j.startMin }).filter((t) => t.techId !== p.techId && t.distance < mine);
          c.need(closer.length === 0, `${j.id}: ${closer[0]?.techId} is nearer and free`);
        } else if (j.status === 'unscheduled') {
          const free = findAvailableTechs(final, { jobId: j.id, date: j0.date, start: j0.startMin }).filter((t) => t.techId !== p.techId);
          c.need(free.length === 0, `${j.id} was unscheduled although ${free[0]?.techId} is free`);
        } else c.reasons.push(`${j.id} should be reassigned or unscheduled, not ${j.status}`);
        c.need(newNotes(initial, final, (n) => n.customerId === j.customerId && n.channel === 'sms').length > 0, `customer of ${j.id} was not sent an SMS`);
      }
      integrity(c, final);
      return c.reasons;
    },
  },

  add_location_job: {
    title: 'Add a customer location and create a job there',
    candidates(s, rng) {
      return rng.shuffle(s.customers.filter((cu) => cu.type === 'commercial')).slice(0, 10).map((cu) => {
        const svc = rng.pick(SERVICES.filter((x) => x.kind === 'maintenance' || x.kind === 'inspection'));
        return { customerId: cu.id, address: `${rng.int(1000, 9999)} ${rng.pick(STREETS)} ${rng.pick(STREET_SUFFIXES)}`, zone: rng.pick(['North', 'South', 'East', 'West', 'Central']), trade: svc.trade, serviceCode: svc.code };
      });
    },
    prompt(s, p) {
      return `Commercial customer ${custName(s, p.customerId)} (${p.customerId}) opened a new site at ${p.address} (${p.zone} zone). Add it as a new service location on their account, then create an unscheduled ${TRADE_LABELS[p.trade]} job at the new location for "${SERVICE_BY_CODE[p.serviceCode].name}" (price-book code ${p.serviceCode}). Do not schedule it yet.`;
    },
    solve(env, p) {
      const { location } = env.act('addLocation', { customerId: p.customerId, address: p.address, zone: p.zone, label: 'New site' });
      env.act('createJob', { customerId: p.customerId, locationId: location.id, trade: p.trade, serviceCode: p.serviceCode });
    },
    check(final, initial, p) {
      const c = checker();
      const locs = created(initial, final, 'locations').filter((l) => l.customerId === p.customerId && l.address.trim().toLowerCase() === p.address.toLowerCase());
      if (!c.need(locs.length === 1, 'expected exactly one new location with that address')) return c.reasons;
      c.need(locs[0].zone === p.zone, `location zone should be ${p.zone}`);
      const jobs = created(initial, final, 'jobs').filter((j) => j.locationId === locs[0].id);
      if (c.need(jobs.length === 1, 'expected one new job at the new location')) {
        c.need(jobs[0].items.some((i) => i.code === p.serviceCode), `job should include ${p.serviceCode}`);
        c.need(jobs[0].status === 'unscheduled', 'job should stay unscheduled');
      }
      integrity(c, final);
      return c.reasons;
    },
  },

  overdue_reminders: {
    title: 'Email payment reminders for invoices overdue past a cutoff',
    candidates(s, rng) {
      return rng.shuffle(s.companies.flatMap((co) => [45, 60].map((days) => ({ companyId: co.id, days }))));
    },
    feasible(s, p) { const n = overdueSet(s, p).length; return n >= 3 && n <= 25; },
    prompt(s, p) {
      const co = s.companies.find((x) => x.id === p.companyId);
      return `For ${co.name} (${co.id}): send an email payment reminder for every unpaid or partially paid invoice whose due date is more than ${p.days} days before today (${s.meta.today}), i.e. due before ${addDays(s.meta.today, -p.days)}. Send one email per such invoice to the invoice's customer, referencing the invoice (refType "invoice", refId = invoice id). Do not message anyone else and do not change the invoices.`;
    },
    solve(env, p) {
      for (const i of overdueSet(env.state, p)) {
        env.act('notifyCustomer', { customerId: i.customerId, channel: 'email', refType: 'invoice', refId: i.id, template: 'payment_reminder', message: `Reminder: invoice ${i.id} has an open balance of ${fmtMoney(invoiceBalance(i))}, due ${i.dueDate}.` });
      }
    },
    check(final, initial, p) {
      const c = checker();
      const want = overdueSet(initial, p).map((i) => i.id).sort();
      const notes = created(initial, final, 'notifications');
      const got = [...new Set(notes.filter((n) => n.channel === 'email' && n.refType === 'invoice').map((n) => n.refId))].sort();
      c.need(JSON.stringify(want) === JSON.stringify(got), `reminded invoices ${got.length} != expected ${want.length} (missing: ${want.filter((x) => !got.includes(x)).slice(0, 5).join(',')}; extra: ${got.filter((x) => !want.includes(x)).slice(0, 5).join(',')})`);
      const wantCust = new Set(want.map((id) => get(initial, 'invoices', id).customerId));
      c.need(notes.every((n) => wantCust.has(n.customerId)), 'messages were sent to customers without qualifying invoices');
      c.need(final.invoices.every((i) => get(initial, 'invoices', i.id)?.status === i.status), 'invoice statuses must not change');
      integrity(c, final);
      return c.reasons;
    },
  },

  discount_estimate: {
    title: 'Apply a percentage discount line to an estimate and resend',
    candidates(s, rng) { return rng.shuffle(s.estimates.filter((e) => e.status === 'sent' || e.status === 'draft')).map((e) => ({ estimateId: e.id, pct: 10 })); },
    prompt(s, p) {
      const e = get(s, 'estimates', p.estimateId);
      return `Apply a ${p.pct}% courtesy discount to estimate ${e.id} for ${custName(s, e.customerId)} (current subtotal ${fmtMoney(e.subtotalCents)}): keep all existing line items and add one line item "Courtesy discount", qty 1, with a negative unit price equal to ${p.pct}% of the current subtotal (rounded to the nearest cent). Then send the estimate to the customer again.`;
    },
    solve(env, p) {
      const e = get(env.state, 'estimates', p.estimateId);
      const items = e.items.map((i) => (i.code && i.code !== 'PARTS' ? { code: i.code, qty: i.qty, unitPriceCents: i.unitPriceCents } : { code: i.code, description: i.description, qty: i.qty, unitPriceCents: i.unitPriceCents }));
      items.push({ description: 'Courtesy discount', qty: 1, unitPriceCents: -Math.round((e.subtotalCents * p.pct) / 100) });
      env.act('updateEstimate', { estimateId: e.id, items });
      env.act('sendEstimate', { estimateId: e.id });
    },
    check(final, initial, p) {
      const c = checker();
      const e0 = get(initial, 'estimates', p.estimateId);
      const e = get(final, 'estimates', p.estimateId);
      const disc = -Math.round((e0.subtotalCents * p.pct) / 100);
      const key = (i) => `${i.code}|${i.qty}|${i.unitPriceCents}`;
      c.need(e.items.length === e0.items.length + 1, 'expected exactly one added line item');
      c.need(e0.items.every((i) => e.items.some((x) => key(x) === key(i))), 'original line items must be kept unchanged');
      c.need(e.items.some((i) => i.unitPriceCents === disc && i.qty === 1 && /discount/i.test(i.description)), `missing discount line of ${disc} cents`);
      c.need(e.subtotalCents === e0.subtotalCents + disc, 'subtotal does not reflect the discount');
      c.need(e.status === 'sent', 'estimate should be sent');
      c.need(newNotes(initial, final, (n) => n.refType === 'estimate' && n.refId === e.id).length > 0, 'estimate was not re-sent to the customer');
      integrity(c, final);
      return c.reasons;
    },
  },

  update_phone: {
    title: 'Update customer contact preferences',
    candidates(s, rng) {
      return rng.shuffle(s.customers.filter((cu) => !cu.prefersSms)).slice(0, 10).map((cu) => ({ customerId: cu.id, phone: `(555) 3${rng.int(10, 99)}-${String(rng.int(0, 9999)).padStart(4, '0')}` }));
    },
    prompt(s, p) {
      const cu = get(s, 'customers', p.customerId);
      return `Customer ${cu.name} (${cu.id}) has a new mobile number, ${p.phone}, and from now on prefers to be contacted by text message. Update their record accordingly. Leave their email unchanged.`;
    },
    solve(env, p) { env.act('updateCustomer', { customerId: p.customerId, phone: p.phone, prefersSms: true }); },
    check(final, initial, p) {
      const c = checker();
      const cu = get(final, 'customers', p.customerId);
      const cu0 = get(initial, 'customers', p.customerId);
      c.need(cu.phone.replace(/\D/g, '') === p.phone.replace(/\D/g, ''), 'phone was not updated');
      c.need(cu.prefersSms === true, 'prefersSms should be true');
      c.need(cu.email === cu0.email && cu.name === cu0.name, 'name/email must not change');
      return c.reasons;
    },
  },

  pay_all_open: {
    title: "Settle all of a customer's open invoices",
    candidates(s, rng) {
      const open = new Map();
      for (const i of s.invoices) if (i.status === 'sent' || i.status === 'partially_paid') open.set(i.customerId, (open.get(i.customerId) || 0) + 1);
      return rng.shuffle([...open].filter(([, n]) => n >= 2).map(([id]) => ({ customerId: id })));
    },
    prompt(s, p) {
      return `${custName(s, p.customerId)} (${p.customerId}) called and paid everything they owe by credit card. Record card payments so that every open (sent or partially paid) invoice on their account is paid in full. Leave draft invoices alone.`;
    },
    solve(env, p) {
      for (const i of env.state.invoices.filter((x) => x.customerId === p.customerId && (x.status === 'sent' || x.status === 'partially_paid'))) {
        env.act('recordPayment', { invoiceId: i.id, amountCents: invoiceBalance(i), method: 'card' });
      }
    },
    check(final, initial, p) {
      const c = checker();
      const open = initial.invoices.filter((x) => x.customerId === p.customerId && (x.status === 'sent' || x.status === 'partially_paid'));
      for (const i0 of open) c.need(get(final, 'invoices', i0.id).status === 'paid', `${i0.id} is not paid`);
      const pays = created(initial, final, 'payments');
      c.need(pays.every((x) => x.method === 'card' && x.customerId === p.customerId), 'all new payments must be card payments from this customer');
      c.need(pays.reduce((a, x) => a + x.amountCents, 0) === open.reduce((a, i) => a + invoiceBalance(i), 0), 'total paid must equal the open balance');
      integrity(c, final);
      return c.reasons;
    },
  },

  deactivate_tech: {
    title: 'Offboard a technician and release their future jobs',
    candidates(s, rng) {
      return rng.shuffle(s.technicians).map((t) => ({ techId: t.id }));
    },
    feasible(s, p) {
      const today = s.meta.today;
      return s.jobs.some((j) => j.techId === p.techId && j.date === today) && s.jobs.filter((j) => j.techId === p.techId && j.status === 'scheduled' && j.date > today).length >= 3;
    },
    prompt(s, p) {
      const t = get(s, 'technicians', p.techId);
      return `Technician ${t.name} (${t.id}) has left the company after today's shift. Mark them inactive and unschedule every job assigned to them with a date after today (${s.meta.today}) so dispatch can reassign them. Leave today's and past jobs as they are.`;
    },
    solve(env, p) {
      env.act('setTechnicianActive', { techId: p.techId, active: false });
      for (const j of env.state.jobs.filter((x) => x.techId === p.techId && x.status === 'scheduled' && x.date > env.state.meta.today)) env.act('unscheduleJob', { jobId: j.id });
    },
    check(final, initial, p) {
      const c = checker();
      const today = initial.meta.today;
      c.need(get(final, 'technicians', p.techId).active === false, 'technician should be inactive');
      for (const j0 of initial.jobs.filter((x) => x.techId === p.techId && x.status === 'scheduled' && x.date > today)) {
        c.need(get(final, 'jobs', j0.id).status === 'unscheduled', `${j0.id} should be unscheduled`);
      }
      for (const j0 of initial.jobs.filter((x) => x.techId === p.techId && x.date <= today)) {
        const j = get(final, 'jobs', j0.id);
        c.need(j.techId === j0.techId && j.status === j0.status, `${j0.id} (today/past) should be unchanged`);
      }
      integrity(c, final);
      return c.reasons;
    },
  },

  swap_jobs: {
    title: 'Swap the technicians of two jobs',
    candidates(s, rng) {
      const fut = futureScheduled(s).filter((j) => j.date > s.meta.today);
      const out = [];
      for (const a of rng.shuffle(fut).slice(0, 60)) {
        const b = fut.find((x) => x.date === a.date && x.trade === a.trade && x.techId !== a.techId && x.id > a.id);
        if (b) out.push({ jobA: a.id, jobB: b.id });
      }
      return out;
    },
    feasible(s, p) { return swapFeasible(s, p); },
    prompt(s, p) {
      return `Swap the technicians on these two jobs, keeping each job's date and start time: ${describeJob(s, get(s, 'jobs', p.jobA))} and ${describeJob(s, get(s, 'jobs', p.jobB))}.`;
    },
    solve(env, p) {
      const a = { ...get(env.state, 'jobs', p.jobA) };
      const b = { ...get(env.state, 'jobs', p.jobB) };
      env.act('unscheduleJob', { jobId: a.id });
      env.act('scheduleJob', { jobId: b.id, techId: a.techId, date: b.date, start: b.startMin });
      env.act('scheduleJob', { jobId: a.id, techId: b.techId, date: a.date, start: a.startMin });
    },
    check(final, initial, p) {
      const c = checker();
      const a0 = get(initial, 'jobs', p.jobA); const b0 = get(initial, 'jobs', p.jobB);
      const a = get(final, 'jobs', p.jobA); const b = get(final, 'jobs', p.jobB);
      c.need(a.techId === b0.techId && b.techId === a0.techId, 'technicians were not swapped');
      c.need(a.status === 'scheduled' && b.status === 'scheduled', 'both jobs must remain scheduled');
      c.need(a.date === a0.date && a.startMin === a0.startMin && b.date === b0.date && b.startMin === b0.startMin, 'dates/times must not change');
      integrity(c, final);
      return c.reasons;
    },
  },

  move_next_day: {
    title: 'Move a job to the next day with the same technician',
    candidates(s, rng) { return rng.shuffle(futureScheduled(s).filter((j) => j.date > s.meta.today)).map((j) => ({ jobId: j.id, toDate: nextWorkday(j.date, 1) })); },
    feasible(s, p) {
      const j = get(s, 'jobs', p.jobId);
      return !slotProblem(s, get(s, 'technicians', j.techId), j, p.toDate, j.startMin, j.durationMin);
    },
    prompt(s, p) {
      const j = get(s, 'jobs', p.jobId);
      return `The customer asked to push job ${describeJob(s, j)} to ${p.toDate}. Keep the same technician and start time, and email the customer the new appointment details.`;
    },
    solve(env, p) {
      const j = get(env.state, 'jobs', p.jobId);
      env.act('scheduleJob', { jobId: j.id, techId: j.techId, date: p.toDate, start: j.startMin, notify: 'email' });
    },
    check(final, initial, p) {
      const c = checker();
      const j0 = get(initial, 'jobs', p.jobId);
      const j = get(final, 'jobs', p.jobId);
      c.need(j.status === 'scheduled' && j.date === p.toDate, `job should be scheduled on ${p.toDate}`);
      c.need(j.techId === j0.techId && j.startMin === j0.startMin, 'technician and start time must not change');
      c.need(newNotes(initial, final, (n) => n.customerId === j.customerId && n.channel === 'email' && n.refId === j.id).length > 0, 'customer was not emailed');
      integrity(c, final);
      return c.reasons;
    },
  },
};

// ---- kind-specific computations (shared by solve/check/feasible) ----------------
function availableForEstimate(s, p) {
  const e = get(s, 'estimates', p.estimateId);
  return findAvailableTechs(s, { companyId: e.companyId, trade: e.trade, locationId: e.locationId, durationMin: itemsDuration(e.items), date: p.date, start: p.start });
}

function emergencyAvail(s, p) {
  const cu = get(s, 'customers', p.customerId);
  return findAvailableTechs(s, { companyId: cu.companyId, trade: p.trade, locationId: p.locationId, durationMin: SERVICE_BY_CODE[p.serviceCode].durationMin, date: p.date, start: p.start });
}

export function earliestOptions(s, p) {
  const j = get(s, 'jobs', p.jobId);
  for (let start = 0; start < 1440; start += 30) {
    const techs = findAvailableTechs(s, { jobId: j.id, date: p.date, start });
    if (techs.length) return { start, techs };
  }
  return { start: null, techs: [] };
}

function overdueSet(s, p) {
  const cutoff = addDays(s.meta.today, -p.days);
  return s.invoices.filter((i) => i.companyId === p.companyId && (i.status === 'sent' || i.status === 'partially_paid') && i.dueDate && i.dueDate < cutoff);
}

function swapFeasible(s, p) {
  const a = get(s, 'jobs', p.jobA);
  const b = get(s, 'jobs', p.jobB);
  const ta = get(s, 'technicians', a.techId);
  const tb = get(s, 'technicians', b.techId);
  // simulate: tech A takes B's slot ignoring job A; tech B takes A's slot ignoring job B
  const without = (jobId) => ({ ...s, jobs: s.jobs.filter((x) => x.id !== jobId) });
  return !slotProblem(without(a.id), ta, b, b.date, b.startMin, b.durationMin) && !slotProblem(without(b.id), tb, a, a.date, a.startMin, a.durationMin);
}


// ---- hard (multi-step) kinds ------------------------------------------------------
// Each needs several lookups and typically 4-12 mutating actions, reasoning across
// customers/jobs/technicians/invoices, and leaves distractor entities that the
// checker verifies were not touched.
const preferredChannel = (cu) => (cu.prefersSms ? 'sms' : 'email');
const sameJSON = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const chanLabel = (ch) => (ch === 'sms' ? 'SMS' : 'email');
// Line-item identity: price-book code (custom lines such as materials are matched by price only).
const itemKey = (i) => `${i.code && SERVICE_BY_CODE[i.code] ? i.code : 'custom'}|${i.qty}|${i.unitPriceCents}`;
const sameItems = (a, b) => sameJSON(a.map(itemKey).sort(), b.map(itemKey).sort());
const openStatus = (i) => i.status === 'sent' || i.status === 'partially_paid';
const byDueThenId = (a, b) => (a.dueDate < b.dueDate ? -1 : a.dueDate > b.dueDate ? 1 : a.id < b.id ? -1 : 1);
const itemList = (items) => items.map((i) => `${i.qty} x ${SERVICE_BY_CODE[i.code].name} [${i.code}]`).join(' and ');
const priceBookItems = (items) => items.map((i) => ({ code: i.code, qty: i.qty, unitPriceCents: SERVICE_BY_CODE[i.code].priceCents }));
/** Copy items into action input form (price-book lines keep their price, custom lines keep description). */
const itemsInput = (items) => items.map((i) => (i.code && SERVICE_BY_CODE[i.code]
  ? { code: i.code, qty: i.qty, unitPriceCents: i.unitPriceCents }
  : { code: i.code, description: i.description, qty: i.qty, unitPriceCents: i.unitPriceCents }));

/** Every pre-existing job outside `ids` keeps status, technician, date and start. */
function otherJobsUnchanged(c, initial, final, ids) {
  const moved = initial.jobs.filter((j0) => {
    if (ids.has(j0.id)) return false;
    const j = get(final, 'jobs', j0.id);
    return j.status !== j0.status || j.techId !== j0.techId || j.date !== j0.date || j.startMin !== j0.startMin;
  });
  c.need(moved.length === 0, `other jobs must not change: ${moved.slice(0, 5).map((j) => j.id).join(', ')}`);
}
/** Entities in `ids` are byte-identical between initial and final. */
function unchanged(c, initial, final, coll, ids, label) {
  const bad = ids.filter((id) => !sameJSON(get(initial, coll, id), get(final, coll, id)));
  c.need(bad.length === 0, `${label} must not change: ${bad.slice(0, 5).join(', ')}`);
}
/** Pre-existing invoices/payments outside the allowed sets keep their status and paid amount. */
function otherMoneyUnchanged(c, initial, final, invIds, payIds) {
  const inv = initial.invoices.filter((i0) => !invIds.has(i0.id) && (get(final, 'invoices', i0.id).status !== i0.status || get(final, 'invoices', i0.id).amountPaidCents !== i0.amountPaidCents));
  c.need(inv.length === 0, `other invoices must not change: ${inv.slice(0, 5).map((i) => i.id).join(', ')}`);
  const pay = initial.payments.filter((p0) => !payIds.has(p0.id) && get(final, 'payments', p0.id).status !== p0.status);
  c.need(pay.length === 0, `other payments must not change: ${pay.slice(0, 5).map((x) => x.id).join(', ')}`);
}
function notesOnlyTo(c, initial, final, customerIds) {
  const stray = newNotes(initial, final, (n) => !customerIds.has(n.customerId));
  c.need(stray.length === 0, `messages sent to unrelated customers: ${[...new Set(stray.map((n) => n.customerId))].slice(0, 5).join(', ')}`);
}
/** "Nearest" rule that is independent of the order jobs were handled in: no strictly closer qualified tech is free in the final state. */
function nearestInFinal(c, final, j, excludeTechId) {
  const mine = techDistance(get(final, 'technicians', j.techId), get(final, 'locations', j.locationId));
  const closer = findAvailableTechs(final, { jobId: j.id, date: j.date, start: j.startMin }).filter((t) => t.techId !== excludeTechId && t.distance < mine);
  c.need(closer.length === 0, `${j.id}: ${closer[0]?.techId} is nearer to the job and free at that time`);
}

function leaveJobs(s, p) {
  return s.jobs.filter((j) => j.techId === p.techId && p.dates.includes(j.date) && j.status === 'scheduled')
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.startMin - b.startMin));
}
function futureJobsOfTech(s, techId) {
  return s.jobs.filter((j) => j.techId === techId && j.status === 'scheduled' && j.date > s.meta.today);
}
function settlementPlan(s, p) {
  const open = s.invoices.filter((i) => i.customerId === p.customerId && openStatus(i)).sort(byDueThenId);
  let left = p.checkCents;
  return open.map((i) => {
    const bal = invoiceBalance(i);
    const check = Math.min(bal, left);
    left -= check;
    return { invoiceId: i.id, balance: bal, check, card: bal - check };
  });
}
function rebillItems(inv, newPartsCents) {
  return inv.items.map((i) => (i.code === PARTS_CODE ? { ...i, unitPriceCents: newPartsCents } : { ...i }));
}
/** Earliest (date, start) from p.fromDate (Sundays skipped, half-hour grid) with a free qualified tech whose home zone = the site zone. */
function earliestZoneSlot(s, p) {
  const e = get(s, 'estimates', p.estimateId);
  const loc = get(s, 'locations', e.locationId);
  const dur = itemsDuration(e.items);
  const zoneTechs = s.technicians.filter((t) => t.active && t.companyId === e.companyId && t.trades.includes(e.trade) && t.zone === loc.zone);
  if (!zoneTechs.length) return null;
  const minStart = Math.min(...zoneTechs.map((t) => t.shiftStart));
  const maxEnd = Math.max(...zoneTechs.map((t) => t.shiftEnd));
  for (let k = 0; k < 30; k++) {
    const date = addDays(p.fromDate, k);
    if (dayOfWeek(date) === 0) continue;
    for (let start = Math.ceil(minStart / 30) * 30; start + dur <= maxEnd; start += 30) {
      const techs = findAvailableTechs(s, { companyId: e.companyId, trade: e.trade, locationId: loc.id, durationMin: dur, date, start }).filter((t) => t.zone === loc.zone);
      if (techs.length) return { date, start, techs };
    }
  }
  return null;
}
function creditHoldSet(s, p) {
  const cutoff = addDays(s.meta.today, -p.days);
  return s.invoices.filter((i) => i.companyId === p.companyId && openStatus(i) && i.dueDate && i.dueDate < cutoff && get(s, 'customers', i.customerId).type === 'commercial');
}
function movingTargets(s, p) {
  const jobs = s.jobs.filter((j) => j.customerId === p.customerId && (j.status === 'unscheduled' || (j.status === 'scheduled' && j.date > s.meta.today)));
  const estimates = s.estimates.filter((e) => e.customerId === p.customerId && (e.status === 'draft' || e.status === 'sent'));
  return { jobs, estimates };
}
function onboardAvail(s, p) {
  return findAvailableTechs(s, { companyId: p.companyId, trade: p.trade, durationMin: itemsDuration(p.items), date: p.date, start: p.start });
}

const HARD_KINDS = {
  tech_leave_reassign: {
    title: 'Technician on leave for two days: reassign every job and notify customers on their preferred channel',
    candidates(s, rng) {
      const out = [];
      for (const t of s.technicians) {
        for (let k = 1; k <= 10; k++) {
          const d1 = nextWorkday(s.meta.today, k);
          const dates = [d1, nextWorkday(d1, 1)];
          const n = leaveJobs(s, { techId: t.id, dates }).length;
          if (n >= 3 && n <= 7 && !out.some((o) => o.techId === t.id && o.dates[0] === d1)) out.push({ techId: t.id, dates });
        }
      }
      return rng.shuffle(out);
    },
    prompt(s, p) {
      const t = get(s, 'technicians', p.techId);
      return `Technician ${t.name} (${t.id}) is on approved leave on ${p.dates[0]} and ${p.dates[1]}. Every job assigned to ${t.name} on those two dates must be handed to a different qualified technician at the same date and start time. For each job pick the nearest technician (shortest distance from the technician's home base to the job location) among those free for that job's slot; if two jobs compete for the same technician, any assignment works as long as no strictly nearer technician is left free for a job's slot. Then notify each affected customer about their job's change on the customer's preferred channel (SMS if they prefer text messages, otherwise email), referencing the job. ${t.name}'s jobs on other dates and all other jobs must not change, and do not message anyone else.`;
    },
    solve(env, p) {
      const jobs = p.dates.flatMap((date) => env.query('techSchedule', { techId: p.techId, date }).jobs.filter((j) => j.status === 'scheduled'));
      for (const j of jobs) {
        const best = env.query('findAvailableTechs', { jobId: j.id, date: j.date, start: j.startMin }).filter((t) => t.techId !== p.techId)[0];
        if (!best) throw new Error(`no free technician for ${j.id}`);
        env.act('scheduleJob', { jobId: j.id, techId: best.techId, date: j.date, start: j.startMin, notify: true });
      }
    },
    check(final, initial, p) {
      const c = checker();
      const affected = leaveJobs(initial, p);
      for (const j0 of affected) {
        const j = get(final, 'jobs', j0.id);
        if (!c.need(j.status === 'scheduled' && j.techId && j.techId !== p.techId, `${j.id} must be scheduled with a technician other than ${p.techId}`)) continue;
        c.need(j.date === j0.date && j.startMin === j0.startMin, `${j.id} must keep its date and start time`);
        nearestInFinal(c, final, j, p.techId);
        const cu = get(initial, 'customers', j0.customerId);
        const ch = preferredChannel(cu);
        c.need(newNotes(initial, final, (n) => n.customerId === cu.id && n.refId === j.id && n.channel === ch).length > 0, `customer of ${j.id} was not notified by ${chanLabel(ch)} (their preferred channel) about the job`);
      }
      otherJobsUnchanged(c, initial, final, new Set(affected.map((j) => j.id)));
      notesOnlyTo(c, initial, final, new Set(affected.map((j) => j.customerId)));
      integrity(c, final);
      return c.reasons;
    },
  },

  split_settlement: {
    title: 'Settle a customer account with one check applied oldest-first and card for the rest',
    candidates(s, rng) {
      const open = new Map();
      for (const i of s.invoices) if (openStatus(i)) open.set(i.customerId, (open.get(i.customerId) || 0) + 1);
      const mk = (id) => {
        const plan = settlementPlan(s, { customerId: id, checkCents: 0 });
        const second = plan[1].balance;
        return { customerId: id, checkNo: String(rng.int(1001, 9899)), checkCents: plan[0].balance + Math.max(100, Math.floor(second / 200) * 100) };
      };
      const ids = [...open].sort((a, b) => (a[0] < b[0] ? -1 : 1));
      return [...rng.shuffle(ids.filter(([, n]) => n >= 3)), ...rng.shuffle(ids.filter(([, n]) => n === 2))].map(([id]) => mk(id));
    },
    feasible(s, p) { const plan = settlementPlan(s, p); return plan.length >= 2 && plan[1].card > 0 && plan[1].check > 0; },
    prompt(s, p) {
      const cu = get(s, 'customers', p.customerId);
      return `${cu.name} (${cu.id}) settled their whole account today. They mailed check #${p.checkNo} for ${fmtMoney(p.checkCents)} and paid everything else by credit card over the phone. Apply the check to their open invoices (status sent or partially paid) in order of oldest due date first (ties: lower invoice number first): each invoice takes as much of the check as it needs before the next one gets any. Record one payment with method "check" per invoice the check touches, with the check number ${p.checkNo} in the payment note. Then pay the remaining balance of every open invoice with method "card", and send the customer an email receipt for each card payment. When you are done every invoice that was open must be paid in full. Do not touch draft or void invoices, or any other customer's account.`;
    },
    solve(env, p) {
      const open = env.query('listInvoices', { customerId: p.customerId }).items.filter(openStatus).sort(byDueThenId);
      let left = p.checkCents;
      for (const i of open) {
        const bal = invoiceBalance(i);
        const check = Math.min(bal, left);
        left -= check;
        if (check > 0) env.act('recordPayment', { invoiceId: i.id, amountCents: check, method: 'check', note: `check #${p.checkNo}` });
        if (bal - check > 0) env.act('recordPayment', { invoiceId: i.id, amountCents: bal - check, method: 'card', sendReceipt: 'email' });
      }
    },
    check(final, initial, p) {
      const c = checker();
      const plan = settlementPlan(initial, p);
      const ids = new Set(plan.map((x) => x.invoiceId));
      const pays = created(initial, final, 'payments');
      c.need(pays.every((x) => ids.has(x.invoiceId)), 'payments were recorded on invoices that were not open for this customer');
      c.need(pays.every((x) => x.method === 'check' || x.method === 'card'), 'only check and card payments are expected');
      for (const x of plan) {
        c.need(get(final, 'invoices', x.invoiceId).status === 'paid', `${x.invoiceId} is not paid in full`);
        const sum = (m) => pays.filter((y) => y.invoiceId === x.invoiceId && y.method === m).reduce((a, y) => a + y.amountCents, 0);
        c.need(sum('check') === x.check, `${x.invoiceId}: check amount should be ${fmtMoney(x.check)}, got ${fmtMoney(sum('check'))}`);
        c.need(sum('card') === x.card, `${x.invoiceId}: card amount should be ${fmtMoney(x.card)}, got ${fmtMoney(sum('card'))}`);
      }
      c.need(pays.filter((x) => x.method === 'check').every((x) => (x.note || '').includes(p.checkNo)), `every check payment note must contain check number ${p.checkNo}`);
      for (const x of pays.filter((y) => y.method === 'card')) {
        c.need(newNotes(initial, final, (n) => n.channel === 'email' && n.refId === x.id).length > 0, `no email receipt for card payment ${x.id}`);
      }
      unchanged(c, initial, final, 'invoices', initial.invoices.filter((i) => i.customerId === p.customerId && !ids.has(i.id)).map((i) => i.id), 'draft/void/paid invoices of the customer');
      otherMoneyUnchanged(c, initial, final, ids, new Set());
      notesOnlyTo(c, initial, final, new Set([p.customerId]));
      integrity(c, final);
      return c.reasons;
    },
  },

  rebill_invoice: {
    title: 'Correct a mis-billed, partially paid invoice: refund, void, re-issue, send and re-apply the payment',
    candidates(s, rng) {
      const out = [];
      for (const i of s.invoices) {
        if (i.status !== 'partially_paid' || !i.items.some((x) => x.code === PARTS_CODE)) continue;
        const pays = s.payments.filter((x) => x.invoiceId === i.id && x.status === 'completed');
        if (pays.length !== 1) continue;
        const old = i.items.find((x) => x.code === PARTS_CODE).unitPriceCents;
        const newPartsCents = old > 5000 ? old - 2500 : old + 2500;
        out.push({ invoiceId: i.id, paymentId: pays[0].id, newPartsCents });
      }
      return rng.shuffle(out);
    },
    feasible(s, p) {
      const i = get(s, 'invoices', p.invoiceId);
      const co = s.companies.find((x) => x.id === i.companyId);
      return computeTotals(rebillItems(i, p.newPartsCents), co.taxRate).totalCents > get(s, 'payments', p.paymentId).amountCents;
    },
    prompt(s, p) {
      const i = get(s, 'invoices', p.invoiceId);
      const x = get(s, 'payments', p.paymentId);
      const old = i.items.find((it) => it.code === PARTS_CODE);
      return `Invoice ${i.id} for ${custName(s, i.customerId)} (${i.customerId}), job ${i.jobId}, was mis-billed: the "${old.description}" line was entered at ${fmtMoney(old.unitPriceCents)} but should be ${fmtMoney(p.newPartsCents)}. Every other line is correct. The customer already paid ${fmtMoney(x.amountCents)} by ${x.method} (payment ${x.id}). Fix the billing: refund payment ${x.id}, void invoice ${i.id} with reason "billing error", create a new invoice for job ${i.jobId} with the same line items except the materials line at ${fmtMoney(p.newPartsCents)}, send the new invoice to the customer by email, and re-apply the customer's ${fmtMoney(x.amountCents)} to the new invoice as one payment with method "${x.method}". Do not change any other invoice or payment.`;
    },
    solve(env, p) {
      const x = env.query('listPayments', { invoiceId: p.invoiceId, status: 'completed' }).items[0];
      env.act('refundPayment', { paymentId: x.id, reason: 'billing error' });
      env.act('voidInvoice', { invoiceId: p.invoiceId, reason: 'billing error' });
      const old = env.query('listInvoices', { status: 'void' }).items.find((i) => i.id === p.invoiceId);
      const { invoice } = env.act('createInvoice', { jobId: old.jobId, items: itemsInput(rebillItems(old, p.newPartsCents)) });
      env.act('sendInvoice', { invoiceId: invoice.id, channel: 'email' });
      env.act('recordPayment', { invoiceId: invoice.id, amountCents: x.amountCents, method: x.method });
    },
    check(final, initial, p) {
      const c = checker();
      const i0 = get(initial, 'invoices', p.invoiceId);
      const x0 = get(initial, 'payments', p.paymentId);
      c.need(get(final, 'payments', p.paymentId).status === 'refunded', `payment ${p.paymentId} should be refunded`);
      const i = get(final, 'invoices', p.invoiceId);
      c.need(i.status === 'void' && /billing/i.test(i.voidReason || ''), `invoice ${i.id} should be void with reason "billing error"`);
      const fresh = created(initial, final, 'invoices');
      if (!c.need(fresh.length === 1 && fresh[0].jobId === i0.jobId && fresh[0].status !== 'void', `expected exactly one new (non-void) invoice for job ${i0.jobId}`)) return c.reasons;
      const n = fresh[0];
      c.need(sameItems(n.items, rebillItems(i0, p.newPartsCents)), 'new invoice line items should equal the original ones with the corrected materials price');
      c.need(n.sentAt != null, 'new invoice was not sent');
      c.need(newNotes(initial, final, (x) => x.channel === 'email' && x.refType === 'invoice' && x.refId === n.id).length > 0, 'new invoice was not emailed to the customer');
      const pays = created(initial, final, 'payments');
      c.need(pays.length === 1 && pays[0].invoiceId === n.id && pays[0].amountCents === x0.amountCents && pays[0].method === x0.method, `expected exactly one new ${x0.method} payment of ${fmtMoney(x0.amountCents)} on the new invoice`);
      otherMoneyUnchanged(c, initial, final, new Set([i0.id]), new Set([x0.id]));
      integrity(c, final);
      return c.reasons;
    },
  },

  approve_earliest_zone: {
    title: 'Approve an estimate and book the earliest slot with a technician from the same zone',
    candidates(s, rng) {
      const fromDate = nextWorkday(s.meta.today, 1);
      return rng.shuffle(s.estimates.filter((e) => e.status === 'sent')).map((e) => ({ estimateId: e.id, fromDate }));
    },
    feasible(s, p) { return earliestZoneSlot(s, p) != null; },
    prompt(s, p) {
      const e = get(s, 'estimates', p.estimateId);
      const loc = get(s, 'locations', e.locationId);
      return `${custName(s, e.customerId)} (${e.customerId}) approved estimate ${e.id} ("${e.summary}", ${fmtMoney(e.totalCents)}) for ${loc.address} (${loc.zone} zone). Record the approval, set the resulting job's priority to high, and book it at the earliest possible appointment from ${p.fromDate} onward: start times on the half-hour grid, no Sundays (the office is closed), and only a technician whose home zone is ${loc.zone} (the same zone as the job site) who is qualified and free for the job's full duration within their shift. If several such technicians are free at that earliest date and time, any of them is fine. Then send the customer an SMS confirmation referencing the job. Leave the customer's other estimates as they are.`;
    },
    solve(env, p) {
      const { job } = env.act('approveEstimate', { estimateId: p.estimateId });
      env.act('updateJob', { jobId: job.id, priority: 'high' });
      const loc = env.query('getJob', { jobId: job.id }).location;
      for (let k = 0; k < 30; k++) {
        const date = addDays(p.fromDate, k);
        if (dayOfWeek(date) === 0) continue;
        for (let start = 420; start + job.durationMin <= 1020; start += 30) {
          const t = env.query('findAvailableTechs', { jobId: job.id, date, start }).find((x) => x.zone === loc.zone);
          if (t) { env.act('scheduleJob', { jobId: job.id, techId: t.techId, date, start, notify: 'sms' }); return; }
        }
      }
      throw new Error('no slot found');
    },
    check(final, initial, p) {
      const c = checker();
      const e = get(final, 'estimates', p.estimateId);
      if (!c.need(e.status === 'approved' && e.jobId, 'estimate should be approved with a linked job')) return c.reasons;
      const j = get(final, 'jobs', e.jobId);
      const best = earliestZoneSlot(initial, p);
      c.need(j.status === 'scheduled' && j.date === best.date && j.startMin === best.start, `job ${j.id} should be scheduled at the earliest slot ${best.date} ${fmtTime(best.start)} (got ${j.date} ${fmtTime(j.startMin)})`);
      c.need(best.techs.some((t) => t.techId === j.techId), `technician ${j.techId} is not a free ${get(initial, 'locations', e.locationId).zone}-zone technician at that slot`);
      c.need(j.priority === 'high', 'job priority should be high');
      c.need(newNotes(initial, final, (n) => n.customerId === j.customerId && n.channel === 'sms' && n.refId === j.id).length > 0, 'customer was not sent an SMS confirmation about the job');
      unchanged(c, initial, final, 'estimates', initial.estimates.filter((x) => x.customerId === e.customerId && x.id !== e.id).map((x) => x.id), "customer's other estimates");
      otherJobsUnchanged(c, initial, final, new Set());
      integrity(c, final);
      return c.reasons;
    },
  },

  commercial_credit_hold: {
    title: 'Put overdue commercial accounts on credit hold and email a reminder per overdue invoice',
    candidates(s, rng) {
      return rng.shuffle(s.companies.flatMap((co) => [20, 30, 45, 60, 75, 90].map((days) => ({ companyId: co.id, days }))));
    },
    feasible(s, p) {
      const set = creditHoldSet(s, p);
      return set.length >= 3 && set.length <= 10 && new Set(set.map((i) => i.customerId)).size >= 2;
    },
    prompt(s, p) {
      const co = s.companies.find((x) => x.id === p.companyId);
      return `Collections run for ${co.name} (${co.id}): find every open invoice (status sent or partially paid) of a COMMERCIAL customer whose due date is more than ${p.days} days before today (${s.meta.today}), i.e. due before ${addDays(s.meta.today, -p.days)}. For each such invoice, email its customer a payment reminder referencing the invoice (refType "invoice", refId = invoice id). Then put each of those customers on credit hold by setting their customer notes to contain the text "CREDIT HOLD". Residential customers, customers of other companies and invoices not past the cutoff are out of scope: do not message them or change their records, and do not change any invoice.`;
    },
    solve(env, p) {
      const cutoff = addDays(env.state.meta.today, -p.days);
      const commercial = new Set(env.query('listCustomers', { companyId: p.companyId, type: 'commercial' }).items.map((cu) => cu.id));
      const invs = env.query('listInvoices', { companyId: p.companyId, overdue: true }).items.filter((i) => commercial.has(i.customerId) && i.dueDate < cutoff);
      for (const i of invs) {
        env.act('notifyCustomer', { customerId: i.customerId, channel: 'email', refType: 'invoice', refId: i.id, template: 'payment_reminder', message: `Reminder: invoice ${i.id} has an open balance of ${fmtMoney(invoiceBalance(i))}, due ${i.dueDate}.` });
      }
      for (const id of new Set(invs.map((i) => i.customerId))) env.act('updateCustomer', { customerId: id, notes: 'CREDIT HOLD - overdue invoices' });
    },
    check(final, initial, p) {
      const c = checker();
      const set = creditHoldSet(initial, p);
      const want = set.map((i) => i.id).sort();
      const notes = created(initial, final, 'notifications');
      const got = [...new Set(notes.filter((n) => n.channel === 'email' && n.refType === 'invoice').map((n) => n.refId))].sort();
      c.need(sameJSON(want, got), `reminded invoices ${got.length} != expected ${want.length} (missing: ${want.filter((x) => !got.includes(x)).slice(0, 5).join(',')}; extra: ${got.filter((x) => !want.includes(x)).slice(0, 5).join(',')})`);
      const holds = new Set(set.map((i) => i.customerId));
      notesOnlyTo(c, initial, final, holds);
      for (const id of holds) c.need(/credit hold/i.test(get(final, 'customers', id).notes || ''), `customer ${id} is not marked CREDIT HOLD in notes`);
      unchanged(c, initial, final, 'customers', initial.customers.filter((cu) => !holds.has(cu.id)).map((cu) => cu.id), 'out-of-scope customers');
      otherMoneyUnchanged(c, initial, final, new Set(), new Set());
      integrity(c, final);
      return c.reasons;
    },
  },

  misapplied_payment: {
    title: 'Move a payment that was applied to the wrong invoice',
    candidates(s, rng) {
      const out = [];
      for (const x of s.payments) {
        if (x.status !== 'completed') continue;
        const a = get(s, 'invoices', x.invoiceId);
        if (a.status !== 'paid' || s.payments.filter((y) => y.invoiceId === a.id && y.status === 'completed').length !== 1) continue;
        const b = s.invoices.filter((i) => i.customerId === x.customerId && i.id !== a.id && openStatus(i) && invoiceBalance(i) >= x.amountCents).sort((m, n) => (m.id < n.id ? -1 : 1))[0];
        if (b) out.push({ paymentId: x.id, fromInvoiceId: a.id, toInvoiceId: b.id, recent: x.date >= addDays(s.meta.today, -45) });
      }
      // prefer recent payments (a mistake noticed within ~6 weeks), fall back to older ones
      return [...rng.shuffle(out.filter((o) => o.recent)), ...rng.shuffle(out.filter((o) => !o.recent))].map(({ recent, ...o }) => o);
    },
    prompt(s, p) {
      const x = get(s, 'payments', p.paymentId);
      return `Payment ${x.id} (${fmtMoney(x.amountCents)} by ${x.method} on ${x.date}) from ${custName(s, x.customerId)} (${x.customerId}) was applied to invoice ${p.fromInvoiceId} by mistake; the customer meant it for invoice ${p.toInvoiceId}. Refund payment ${x.id} with reason "misapplied", record the same amount with the same method (${x.method}) on invoice ${p.toInvoiceId} and send the customer an SMS receipt for that new payment. Invoice ${p.fromInvoiceId} is open again afterwards: email the customer a reminder about it (refType "invoice", refId ${p.fromInvoiceId}). Do not change any other invoice or payment.`;
    },
    solve(env, p) {
      const x = env.query('listPayments', { invoiceId: p.fromInvoiceId, status: 'completed' }).items.find((y) => y.id === p.paymentId);
      env.act('refundPayment', { paymentId: x.id, reason: 'misapplied' });
      env.act('recordPayment', { invoiceId: p.toInvoiceId, amountCents: x.amountCents, method: x.method, sendReceipt: 'sms', note: `moved from ${x.id}` });
      env.act('notifyCustomer', { customerId: x.customerId, channel: 'email', refType: 'invoice', refId: p.fromInvoiceId, template: 'payment_reminder', message: `Invoice ${p.fromInvoiceId} has an open balance of ${fmtMoney(x.amountCents)}.` });
    },
    check(final, initial, p) {
      const c = checker();
      const x0 = get(initial, 'payments', p.paymentId);
      const x = get(final, 'payments', p.paymentId);
      c.need(x.status === 'refunded', `payment ${x.id} should be refunded`);
      c.need(/misapplied/i.test(x.note || ''), 'refund reason should be "misapplied"');
      c.need(get(final, 'invoices', p.fromInvoiceId).amountPaidCents === get(initial, 'invoices', p.fromInvoiceId).amountPaidCents - x0.amountCents, `${p.fromInvoiceId} balance should reopen by ${fmtMoney(x0.amountCents)}`);
      const pays = created(initial, final, 'payments');
      if (c.need(pays.length === 1 && pays[0].invoiceId === p.toInvoiceId && pays[0].amountCents === x0.amountCents && pays[0].method === x0.method, `expected exactly one new ${x0.method} payment of ${fmtMoney(x0.amountCents)} on ${p.toInvoiceId}`)) {
        c.need(newNotes(initial, final, (n) => n.channel === 'sms' && n.refId === pays[0].id).length > 0, 'no SMS receipt for the new payment');
      }
      c.need(newNotes(initial, final, (n) => n.channel === 'email' && n.refType === 'invoice' && n.refId === p.fromInvoiceId).length > 0, `no email reminder referencing ${p.fromInvoiceId}`);
      otherMoneyUnchanged(c, initial, final, new Set([p.fromInvoiceId, p.toInvoiceId]), new Set([p.paymentId]));
      notesOnlyTo(c, initial, final, new Set([x0.customerId]));
      integrity(c, final);
      return c.reasons;
    },
  },

  customer_moving: {
    title: "Customer moving away: cancel future jobs, decline open estimates, notify",
    candidates(s, rng) {
      const today = s.meta.today;
      const score = new Map();
      for (const j of s.jobs) {
        if (j.status === 'unscheduled' || (j.status === 'scheduled' && j.date > today)) score.set(j.customerId, (score.get(j.customerId) || 0) + 1);
      }
      const rich = []; const plain = [];
      for (const [id, n] of [...score].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
        if (n < 2 || n > 6) continue;
        const hasEst = s.estimates.some((e) => e.customerId === id && (e.status === 'draft' || e.status === 'sent'));
        const hasPast = s.jobs.some((j) => j.customerId === id && (j.date === today || j.status === 'completed'));
        (hasEst && hasPast ? rich : plain).push({ customerId: id });
      }
      return [...rng.shuffle(rich), ...rng.shuffle(plain)];
    },
    prompt(s, p) {
      const cu = get(s, 'customers', p.customerId);
      return `${cu.name} (${cu.id}) is moving out of our service area. On their account: cancel every job that is unscheduled or scheduled for a date after today (${s.meta.today}) with reason "customer moved", and email the customer a cancellation notice for each of those jobs (referencing the job). Also decline every open (draft or sent) estimate with reason "customer moved". Leave today's and past jobs, completed work and all invoices exactly as they are, and do not touch other customers.`;
    },
    solve(env, p) {
      const sum = env.query('getCustomer', { customerId: p.customerId });
      for (const j of sum.jobs.filter((x) => x.status === 'unscheduled' || (x.status === 'scheduled' && x.date > env.state.meta.today))) {
        env.act('cancelJob', { jobId: j.id, reason: 'customer moved', notify: 'email' });
      }
      for (const e of sum.estimates.filter((x) => x.status === 'draft' || x.status === 'sent')) env.act('declineEstimate', { estimateId: e.id, reason: 'customer moved' });
    },
    check(final, initial, p) {
      const c = checker();
      const { jobs, estimates } = movingTargets(initial, p);
      for (const j0 of jobs) {
        const j = get(final, 'jobs', j0.id);
        c.need(j.status === 'canceled' && /moved/i.test(j.cancelReason || ''), `${j.id} should be canceled with reason "customer moved"`);
        c.need(newNotes(initial, final, (n) => n.channel === 'email' && n.refId === j.id).length > 0, `no cancellation email referencing ${j.id}`);
      }
      for (const e0 of estimates) {
        const e = get(final, 'estimates', e0.id);
        c.need(e.status === 'declined' && /moved/i.test(e.declineReason || ''), `${e.id} should be declined with reason "customer moved"`);
      }
      otherJobsUnchanged(c, initial, final, new Set(jobs.map((j) => j.id)));
      c.need(created(initial, final, 'jobs').length === 0, 'no new jobs should be created');
      const estIds = new Set(estimates.map((e) => e.id));
      const otherEst = initial.estimates.filter((e0) => !estIds.has(e0.id) && get(final, 'estimates', e0.id).status !== e0.status);
      c.need(otherEst.length === 0, `other estimates must not change: ${otherEst.slice(0, 5).map((e) => e.id).join(', ')}`);
      otherMoneyUnchanged(c, initial, final, new Set(), new Set());
      notesOnlyTo(c, initial, final, new Set([p.customerId]));
      integrity(c, final);
      return c.reasons;
    },
  },

  offboard_reassign: {
    title: 'Offboard a technician: hand future jobs to the nearest free tech (or unschedule), notify, deactivate',
    candidates(s, rng) {
      return rng.shuffle(s.technicians.filter((t) => { const n = futureJobsOfTech(s, t.id).length; return n >= 4 && n <= 10; }).map((t) => ({ techId: t.id })));
    },
    feasible(s, p) { return s.jobs.some((j) => j.techId === p.techId && j.date === s.meta.today); },
    prompt(s, p) {
      const t = get(s, 'technicians', p.techId);
      return `Technician ${t.name} (${t.id}) leaves the company after today's shift. For every job assigned to ${t.name} with a date after today (${s.meta.today}): reassign it, keeping its date and start time, to the nearest other qualified technician (shortest distance from home base to the job location) who is free for that slot, and text (SMS) that customer about the change, referencing the job. If no qualified technician is free at that exact date and time, unschedule the job instead and email the customer that we will call to rebook, referencing the job. When all of their future jobs are handled, deactivate ${t.name}. Today's and past jobs, and all other jobs, stay as they are; do not message anyone else.`;
    },
    solve(env, p) {
      const jobs = env.query('techSchedule', { techId: p.techId }).jobs.filter((j) => j.status === 'scheduled' && j.date > env.state.meta.today);
      for (const j of jobs) {
        const best = env.query('findAvailableTechs', { jobId: j.id, date: j.date, start: j.startMin }).filter((t) => t.techId !== p.techId)[0];
        if (best) env.act('scheduleJob', { jobId: j.id, techId: best.techId, date: j.date, start: j.startMin, notify: 'sms' });
        else {
          env.act('unscheduleJob', { jobId: j.id });
          env.act('notifyCustomer', { customerId: j.customerId, channel: 'email', refType: 'job', refId: j.id, message: `Your appointment ${j.id} on ${j.date} needs to be rebooked; we will call you to arrange a new time.` });
        }
      }
      env.act('setTechnicianActive', { techId: p.techId, active: false });
    },
    check(final, initial, p) {
      const c = checker();
      c.need(get(final, 'technicians', p.techId).active === false, `technician ${p.techId} should be inactive`);
      const affected = futureJobsOfTech(initial, p.techId);
      for (const j0 of affected) {
        const j = get(final, 'jobs', j0.id);
        if (j.status === 'scheduled') {
          if (!c.need(j.techId !== p.techId, `${j.id} is still assigned to ${p.techId}`)) continue;
          c.need(j.date === j0.date && j.startMin === j0.startMin, `${j.id} must keep its date and start time`);
          nearestInFinal(c, final, j, p.techId);
          c.need(newNotes(initial, final, (n) => n.channel === 'sms' && n.refId === j.id).length > 0, `customer of reassigned ${j.id} was not sent an SMS referencing it`);
        } else if (j.status === 'unscheduled') {
          const free = findAvailableTechs(final, { jobId: j.id, date: j0.date, start: j0.startMin }).filter((t) => t.techId !== p.techId);
          c.need(free.length === 0, `${j.id} was unscheduled although ${free[0]?.techId} is free at that slot`);
          c.need(newNotes(initial, final, (n) => n.channel === 'email' && n.refId === j.id).length > 0, `customer of unscheduled ${j.id} was not emailed`);
        } else c.reasons.push(`${j.id} should be reassigned or unscheduled, not ${j.status}`);
      }
      otherJobsUnchanged(c, initial, final, new Set(affected.map((j) => j.id)));
      const otherTechs = initial.technicians.filter((t) => t.id !== p.techId && get(final, 'technicians', t.id).active !== t.active);
      c.need(otherTechs.length === 0, 'no other technician may be (de)activated');
      notesOnlyTo(c, initial, final, new Set(affected.map((j) => j.customerId)));
      integrity(c, final);
      return c.reasons;
    },
  },

  onboard_commercial: {
    title: 'Onboard a commercial customer with a second site, quote, approve and book the job',
    candidates(s, rng) {
      const zones = ['North', 'South', 'East', 'West', 'Central'];
      return Array.from({ length: 20 }, () => {
        const last = rng.pick(LAST_NAMES);
        const biz = rng.pick(BUSINESS_WORDS);
        const trade = rng.pick(['hvac', 'plumbing', 'electrical']);
        const big = rng.pick(SERVICES.filter((x) => x.trade === trade && x.priceCents >= 40000 && x.durationMin <= 240));
        const small = rng.pick(SERVICES.filter((x) => x.trade === trade && x.priceCents < 40000 && x.kind !== 'service'));
        const slug = `${last}${biz}`.toLowerCase().replace(/[^a-z]+/g, '');
        return {
          companyId: rng.pick(s.companies).id,
          name: `${last} ${biz} ${rng.pick(['North', 'Group', 'Partners', 'LLC'])}`,
          phone: `(555) 6${rng.int(10, 99)}-${String(rng.int(0, 9999)).padStart(4, '0')}`,
          email: `ap@${slug}.example.org`,
          address: `${rng.int(100, 999)} ${rng.pick(STREETS)} ${rng.pick(STREET_SUFFIXES)}`,
          zone: rng.pick(zones),
          address2: `${rng.int(1000, 9999)} ${rng.pick(STREETS)} ${rng.pick(STREET_SUFFIXES)}`,
          zone2: rng.pick(zones),
          trade,
          items: [{ code: big.code, qty: 1 }, { code: small.code, qty: rng.int(1, 2) }],
          date: nextWorkday(s.meta.today, rng.int(2, 5)),
          start: rng.pick([480, 540, 600]),
        };
      });
    },
    feasible(s, p) { return onboardAvail(s, p).length > 0; },
    prompt(s, p) {
      const co = s.companies.find((x) => x.id === p.companyId);
      return `New commercial account for ${co.name} (${co.id}): "${p.name}", phone ${p.phone}, email ${p.email}, prefers email over text. Main site: ${p.address} (${p.zone} zone). They also have a warehouse at ${p.address2} (${p.zone2} zone) — add it as a second service location labeled "Warehouse". Then: create an estimate (trade: ${TRADE_LABELS[p.trade]}) for the Warehouse location with ${itemList(p.items)} at standard price-book prices, send it to the customer by email, and record that the customer approved it. Finally schedule the resulting job on ${p.date} at ${fmtTime(p.start)} with the nearest available qualified technician (shortest distance from home base to the Warehouse) and email the customer the appointment confirmation referencing the job.`;
    },
    solve(env, p) {
      const { customer } = env.act('createCustomer', { companyId: p.companyId, name: p.name, type: 'commercial', phone: p.phone, email: p.email, prefersSms: false, address: p.address, zone: p.zone });
      const { location } = env.act('addLocation', { customerId: customer.id, address: p.address2, zone: p.zone2, label: 'Warehouse' });
      const { estimate } = env.act('createEstimate', { customerId: customer.id, locationId: location.id, trade: p.trade, items: p.items });
      env.act('sendEstimate', { estimateId: estimate.id, channel: 'email' });
      const { job } = env.act('approveEstimate', { estimateId: estimate.id });
      const best = env.query('findAvailableTechs', { jobId: job.id, date: p.date, start: p.start })[0];
      env.act('scheduleJob', { jobId: job.id, techId: best.techId, date: p.date, start: p.start, notify: 'email' });
    },
    check(final, initial, p) {
      const c = checker();
      const custs = created(initial, final, 'customers').filter((x) => x.name.trim().toLowerCase() === p.name.toLowerCase() && x.companyId === p.companyId);
      if (!c.need(custs.length === 1, `expected one new customer named ${p.name} in ${p.companyId}`)) return c.reasons;
      const cu = custs[0];
      c.need(cu.type === 'commercial', 'customer should be commercial');
      c.need(cu.phone.replace(/\D/g, '') === p.phone.replace(/\D/g, ''), 'phone does not match');
      c.need(cu.email.toLowerCase() === p.email, 'email does not match');
      c.need(cu.prefersSms === false, 'customer prefers email (prefersSms should be false)');
      const locs = final.locations.filter((l) => l.customerId === cu.id);
      const main = locs.find((l) => l.address.toLowerCase() === p.address.toLowerCase());
      const wh = locs.find((l) => l.address.toLowerCase() === p.address2.toLowerCase());
      c.need(main && main.zone === p.zone, 'main site with the given address/zone not found');
      if (!c.need(wh && wh.zone === p.zone2 && /warehouse/i.test(wh.label), 'Warehouse location with the given address/zone/label not found')) return c.reasons;
      const ests = created(initial, final, 'estimates').filter((e) => e.customerId === cu.id);
      if (!c.need(ests.length === 1, `expected exactly one estimate for the new customer, found ${ests.length}`)) return c.reasons;
      const e = ests[0];
      c.need(e.locationId === wh.id && e.trade === p.trade, 'estimate should be for the Warehouse location and the right trade');
      c.need(sameItems(e.items, priceBookItems(p.items)), 'estimate line items do not match the requested price-book items');
      c.need(e.sentAt != null && newNotes(initial, final, (n) => n.channel === 'email' && n.refType === 'estimate' && n.refId === e.id).length > 0, 'estimate was not emailed to the customer');
      if (!c.need(e.status === 'approved' && e.jobId, 'estimate should be approved with a linked job')) return c.reasons;
      const j = get(final, 'jobs', e.jobId);
      c.need(j.status === 'scheduled' && j.date === p.date && j.startMin === p.start, `job should be scheduled ${p.date} ${fmtTime(p.start)}`);
      if (j.techId) {
        const dist = (id) => techDistance(get(initial, 'technicians', id), wh);
        const best = Math.min(...onboardAvail(initial, p).map((t) => dist(t.techId)));
        c.need(dist(j.techId) === best, `technician ${j.techId} is not the nearest available to the Warehouse`);
      }
      c.need(newNotes(initial, final, (n) => n.channel === 'email' && n.refId === j.id).length > 0, 'customer was not emailed the appointment confirmation');
      notesOnlyTo(c, initial, final, new Set([cu.id]));
      otherJobsUnchanged(c, initial, final, new Set());
      integrity(c, final);
      return c.reasons;
    },
  },

  complete_upsell_quote: {
    title: 'Complete a job with an extra repair, invoice + collect on the spot, and quote the follow-up',
    candidates(s, rng) {
      return rng.shuffle(s.jobs.filter((j) => j.status === 'in_progress')).map((j) => {
        const extra = rng.pick(SERVICES.filter((x) => x.trade === j.trade && x.kind === 'repair' && !j.items.some((i) => i.code === x.code)));
        const follow = rng.pick(SERVICES.filter((x) => x.trade === j.trade && x.kind === 'install' && x.priceCents >= 40000));
        return { jobId: j.id, extraCode: extra.code, followCode: follow.code };
      });
    },
    prompt(s, p) {
      const j = get(s, 'jobs', p.jobId);
      const ex = SERVICE_BY_CODE[p.extraCode];
      const fo = SERVICE_BY_CODE[p.followCode];
      return `The technician just finished job ${describeJob(s, j)} and, while on site, also did a "${ex.name}" (price-book ${ex.code}). Mark the job completed, then create its invoice with the job's existing line items plus one extra line: 1 x ${ex.code} at the standard price-book price (${fmtMoney(ex.priceCents)}). Send the invoice to the customer by SMS. The customer paid the full invoice amount by card on the spot: record that payment and text (SMS) them a receipt. Finally, quote the recommended follow-up: create an estimate at the same location for 1 x "${fo.name}" (${fo.code}) at the price-book price and send it to the customer by email. Do not change any other job.`;
    },
    solve(env, p) {
      const { job } = env.query('getJob', { jobId: p.jobId });
      env.act('completeJob', { jobId: job.id });
      const { invoice } = env.act('createInvoice', { jobId: job.id, items: [...itemsInput(job.items), { code: p.extraCode, qty: 1 }] });
      env.act('sendInvoice', { invoiceId: invoice.id, channel: 'sms' });
      env.act('recordPayment', { invoiceId: invoice.id, amountCents: invoice.totalCents, method: 'card', sendReceipt: 'sms' });
      const { estimate } = env.act('createEstimate', { customerId: job.customerId, locationId: job.locationId, trade: job.trade, items: [{ code: p.followCode, qty: 1 }] });
      env.act('sendEstimate', { estimateId: estimate.id, channel: 'email' });
    },
    check(final, initial, p) {
      const c = checker();
      const j0 = get(initial, 'jobs', p.jobId);
      const j = get(final, 'jobs', p.jobId);
      c.need(j.status === 'completed', `job should be completed, is ${j.status}`);
      const invs = final.invoices.filter((i) => i.jobId === j.id && i.status !== 'void');
      if (c.need(invs.length === 1, `expected one invoice for ${j.id}, found ${invs.length}`)) {
        const inv = invs[0];
        c.need(sameItems(inv.items, [...j0.items, { code: p.extraCode, qty: 1, unitPriceCents: SERVICE_BY_CODE[p.extraCode].priceCents }]), `invoice items should be the job items plus 1 x ${p.extraCode} at price-book price`);
        c.need(inv.sentAt != null && newNotes(initial, final, (n) => n.channel === 'sms' && n.refType === 'invoice' && n.refId === inv.id).length > 0, 'invoice was not sent by SMS');
        c.need(inv.status === 'paid', `invoice should be paid, is ${inv.status}`);
        const pays = created(initial, final, 'payments');
        if (c.need(pays.length === 1 && pays[0].invoiceId === inv.id && pays[0].method === 'card' && pays[0].amountCents === inv.totalCents, 'expected exactly one card payment for the full invoice amount')) {
          c.need(newNotes(initial, final, (n) => n.channel === 'sms' && n.refId === pays[0].id).length > 0, 'no SMS receipt for the payment');
        }
      }
      const ests = created(initial, final, 'estimates').filter((e) => e.customerId === j0.customerId);
      if (c.need(ests.length === 1, `expected exactly one new estimate for ${j0.customerId}, found ${ests.length}`)) {
        const e = ests[0];
        c.need(e.locationId === j0.locationId && e.trade === j0.trade, 'estimate should be at the job location, same trade');
        c.need(sameItems(e.items, priceBookItems([{ code: p.followCode, qty: 1 }])), `estimate should contain exactly 1 x ${p.followCode} at price-book price`);
        c.need(e.status === 'sent' && newNotes(initial, final, (n) => n.channel === 'email' && n.refType === 'estimate' && n.refId === e.id).length > 0, 'estimate should be sent by email');
      }
      otherJobsUnchanged(c, initial, final, new Set([j0.id]));
      otherMoneyUnchanged(c, initial, final, new Set(), new Set());
      notesOnlyTo(c, initial, final, new Set([j0.customerId]));
      integrity(c, final);
      return c.reasons;
    },
  },
};
Object.assign(KINDS, HARD_KINDS);
