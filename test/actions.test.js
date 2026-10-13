import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEngine, validateState, invoiceBalance, ACTIONS, QUERIES, SERVICE_BY_CODE } from '../core/index.js';

const fresh = () => createEngine(42);
const ok = (r) => { assert.ok(r.ok, r.error && `${r.error.code}: ${r.error.message}`); return r.result; };
const err = (r, code) => { assert.equal(r.ok, false); assert.equal(r.error.code, code, r.error.message); };

test('every action declares a description and params', () => {
  for (const [name, def] of Object.entries({ ...ACTIONS, ...QUERIES })) {
    assert.ok(def.description, name);
    assert.ok(Array.isArray(def.params), name);
  }
});

test('createCustomer + createJob + schedule + complete + invoice + pay', () => {
  const e = fresh();
  const { customer, location } = ok(e.dispatch('createCustomer', { companyId: 'CO-2', name: 'Test Person', phone: '555-1234', email: 't@example.com', address: '1 Main St', zone: 'North' }));
  assert.equal(location.customerId, customer.id);
  const { job } = ok(e.dispatch('createJob', { customerId: customer.id, trade: 'plumbing', serviceCode: 'PL-LEAK' }));
  assert.equal(job.status, 'unscheduled');
  assert.equal(job.durationMin, SERVICE_BY_CODE['PL-LEAK'].durationMin);
  const free = ok(e.query('findAvailableTechs', { jobId: job.id, date: '2026-03-10', start: '10:00' }));
  assert.ok(free.length > 0);
  for (let i = 1; i < free.length; i++) assert.ok(free[i - 1].distance <= free[i].distance);
  const { notification } = ok(e.dispatch('scheduleJob', { jobId: job.id, techId: free[0].techId, date: '2026-03-10', start: '10:00', notify: 'sms' }));
  assert.equal(notification.channel, 'sms');
  assert.equal(notification.to, '555-1234');
  err(e.dispatch('completeJob', { jobId: job.id }), 'INVALID_STATE'); // future date
  // move it to today later in the day, then complete
  const today = e.state.meta.today;
  let slot = null;
  for (let start = 630; start <= 900 && !slot; start += 30) {
    const freeToday = ok(e.query('findAvailableTechs', { jobId: job.id, date: today, start }));
    if (freeToday.length) slot = { techId: freeToday[0].techId, start };
  }
  assert.ok(slot, 'some plumber is free later today');
  ok(e.dispatch('scheduleJob', { jobId: job.id, techId: slot.techId, date: today, start: slot.start }));
  ok(e.dispatch('startJob', { jobId: job.id }));
  ok(e.dispatch('completeJob', { jobId: job.id, notes: 'replaced fitting' }));
  const { invoice } = ok(e.dispatch('createInvoice', { jobId: job.id }));
  err(e.dispatch('createInvoice', { jobId: job.id }), 'DUPLICATE');
  assert.equal(invoice.status, 'draft');
  assert.equal(invoice.taxCents, Math.round(invoice.subtotalCents * 0.06));
  const sent = ok(e.dispatch('sendInvoice', { invoiceId: invoice.id }));
  assert.equal(sent.invoice.status, 'sent');
  assert.equal(sent.invoice.dueDate, '2026-03-24');
  err(e.dispatch('recordPayment', { invoiceId: invoice.id, amountCents: invoice.totalCents + 1, method: 'card' }), 'OVERPAYMENT');
  ok(e.dispatch('recordPayment', { invoiceId: invoice.id, amountCents: 1000, method: 'cash' }));
  assert.equal(e.state.invoices.find((i) => i.id === invoice.id).status, 'partially_paid');
  err(e.dispatch('voidInvoice', { invoiceId: invoice.id }), 'HAS_PAYMENTS');
  const { invoice: paid } = ok(e.dispatch('recordPayment', { invoiceId: invoice.id, amountCents: invoice.totalCents - 1000, method: 'card' }));
  assert.equal(paid.status, 'paid');
  assert.deepEqual(validateState(e.state), []);
});

