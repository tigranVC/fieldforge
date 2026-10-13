// Express REST API around a single in-memory engine.
import express from 'express';
import { createEngine, ACTIONS, QUERIES, DEFAULT_SEED, validateState } from '../core/index.js';
import { loadTasks, checkTask } from '../tasks/index.js';
import { instantiateTask } from '../tasks/generate.js';

const STATE_COLLECTIONS = ['companies', 'technicians', 'customers', 'locations', 'jobs', 'estimates', 'invoices', 'payments', 'notifications', 'actionLog'];

// Friendly REST aliases: [method, path, action, map(req) -> params]
const ROUTES = [
  ['post', '/api/customers', 'createCustomer', (r) => r.body],
  ['patch', '/api/customers/:id', 'updateCustomer', (r) => ({ ...r.body, customerId: r.params.id })],
  ['post', '/api/customers/:id/locations', 'addLocation', (r) => ({ ...r.body, customerId: r.params.id })],
  ['post', '/api/jobs', 'createJob', (r) => r.body],
  ['patch', '/api/jobs/:id', 'updateJob', (r) => ({ ...r.body, jobId: r.params.id })],
  ['post', '/api/jobs/:id/schedule', 'scheduleJob', (r) => ({ ...r.body, jobId: r.params.id })],
  ['post', '/api/jobs/:id/unschedule', 'unscheduleJob', (r) => ({ jobId: r.params.id })],
  ['post', '/api/jobs/:id/start', 'startJob', (r) => ({ jobId: r.params.id })],
  ['post', '/api/jobs/:id/complete', 'completeJob', (r) => ({ ...r.body, jobId: r.params.id })],
  ['post', '/api/jobs/:id/cancel', 'cancelJob', (r) => ({ ...r.body, jobId: r.params.id })],
  ['post', '/api/estimates', 'createEstimate', (r) => r.body],
  ['patch', '/api/estimates/:id', 'updateEstimate', (r) => ({ ...r.body, estimateId: r.params.id })],
  ['post', '/api/estimates/:id/send', 'sendEstimate', (r) => ({ ...r.body, estimateId: r.params.id })],
  ['post', '/api/estimates/:id/approve', 'approveEstimate', (r) => ({ estimateId: r.params.id })],
  ['post', '/api/estimates/:id/decline', 'declineEstimate', (r) => ({ ...r.body, estimateId: r.params.id })],
  ['post', '/api/invoices', 'createInvoice', (r) => r.body],
  ['post', '/api/invoices/:id/send', 'sendInvoice', (r) => ({ ...r.body, invoiceId: r.params.id })],
  ['post', '/api/invoices/:id/void', 'voidInvoice', (r) => ({ ...r.body, invoiceId: r.params.id })],
  ['post', '/api/invoices/:id/payments', 'recordPayment', (r) => ({ ...r.body, invoiceId: r.params.id })],
  ['post', '/api/payments/:id/refund', 'refundPayment', (r) => ({ ...r.body, paymentId: r.params.id })],
  ['post', '/api/customers/:id/notify', 'notifyCustomer', (r) => ({ ...r.body, customerId: r.params.id })],
  ['post', '/api/technicians/:id/active', 'setTechnicianActive', (r) => ({ ...r.body, techId: r.params.id })],
];

// Read endpoints mapping to queries: [path, query, map(req) -> params]
const READS = [
  ['/api/customers', 'listCustomers', (r) => r.query],
  ['/api/customers/:id', 'getCustomer', (r) => ({ customerId: r.params.id })],
  ['/api/locations', 'listLocations', (r) => r.query],
  ['/api/technicians', 'listTechnicians', (r) => r.query],
  ['/api/technicians/:id/schedule', 'techSchedule', (r) => ({ ...r.query, techId: r.params.id })],
  ['/api/technicians/:id/free-slots', 'freeSlots', (r) => ({ ...r.query, techId: r.params.id })],
  ['/api/jobs', 'listJobs', (r) => r.query],
  ['/api/jobs/:id', 'getJob', (r) => ({ jobId: r.params.id })],
  ['/api/estimates', 'listEstimates', (r) => r.query],
  ['/api/invoices', 'listInvoices', (r) => r.query],
  ['/api/payments', 'listPayments', (r) => r.query],
  ['/api/notifications', 'listNotifications', (r) => r.query],
  ['/api/availability', 'findAvailableTechs', (r) => r.query],
  ['/api/price-book', 'priceBook', (r) => r.query],
  ['/api/reports/summary', 'report', (r) => r.query],
];

