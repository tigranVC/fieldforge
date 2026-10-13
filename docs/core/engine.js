// Engine: owns a state object and applies actions/queries. Used by the SPA
// (wrapped with localStorage persistence), the REST server, tasks and tests.
import { ACTIONS } from './actions.js';
import { QUERIES } from './queries.js';
import { generateState, DEFAULT_SEED } from './seed.js';
import { ActionError } from './model.js';
import { clone } from './util.js';

export function runAction(state, type, params = {}) {
  const def = ACTIONS[type];
  if (!def) return { ok: false, error: { code: 'UNKNOWN_ACTION', message: `unknown action ${type}` } };
  const p = clone(params ?? {});
  try {
    const result = def.run(state, p);
    state.actionLog.push({ seq: state.actionLog.length + 1, type, params: clone(params ?? {}) });
    return { ok: true, result: clone(result) };
  } catch (e) {
    if (e instanceof ActionError) return { ok: false, error: { code: e.code, message: e.message, ...(e.details ? { details: e.details } : {}) } };
    throw e;
  }
}

export function runQuery(state, name, params = {}) {
  const def = QUERIES[name];
  if (!def) return { ok: false, error: { code: 'UNKNOWN_QUERY', message: `unknown query ${name}` } };
  try {
    return { ok: true, result: clone(def.run(state, params ?? {})) };
  } catch (e) {
    if (e instanceof ActionError) return { ok: false, error: { code: e.code, message: e.message } };
    throw e;
  }
}

/** Rebuild a state from a seed plus a log of successful actions. */
export function replay(seed, actions = []) {
  const state = generateState(seed);
  for (const a of actions) {
    const r = runAction(state, a.type, a.params);
    if (!r.ok) throw new Error(`replay failed at ${a.type}: ${r.error.message}`);
  }
  return state;
}

export function createEngine(seed = DEFAULT_SEED, { state: initial } = {}) {
  let state = initial || generateState(seed);
  const listeners = new Set();
  const emit = (evt) => listeners.forEach((fn) => fn(evt));
  return {
    get state() { return state; },
    get seed() { return state.meta.seed; },
    dispatch(type, params) {
      const r = runAction(state, type, params);
      if (r.ok) emit({ kind: 'action', type, params });
      return r;
    },
    query(name, params) { return runQuery(state, name, params); },
    reset(newSeed = state.meta.seed) {
      state = generateState(newSeed);
      emit({ kind: 'reset', seed: newSeed });
      return state;
    },
    load(newState) {
      state = newState;
      emit({ kind: 'load' });
      return state;
    },
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
  };
}
