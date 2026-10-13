#!/usr/bin/env node
// Regenerates tasks/tasks.json from specs.js. For each spec, candidates are
// tried in a deterministic order until one is (a) feasible, (b) solved by the
// reference solution and (c) fails the checker on the untouched state.
import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { Rng, createEngine, clone } from '../core/index.js';
import { KINDS } from './kinds.js';
import { TASK_SPECS } from './specs.js';
import { initialStateFor, makeEnv, TASKS_FILE } from './index.js';

export function buildTask(spec, seedOverride) {
  const kind = KINDS[spec.kind];
  // seedOverride: build an instance of the same task in another seeded world
  // (benchmark multi-seed runs); entities are re-picked for that world.
  const seed = seedOverride ?? spec.seed;
  const initial = initialStateFor(seed);
  const rng = new Rng(seedOverride === undefined ? `task:${spec.id}` : `task:${spec.id}:${seed}`);
  const cands = kind.candidates(initial, rng, spec.variant || {});
  for (const params of cands.slice(0, 200)) {
    if (kind.feasible && !kind.feasible(initial, params)) continue;
    if (kind.check(initial, initial, params).length === 0) continue;
    const engine = createEngine(seed, { state: clone(initial) });
    try {
      kind.solve(makeEnv(engine), params);
    } catch {
      continue;
    }
    if (kind.check(engine.state, initial, params).length !== 0) continue;
    return { id: spec.id, kind: spec.kind, title: kind.title, ...(spec.tags ? { tags: spec.tags } : {}), seed, prompt: kind.prompt(initial, params), params };
  }
  throw new Error(`no feasible candidate for ${spec.id}${seedOverride === undefined ? '' : ` (seed ${seed})`}`);
}

const instanceCache = new Map();
/** Task `id` instantiated in the world of `seed` (cached). Throws if no feasible candidate. */
export function instantiateTask(id, seed) {
  const spec = TASK_SPECS.find((s) => s.id === id);
  if (!spec) throw new Error(`unknown task ${id}`);
  if (seed === undefined || seed === null || String(seed) === String(spec.seed)) seed = undefined;
  const key = `${id}@${seed ?? spec.seed}`;
  if (!instanceCache.has(key)) instanceCache.set(key, buildTask(spec, seed));
  return instanceCache.get(key);
}

export function buildAll() {
  return TASK_SPECS.map((spec) => buildTask(spec));
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const tasks = buildAll();
  writeFileSync(TASKS_FILE, `${JSON.stringify(tasks, null, 2)}\n`);
  console.log(`wrote ${tasks.length} tasks to ${TASKS_FILE}`);
}