export function createApp({ seed = DEFAULT_SEED } = {}) {
  const engine = createEngine(seed);
  let activeTask = null;
  const app = express();
  app.use(express.json({ limit: '2mb' }));

  const send = (res, r) => res.status(r.ok ? 200 : r.error.code === 'NOT_FOUND' ? 404 : r.error.code.startsWith('UNKNOWN') ? 404 : 422).json(r);
  const getEntity = (coll, id) => engine.state[coll].find((e) => e.id === id);

  app.get('/api/health', (req, res) => res.json({ ok: true, seed: engine.seed, today: engine.state.meta.today }));

  const reset = (req, res) => {
    const s = req.body?.seed ?? req.query.seed ?? engine.seed;
    engine.reset(/^\d+$/.test(String(s)) ? Number(s) : String(s));
    activeTask = null;
    res.json({ ok: true, seed: engine.seed, counts: counts() });
  };
  app.post('/reset', reset);
  app.post('/api/reset', reset);

  const counts = () => Object.fromEntries(STATE_COLLECTIONS.map((k) => [k, engine.state[k].length]));
  app.get('/api/state', (req, res) => {
    const include = req.query.include ? String(req.query.include).split(',') : STATE_COLLECTIONS;
    const out = { meta: engine.state.meta };
    for (const k of include) if (STATE_COLLECTIONS.includes(k)) out[k] = engine.state[k];
    res.json(out);
  });
  app.get('/api/state/summary', (req, res) => res.json({ meta: engine.state.meta, counts: counts(), activeTask: activeTask?.id ?? null }));
  app.get('/api/state/validate', (req, res) => { const problems = validateState(engine.state); res.json({ ok: problems.length === 0, problems }); });
  app.get('/api/action-log', (req, res) => res.json(engine.state.actionLog));

  app.get('/api/actions', (req, res) => res.json(Object.fromEntries(Object.entries(ACTIONS).map(([k, v]) => [k, { description: v.description, params: v.params.map(([name, type, required, description]) => ({ name, type, required, description })) }]))));
  app.get('/api/queries', (req, res) => res.json(Object.fromEntries(Object.entries(QUERIES).map(([k, v]) => [k, { description: v.description, params: v.params.map(([name, type, required, description]) => ({ name, type, required, description })) }]))));
  app.post('/api/actions/:type', (req, res) => send(res, engine.dispatch(req.params.type, req.body || {})));
  app.post('/api/queries/:name', (req, res) => send(res, engine.query(req.params.name, req.body || {})));

  for (const [method, path, action, map] of ROUTES) app[method](path, (req, res) => send(res, engine.dispatch(action, map(req))));
  for (const [path, query, map] of READS) app.get(path, (req, res) => send(res, engine.query(query, map(req))));
  for (const [coll, path] of [['locations', 'locations'], ['estimates', 'estimates'], ['invoices', 'invoices'], ['payments', 'payments'], ['technicians', 'technicians'], ['notifications', 'notifications']]) {
    app.get(`/api/${path}/:id`, (req, res) => {
      const e = getEntity(coll, req.params.id);
      if (!e) return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: `${req.params.id} not found` } });
      res.json({ ok: true, result: e });
    });
  }

  // ---- tasks (RL episode helpers) ----
  const tasks = loadTasks();
  const findTask = (id) => tasks.find((t) => t.id === id);
  app.get('/api/tasks', (req, res) => res.json(tasks.map(({ params, ...t }) => t)));
  app.get('/api/tasks/:id', (req, res) => {
    const t = findTask(req.params.id);
    if (!t) return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: 'task not found' } });
    const { params, ...pub } = t;
    res.json(pub);
  });
  // Body/query `seed` (optional): run the task in another seeded world; the task
  // is re-instantiated for that world (new entities, new prompt).
  app.post('/api/tasks/:id/start', (req, res) => {
    let t = findTask(req.params.id);
    if (!t) return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: 'task not found' } });
    const s = req.body?.seed ?? req.query.seed;
    if (s !== undefined && s !== null && String(s) !== String(t.seed)) {
      try {
        t = instantiateTask(t.id, /^\d+$/.test(String(s)) ? Number(s) : String(s));
      } catch (e) {
        return res.status(422).json({ ok: false, error: { code: 'INVALID_PARAMS', message: e.message } });
      }
    }
    engine.reset(t.seed);
    activeTask = t;
    res.json({ ok: true, task: { id: t.id, seed: t.seed, prompt: t.prompt } });
  });
  app.post('/api/tasks/:id/check', (req, res) => {
    const t = findTask(req.params.id);
    if (!t) return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: 'task not found' } });
    const inst = activeTask?.id === t.id ? activeTask : t; // seeded instance from /start, if any
    res.json({ ok: true, taskId: t.id, seed: inst.seed, ...checkTask(inst, engine.state) });
  });

  app.use((err, req, res, next) => {
    if (err.type === 'entity.parse.failed') return res.status(400).json({ ok: false, error: { code: 'BAD_JSON', message: err.message } });
    res.status(500).json({ ok: false, error: { code: 'INTERNAL', message: err.message } });
  });

  app.engine = engine;
  return app;
}
