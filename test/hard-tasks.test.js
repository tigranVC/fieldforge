// The 10 'hard' tasks (t31-t40): multi-step, cross-entity work. Each must fail on
// the untouched world and pass after the reference solution, on its own seed and
// re-instantiated on seeds 1, 2, 3; plausible partial/wrong solutions must fail.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateState, createEngine, invoiceBalance, addDays } from '../core/index.js';
import { loadTasks, checkTask, makeEnv, KINDS } from '../tasks/index.js';
import { instantiateTask } from '../tasks/generate.js';

const hard = loadTasks().filter((t) => (t.tags || []).includes('hard'));

test('exactly 10 tasks are tagged hard, all with distinct kinds', () => {
  assert.equal(hard.length, 10);
  assert.equal(new Set(hard.map((t) => t.kind)).size, 10);
  for (const t of hard) assert.match(t.id, /^t(3[1-9]|40)-/);
});

function solved(inst) {
  const engine = createEngine(inst.seed);
  KINDS[inst.kind].solve(makeEnv(engine), inst.params);
  return engine;
}

for (const t of hard) {
  for (const seed of [t.seed, 1, 2, 3]) {
    test(`hard ${t.id} on seed ${seed}: fails untouched, passes after reference solution`, () => {
      const inst = instantiateTask(t.id, seed);
      assert.equal(inst.seed, seed);
      assert.equal(checkTask(inst, generateState(seed)).pass, false, 'checker must fail on untouched state');
      const engine = solved(inst);
      assert.deepEqual(checkTask(inst, engine.state).reasons, []);
      // genuinely multi-step: several mutating actions
      assert.ok(engine.state.actionLog.length >= 3, `reference used only ${engine.state.actionLog.length} actions`);
    });
  }
}

// ---- negative tests: plausible partial / wrong solutions must fail ---------------
const byKind = (kind) => hard.find((t) => t.kind === kind);
const fresh = (task) => { const engine = createEngine(task.seed); return { engine, env: makeEnv(engine) }; };
const fails = (task, engine, msg) => assert.equal(checkTask(task, engine.state).pass, false, msg);

test('tech_leave_reassign: reassigning only the first job (or skipping notifications) fails', () => {
  const t = byKind('tech_leave_reassign');
  {
    const { engine, env } = fresh(t);
    const j = env.query('techSchedule', { techId: t.params.techId, date: t.params.dates[0] }).jobs[0];
    const best = env.query('findAvailableTechs', { jobId: j.id, date: j.date, start: j.startMin }).filter((x) => x.techId !== t.params.techId)[0];
    env.act('scheduleJob', { jobId: j.id, techId: best.techId, date: j.date, start: j.startMin, notify: true });
    fails(t, engine, 'only first job handled');
  }
  {
    const { engine, env } = fresh(t);
    for (const date of t.params.dates) {
      for (const j of env.query('techSchedule', { techId: t.params.techId, date }).jobs) {
        const best = env.query('findAvailableTechs', { jobId: j.id, date: j.date, start: j.startMin }).filter((x) => x.techId !== t.params.techId)[0];
        env.act('scheduleJob', { jobId: j.id, techId: best.techId, date: j.date, start: j.startMin }); // no notification
      }
    }
    fails(t, engine, 'reassigned without notifying customers');
  }
});

test('split_settlement: paying everything by card (ignoring the check) fails', () => {
  const t = byKind('split_settlement');
  const { engine, env } = fresh(t);
  for (const i of env.query('listInvoices', { customerId: t.params.customerId }).items.filter((x) => x.status === 'sent' || x.status === 'partially_paid')) {
    env.act('recordPayment', { invoiceId: i.id, amountCents: invoiceBalance(i), method: 'card', sendReceipt: 'email' });
  }
  fails(t, engine, 'all-card settlement');
});

test('rebill_invoice: stopping before re-applying the payment, or keeping the old price, fails', () => {
  const t = byKind('rebill_invoice');
  {
    const { engine, env } = fresh(t);
    env.act('refundPayment', { paymentId: t.params.paymentId, reason: 'billing error' });
    env.act('voidInvoice', { invoiceId: t.params.invoiceId, reason: 'billing error' });
    const old = engine.state.invoices.find((i) => i.id === t.params.invoiceId);
    const { invoice } = env.act('createInvoice', { jobId: old.jobId, items: old.items.map((i) => (i.code === 'PARTS' ? { ...i, unitPriceCents: t.params.newPartsCents } : { code: i.code, qty: i.qty })) });
    env.act('sendInvoice', { invoiceId: invoice.id });
    fails(t, engine, 'payment not re-applied');
  }
  {
    const { engine, env } = fresh(t);
    const x = engine.state.payments.find((p) => p.id === t.params.paymentId);
    env.act('refundPayment', { paymentId: x.id });
    env.act('voidInvoice', { invoiceId: t.params.invoiceId, reason: 'billing error' });
    const old = engine.state.invoices.find((i) => i.id === t.params.invoiceId);
    const { invoice } = env.act('createInvoice', { jobId: old.jobId }); // job items, uncorrected price
    env.act('sendInvoice', { invoiceId: invoice.id });
    env.act('recordPayment', { invoiceId: invoice.id, amountCents: x.amountCents, method: x.method });
    fails(t, engine, 'materials price not corrected');
  }
});

