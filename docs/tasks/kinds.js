// Task kinds: each kind knows how to pick concrete entities from a seeded
// world (candidates), phrase the instruction (prompt), solve it through the
// public API (reference solution) and verify the resulting state (check).
//
// check(final, initial, params) returns a list of failure reasons; [] = pass.
import {
  TRADE_LABELS, SERVICE_BY_CODE, SERVICES, FIRST_NAMES, LAST_NAMES, STREETS, STREET_SUFFIXES,
  byId, techDistance, findAvailableTechs, validateState, invoiceBalance, itemsDuration, fmtTime, fmtMoney,
  addDays, dayOfWeek, isPastSlot, slotProblem,
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