test('scheduling guards: trade, company, overlap, shift, past, inactive', () => {
  const e = fresh();
  const s = e.state;
  const job = s.jobs.find((j) => j.status === 'unscheduled' && j.companyId === 'CO-1');
  const wrongTrade = s.technicians.find((t) => t.companyId === 'CO-1' && !t.trades.includes(job.trade));
  err(e.dispatch('scheduleJob', { jobId: job.id, techId: wrongTrade.id, date: '2026-03-12', start: 600 }), 'TRADE_MISMATCH');
  const otherCo = s.technicians.find((t) => t.companyId !== 'CO-1' && t.trades.includes(job.trade));
  err(e.dispatch('scheduleJob', { jobId: job.id, techId: otherCo.id, date: '2026-03-12', start: 600 }), 'WRONG_COMPANY');
  const tech = s.technicians.find((t) => t.companyId === 'CO-1' && t.trades.includes(job.trade));
  err(e.dispatch('scheduleJob', { jobId: job.id, techId: tech.id, date: '2026-03-12', start: tech.shiftEnd - 15 }), 'OUTSIDE_SHIFT');
  err(e.dispatch('scheduleJob', { jobId: job.id, techId: tech.id, date: '2026-03-01', start: 600 }), 'PAST_SLOT');
  err(e.dispatch('scheduleJob', { jobId: job.id, techId: tech.id, date: s.meta.today, start: 480 }), 'PAST_SLOT');
  err(e.dispatch('scheduleJob', { jobId: job.id, techId: tech.id, date: '2026-3-12', start: 600 }), 'INVALID_PARAMS');
  const busy = s.jobs.find((j) => j.status === 'scheduled' && j.techId === tech.id && j.date > s.meta.today);
  if (busy) err(e.dispatch('scheduleJob', { jobId: job.id, techId: tech.id, date: busy.date, start: busy.startMin }), 'CONFLICT');
  ok(e.dispatch('setTechnicianActive', { techId: tech.id, active: false }));
  err(e.dispatch('scheduleJob', { jobId: job.id, techId: tech.id, date: '2026-03-12', start: 600 }), 'TECH_INACTIVE');
  err(e.dispatch('scheduleJob', { jobId: 'JOB-999999', techId: tech.id, date: '2026-03-12', start: 600 }), 'NOT_FOUND');
  err(e.dispatch('nope', {}), 'UNKNOWN_ACTION');
  assert.equal(s.actionLog.length, 1);
});

test('failed actions do not mutate state', () => {
  const e = fresh();
  const before = JSON.stringify(e.state);
  e.dispatch('createJob', { customerId: 'CUS-00001', trade: 'hvac', items: [{ code: 'PL-LEAK', qty: 1 }] });
  e.dispatch('createCustomer', { companyId: 'CO-1', name: 'X', address: 'Y', zone: 'Mars' });
  e.dispatch('recordPayment', { invoiceId: e.state.invoices.find((i) => i.status === 'sent').id, amountCents: -5, method: 'card' });
  assert.equal(JSON.stringify(e.state), before);
});

test('estimate lifecycle: create, update (discount), send, approve -> job', () => {
  const e = fresh();
  const cust = e.state.customers[10];
  const { estimate } = ok(e.dispatch('createEstimate', { customerId: cust.id, trade: 'electrical', items: [{ code: 'EL-PANL', qty: 1 }, { code: 'EL-SURG' }] }));
  assert.equal(estimate.subtotalCents, 345000 + 42000);
  const { estimate: upd } = ok(e.dispatch('updateEstimate', { estimateId: estimate.id, items: [...estimate.items.map((i) => ({ code: i.code, qty: i.qty })), { description: 'Discount', qty: 1, unitPriceCents: -10000 }] }));
  assert.equal(upd.subtotalCents, 377000);
  ok(e.dispatch('sendEstimate', { estimateId: estimate.id }));
  const { job } = ok(e.dispatch('approveEstimate', { estimateId: estimate.id }));
  assert.equal(job.estimateId, estimate.id);
  assert.equal(job.status, 'unscheduled');
  assert.equal(job.durationMin, 540);
  err(e.dispatch('declineEstimate', { estimateId: estimate.id }), 'INVALID_STATE');
  const other = e.state.estimates.find((x) => x.status === 'sent');
  assert.equal(ok(e.dispatch('declineEstimate', { estimateId: other.id, reason: 'too pricey' })).estimate.status, 'declined');
});

