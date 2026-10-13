// window.fieldforge — in-browser API mirroring every UI action.
// State is persisted to localStorage as {seed, actions[]} and rebuilt on load
// by replaying the action log over the deterministic seed.
import * as core from './core/index.js';
import { KINDS } from './tasks/kinds.js';

const KEY = 'fieldforge:v1';

function readSaved() {
  try { return JSON.parse(localStorage.getItem(KEY)); } catch { return null; }
}

function boot() {
  const saved = readSaved();
  if (saved && saved.seed != null) {
    try {
      return { engine: core.createEngine(saved.seed, { state: core.replay(saved.seed, saved.actions || []) }), taskId: saved.taskId || null };
    } catch (e) {
      console.warn('FieldForge: saved session could not be replayed, starting fresh', e);
    }
  }
  return { engine: core.createEngine(core.DEFAULT_SEED), taskId: null };
}

const booted = boot();
const engine = booted.engine;
let activeTaskId = booted.taskId;

function persist() {
  try {
    localStorage.setItem(KEY, JSON.stringify({ seed: engine.seed, taskId: activeTaskId, actions: engine.state.actionLog.map((a) => ({ type: a.type, params: a.params })) }));
  } catch (e) {
    console.warn('FieldForge: could not persist session', e);
  }
}
engine.subscribe(persist);

let tasksPromise = null;
const loadTasks = () => (tasksPromise ||= fetch(new URL('./tasks/tasks.json', import.meta.url)).then((r) => r.json()));

const describe = (reg) => Object.fromEntries(Object.entries(reg).map(([k, v]) => [k, { description: v.description, params: v.params.map(([name, type, required, description]) => ({ name, type, required, description })) }]));

const api = {
  version: '1.0.0',
  core,
  get state() { return engine.state; },
  get seed() { return engine.seed; },
  get activeTaskId() { return activeTaskId; },
  /** Run an action by name: returns {ok, result} or {ok:false, error:{code,message}}. */
  dispatch: (type, params) => engine.dispatch(type, params),
  /** Run a read-only query by name. */
  query: (name, params) => engine.query(name, params),
  /** Reset to a pristine seeded world (default: current seed). */
  reset(seed = engine.seed) {
    activeTaskId = null;
    engine.reset(/^\d+$/.test(String(seed)) ? Number(seed) : String(seed));
    return { ok: true, seed: engine.seed };
  },
  subscribe: (fn) => engine.subscribe(fn),
  validate: () => core.validateState(engine.state),
  notifications: () => engine.state.notifications.slice(),
  actionLog: () => engine.state.actionLog.slice(),
  actions: describe(core.ACTIONS),
  queries: describe(core.QUERIES),
  async listTasks() {
    return (await loadTasks()).map(({ params, ...t }) => t);
  },
  async startTask(id) {
    const t = (await loadTasks()).find((x) => x.id === id);
    if (!t) return { ok: false, error: { code: 'NOT_FOUND', message: `task ${id} not found` } };
    engine.reset(t.seed);
    activeTaskId = t.id;
    persist();
    return { ok: true, task: { id: t.id, seed: t.seed, prompt: t.prompt } };
  },
  async checkTask(id = activeTaskId) {
    const t = (await loadTasks()).find((x) => x.id === id);
    if (!t) return { ok: false, error: { code: 'NOT_FOUND', message: `task ${id} not found` } };
    if (String(engine.seed) !== String(t.seed)) return { ok: true, taskId: t.id, pass: false, reasons: [`current seed ${engine.seed} != task seed ${t.seed}; call startTask first`] };
    let reasons;
    try { reasons = KINDS[t.kind].check(engine.state, core.generateState(t.seed), t.params); } catch (e) { reasons = [`checker error: ${e.message}`]; }
    return { ok: true, taskId: t.id, pass: reasons.length === 0, reasons };
  },
  help() {
    const lines = ['FieldForge browser API (window.fieldforge)', '', 'Actions (fieldforge.<name>(params) or fieldforge.dispatch(name, params)):'];
    for (const [k, v] of Object.entries(core.ACTIONS)) lines.push(`  ${k}(${v.params.map((p) => (p[2] ? p[0] : `${p[0]}?`)).join(', ')}) - ${v.description}`);
    lines.push('', 'Queries (fieldforge.<name>(params) or fieldforge.query(name, params)):');
    for (const [k, v] of Object.entries(core.QUERIES)) lines.push(`  ${k}(${v.params.map((p) => (p[2] ? p[0] : `${p[0]}?`)).join(', ')}) - ${v.description}`);
    lines.push('', 'Other: state, seed, reset(seed), validate(), notifications(), actionLog(), listTasks(), startTask(id), checkTask(id)');
    return lines.join('\n');
  },
};
for (const name of Object.keys(core.ACTIONS)) api[name] = (params) => engine.dispatch(name, params);
for (const name of Object.keys(core.QUERIES)) api[name] = (params) => engine.query(name, params);

window.fieldforge = api;
export default api;
