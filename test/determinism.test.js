import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateState, validateState, Rng, replay, createEngine } from '../core/index.js';

test('same seed produces identical state', () => {
  assert.equal(JSON.stringify(generateState(42)), JSON.stringify(generateState(42)));
  assert.equal(JSON.stringify(generateState('abc')), JSON.stringify(generateState('abc')));
});

test('different seeds produce different worlds', () => {
  assert.notEqual(JSON.stringify(generateState(1).jobs), JSON.stringify(generateState(2).jobs));
});

test('PRNG sequence is stable across runs', () => {
  const a = new Rng(7);
  const seq = Array.from({ length: 5 }, () => a.int(0, 1000));
  const b = new Rng(7);
  assert.deepEqual(seq, Array.from({ length: 5 }, () => b.int(0, 1000)));
  assert.deepEqual(seq, [...seq]);
});

test('seeded world has the expected shape and size', () => {
  const s = generateState(42);
  assert.equal(s.companies.length, 3);
  assert.equal(s.technicians.length, 40);
  assert.equal(s.customers.length, 1000);
  assert.ok(s.jobs.length > 4500 && s.jobs.length < 5600, `jobs=${s.jobs.length}`);
  assert.ok(s.estimates.length > 400);
  assert.ok(s.invoices.length > 3000);
  assert.ok(s.payments.length > 2500);
  for (const co of s.companies) {
    for (const trade of ['hvac', 'plumbing', 'electrical']) {
      assert.ok(s.technicians.some((t) => t.companyId === co.id && t.trades.includes(trade)), `${co.id} lacks ${trade}`);
    }
  }
  const statuses = new Set(s.jobs.map((j) => j.status));
  for (const st of ['unscheduled', 'scheduled', 'in_progress', 'completed', 'canceled']) assert.ok(statuses.has(st), `no ${st} jobs`);
});

test('seeded worlds satisfy all invariants', () => {
  for (const seed of [42, 1, 101, 'xyz']) assert.deepEqual(validateState(generateState(seed)), [], `seed ${seed}`);
});

test('replaying the action log reproduces the state', () => {
  const e = createEngine(5);
  const job = e.state.jobs.find((j) => j.status === 'unscheduled');
  const techs = e.query('findAvailableTechs', { jobId: job.id, date: '2026-03-11', start: 600 }).result;
  assert.ok(e.dispatch('scheduleJob', { jobId: job.id, techId: techs[0].techId, date: '2026-03-11', start: 600, notify: 'sms' }).ok);
  const cust = e.state.customers[3];
  assert.ok(e.dispatch('notifyCustomer', { customerId: cust.id, channel: 'email', message: 'hi' }).ok);
  assert.equal(e.dispatch('voidInvoice', { invoiceId: 'INV-99999' }).ok, false); // failures are not logged
  const again = replay(5, e.state.actionLog);
  assert.equal(JSON.stringify(again), JSON.stringify(e.state));
});
