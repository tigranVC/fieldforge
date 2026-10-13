// Task harness: load tasks, build an environment for a task, run the
// reference solution, and check a resulting state.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createEngine, generateState } from '../core/index.js';
import { KINDS } from './kinds.js';

const here = dirname(fileURLToPath(import.meta.url));
export const TASKS_FILE = join(here, 'tasks.json');

export function loadTasks() {
  return JSON.parse(readFileSync(TASKS_FILE, 'utf8'));
}

const initialCache = new Map();
/** Pristine initial state for a seed (cached; do not mutate). */
export function initialStateFor(seed) {
  if (!initialCache.has(seed)) initialCache.set(seed, generateState(seed));
  return initialCache.get(seed);
}

/** Wrap an engine with throwing helpers, the interface reference solutions use. */
export function makeEnv(engine) {
  return {
    get state() { return engine.state; },
    act(type, params) {
      const r = engine.dispatch(type, params);
      if (!r.ok) throw new Error(`${type} failed: ${r.error.code} ${r.error.message}`);
      return r.result;
    },
    query(name, params) {
      const r = engine.query(name, params);
      if (!r.ok) throw new Error(`${name} failed: ${r.error.message}`);
      return r.result;
    },
  };
}

/** Check a final state for a task. Returns { pass, reasons }. */
export function checkTask(task, finalState) {
  const kind = KINDS[task.kind];
  if (!kind) throw new Error(`unknown task kind ${task.kind}`);
  if (String(finalState.meta.seed) !== String(task.seed)) return { pass: false, reasons: [`state seed ${finalState.meta.seed} != task seed ${task.seed}`] };
  let reasons;
  try {
    reasons = kind.check(finalState, initialStateFor(task.seed), task.params);
  } catch (e) {
    reasons = [`checker error: ${e.message}`];
  }
  return { pass: reasons.length === 0, reasons };
}

/** Run the reference solution on a fresh engine for the task; returns the engine. */
export function solveTask(task) {
  const engine = createEngine(task.seed);
  KINDS[task.kind].solve(makeEnv(engine), task.params);
  return engine;
}

export { KINDS };
