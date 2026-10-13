import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server/app.js';
import { loadTasks } from '../tasks/index.js';

let server;
let base;
before(async () => {
  const app = createApp({ seed: 42 });
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

const call = async (method, path, body) => {
  const res = await fetch(base + path, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json() };
};

test('health and state summary', async () => {
  const { body } = await call('GET', '/api/state/summary');
  assert.equal(body.meta.seed, 42);
  assert.equal(body.counts.technicians, 40);
  assert.equal(body.counts.customers, 1000);
});

test('REST actions mirror the core actions and log notifications', async () => {
  await call('POST', '/reset', { seed: 42 });
  const jobs = (await call('GET', '/api/jobs?status=unscheduled&limit=1')).body.result.items;
  const job = jobs[0];
  const avail = (await call('GET', `/api/availability?jobId=${job.id}&date=2026-03-11&start=10:00`)).body.result;
  assert.ok(avail.length > 0);
  const r = await call('POST', `/api/jobs/${job.id}/schedule`, { techId: avail[0].techId, date: '2026-03-11', start: '10:00', notify: 'email' });
  assert.equal(r.status, 200);
  assert.equal(r.body.result.job.status, 'scheduled');
  const notes = (await call('GET', `/api/notifications?refId=${job.id}`)).body.result.items;
  assert.equal(notes.length, 1);
  const bad = await call('POST', `/api/jobs/${job.id}/schedule`, { techId: 'TEC-999', date: '2026-03-11', start: '10:00' });
  assert.equal(bad.status, 404);
  const generic = await call('POST', '/api/actions/unscheduleJob', { jobId: job.id });
  assert.equal(generic.body.ok, true);
  const log = (await call('GET', '/api/action-log')).body;
  assert.deepEqual(log.map((a) => a.type), ['scheduleJob', 'unscheduleJob']);
  const unknown = await call('POST', '/api/actions/fly', {});
  assert.equal(unknown.status, 404);
  const conflict = await call('POST', '/api/invoices/INV-00001/void', {});
  assert.equal(conflict.status, 422);
});

test('POST /reset restores pristine state', async () => {
  await call('POST', '/api/customers/CUS-00001/notify', { channel: 'sms', message: 'hello' });
  assert.ok((await call('GET', '/api/state/summary')).body.counts.notifications > 0);
  const r = await call('POST', '/reset', { seed: 7 });
  assert.equal(r.body.seed, 7);
  assert.equal(r.body.counts.notifications, 0);
  assert.equal(r.body.counts.actionLog, 0);
});

test('state endpoint with include filter, actions catalogue, reports', async () => {
  const s = (await call('GET', '/api/state?include=technicians')).body;
  assert.equal(s.technicians.length, 40);
  assert.equal(s.jobs, undefined);
  const actions = (await call('GET', '/api/actions')).body;
  assert.ok(actions.scheduleJob.params.some((p) => p.name === 'techId' && p.required));
  const rep = (await call('GET', '/api/reports/summary?companyId=CO-2')).body.result;
  assert.equal(rep.companyId, 'CO-2');
  assert.equal((await call('GET', '/api/state/validate')).body.ok, true);
});

test('task episode over HTTP: start, act, check', async () => {
  const task = loadTasks().find((t) => t.kind === 'void_invoice');
  const list = (await call('GET', '/api/tasks')).body;
  assert.equal(list.length, 30);
  assert.equal(list[0].params, undefined); // hidden from agents
  await call('POST', `/api/tasks/${task.id}/start`);
  assert.equal((await call('POST', `/api/tasks/${task.id}/check`)).body.pass, false);
  await call('POST', `/api/invoices/${task.params.invoiceId}/void`, { reason: 'warranty' });
  const c = (await call('POST', `/api/tasks/${task.id}/check`)).body;
  assert.equal(c.pass, true, c.reasons.join('; '));
});