test('refund reopens invoice balance', () => {
  const e = fresh();
  const pay = e.state.payments.find((p) => p.status === 'completed' && e.state.invoices.find((i) => i.id === p.invoiceId).status === 'paid');
  const { invoice } = ok(e.dispatch('refundPayment', { paymentId: pay.id }));
  assert.equal(invoiceBalance(invoice), pay.amountCents);
  err(e.dispatch('refundPayment', { paymentId: pay.id }), 'INVALID_STATE');
  assert.deepEqual(validateState(e.state), []);
});

test('cancel, unschedule, update and notify', () => {
  const e = fresh();
  const job = e.state.jobs.find((j) => j.status === 'scheduled' && j.date > e.state.meta.today);
  ok(e.dispatch('updateJob', { jobId: job.id, priority: 'high', notes: 'gate code 1234' }));
  ok(e.dispatch('unscheduleJob', { jobId: job.id }));
  assert.equal(e.state.jobs.find((j) => j.id === job.id).techId, null);
  const { notification } = ok(e.dispatch('cancelJob', { jobId: job.id, reason: 'moved away', notify: 'email' }));
  assert.equal(notification.template, 'job_canceled');
  err(e.dispatch('cancelJob', { jobId: job.id }), 'INVALID_STATE');
  const cu = e.state.customers[0];
  err(e.dispatch('notifyCustomer', { customerId: cu.id, channel: 'fax', message: 'x' }), 'INVALID_PARAMS');
  const foreignJob = e.state.jobs.find((j) => j.customerId !== cu.id);
  err(e.dispatch('notifyCustomer', { customerId: cu.id, channel: 'sms', message: 'x', refType: 'job', refId: foreignJob.id }), 'INVALID_PARAMS');
  ok(e.dispatch('updateCustomer', { customerId: cu.id, phone: '(555) 000-1111', prefersSms: true }));
  assert.equal(e.state.customers[0].phone, '(555) 000-1111');
  const { location } = ok(e.dispatch('addLocation', { customerId: cu.id, address: '9 New Rd', zone: 'East' }));
  assert.equal(location.zone, 'East');
});

test('queries: lists, schedule, free slots, report', () => {
  const e = fresh();
  const r = ok(e.query('listJobs', { status: 'unscheduled', limit: 5 }));
  assert.equal(r.items.length, 5);
  assert.ok(r.total > 50);
  const tech = e.state.technicians[0];
  const sched = ok(e.query('techSchedule', { techId: tech.id, date: e.state.meta.today }));
  const slots = ok(e.query('freeSlots', { techId: tech.id, date: '2026-03-12', durationMin: 60 }));
  assert.ok(Array.isArray(sched.jobs) && Array.isArray(slots));
  const rep = ok(e.query('report', { companyId: 'CO-1' }));
  assert.ok(rep.revenue.collectedCents > 0);
  assert.equal(rep.technicians.length, e.state.technicians.filter((t) => t.companyId === 'CO-1').length);
  const cs = ok(e.query('getCustomer', { customerId: 'CUS-00001' }));
  assert.equal(cs.customer.id, 'CUS-00001');
  assert.ok(ok(e.query('priceBook', { trade: 'hvac' })).every((s) => s.trade === 'hvac'));
  assert.equal(e.query('listX', {}).ok, false);
});
