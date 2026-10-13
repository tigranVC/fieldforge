// Multi-seed task instances: every task can be re-instantiated in the worlds
// of seeds 1, 2, 3 (used by the benchmark harness), and the REST start/check
// endpoints accept a seed.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { generateState, createEngine } from '../core/index.js';
import { loadTasks, checkTask, makeEnv, KINDS } from '../tasks/index.js';
import { instantiateTask } from '../tasks/generate.js';
import { createApp } from '../server/app.js';

const tasks = loadTasks();

for (const seed of [1, 2, 3]) {
  test(`all tasks instantiate on seed ${seed}: fail untouched, pass after reference`, () => {
    for (const t of tasks) {
      const inst = instantiateTask(t.id, seed);
      assert.equal(inst.seed, seed);
      assert.equal(checkTask(inst, generateState(seed)).pass, false, `${t.id} untouched`);
      const engine = createEngine(seed);
      KINDS[inst.kind].solve(makeEnv(engine), inst.params);
      assert.deepEqual(checkTask(inst, engine.state).reasons, [], t.id);
    }
  });
}

test('instantiateTask without seed (or with the task seed) returns the stored task', () => {
  assert.deepEqual(instantiateTask(tasks[0].id), tasks[0]);
  assert.deepEqual(instantiateTask(tasks[0].id, tasks[0].seed), tasks[0]);
});

let server;
let base;
before(async () => {
  await new Promise((r) => { server = createApp({ seed: 42 }).listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());
const post = async (path, body) => (await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) })).json();

test('REST: start with seed resets to that world and check uses the seeded instance', async () => {
  const t = tasks[0];
  const r = await post(`/api/tasks/${t.id}/start`, { seed: 2 });
  assert.equal(r.task.seed, 2);
  assert.equal(r.task.prompt, instantiateTask(t.id, 2).prompt);
  assert.equal((await (await fetch(`${base}/api/health`)).json()).seed, 2);
  const c = await post(`/api/tasks/${t.id}/check`);
  assert.equal(c.seed, 2);
  assert.equal(c.pass, false);
  assert.ok(!c.reasons.some((x) => /seed .* != task seed/.test(x)), c.reasons.join('; '));
  const d = await post(`/api/tasks/${t.id}/start`);
  assert.equal(d.task.seed, t.seed);
});