test('approve_earliest_zone: nearest tech ignoring the zone rule / a later slot fails', () => {
  const t = byKind('approve_earliest_zone');
  const { engine, env } = fresh(t);
  const { job } = env.act('approveEstimate', { estimateId: t.params.estimateId });
  env.act('updateJob', { jobId: job.id, priority: 'high' });
  const date = addDays(t.params.fromDate, 20); // well past the earliest slot (Sundays aside, all free)
  const day = new Date(`${date}T00:00:00Z`).getUTCDay() === 0 ? addDays(date, 1) : date;
  const any = env.query('findAvailableTechs', { jobId: job.id, date: day, start: 540 })[0];
  env.act('scheduleJob', { jobId: job.id, techId: any.techId, date: day, start: 540, notify: 'sms' });
  fails(t, engine, 'not the earliest same-zone slot');
});

test('commercial_credit_hold: also reminding residential customers fails', () => {
  const t = byKind('commercial_credit_hold');
  const { engine, env } = fresh(t);
  const cutoff = addDays(engine.state.meta.today, -t.params.days);
  const invs = env.query('listInvoices', { companyId: t.params.companyId, overdue: true }).items.filter((i) => i.dueDate < cutoff);
  for (const i of invs) env.act('notifyCustomer', { customerId: i.customerId, channel: 'email', refType: 'invoice', refId: i.id, message: 'Reminder' });
  for (const id of new Set(invs.map((i) => i.customerId))) env.act('updateCustomer', { customerId: id, notes: 'CREDIT HOLD' });
  fails(t, engine, 'residential customers included');
});

test('customer_moving: canceling jobs but leaving open estimates, or also canceling today\'s job, fails', () => {
  const t = byKind('customer_moving');
  const today = generateState(t.seed).meta.today;
  {
    const { engine, env } = fresh(t);
    for (const j of env.query('listJobs', { customerId: t.params.customerId }).items.filter((x) => x.status === 'unscheduled' || (x.status === 'scheduled' && x.date > today))) {
      env.act('cancelJob', { jobId: j.id, reason: 'customer moved', notify: 'email' });
    }
    const hasOpenEst = engine.state.estimates.some((e) => e.customerId === t.params.customerId && (e.status === 'draft' || e.status === 'sent'));
    if (hasOpenEst) fails(t, engine, 'open estimates left');
  }
  {
    const { engine, env } = fresh(t);
    KINDS[t.kind].solve(env, t.params);
    const other = engine.state.jobs.find((x) => x.customerId === t.params.customerId && (x.status === 'scheduled' || x.status === 'in_progress') && x.date === today)
      || engine.state.jobs.find((x) => x.customerId !== t.params.customerId && x.status === 'unscheduled');
    env.act('cancelJob', { jobId: other.id, reason: 'customer moved' });
    fails(t, engine, 'out-of-scope job canceled');
  }
});

test('offboard_reassign: just deactivating and unscheduling everything fails', () => {
  const t = byKind('offboard_reassign');
  const { engine, env } = fresh(t);
  const today = engine.state.meta.today;
  env.act('setTechnicianActive', { techId: t.params.techId, active: false });
  for (const j of engine.state.jobs.filter((x) => x.techId === t.params.techId && x.status === 'scheduled' && x.date > today)) {
    env.act('unscheduleJob', { jobId: j.id });
    env.act('notifyCustomer', { customerId: j.customerId, channel: 'email', refType: 'job', refId: j.id, message: 'We will call to rebook.' });
  }
  fails(t, engine, 'jobs that could be reassigned were unscheduled');
});

test('misapplied_payment: recording the new payment without refunding the old one fails', () => {
  const t = byKind('misapplied_payment');
  const { engine, env } = fresh(t);
  const x = engine.state.payments.find((p) => p.id === t.params.paymentId);
  env.act('recordPayment', { invoiceId: t.params.toInvoiceId, amountCents: x.amountCents, method: x.method, sendReceipt: 'sms' });
  fails(t, engine, 'old payment not refunded');
});
