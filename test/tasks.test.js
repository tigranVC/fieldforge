import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateState } from '../core/index.js';
import { loadTasks, checkTask, solveTask, KINDS } from '../tasks/index.js';
import { buildAll } from '../tasks/generate.js';

const tasks = loadTasks();

test('there are 40 well-formed tasks (30 original + 10 tagged hard)', () => {
  assert.equal(tasks.length, 40);
  assert.equal(new Set(tasks.map((t) => t.id)).size, 40);
  assert.equal(tasks.filter((t) => !(t.tags || []).includes('hard')).length, 30);
  assert.equal(tasks.filter((t) => (t.tags || []).includes('hard')).length, 10);
  for (const t of tasks) {
    assert.equal(typeof t.id, 'string');
    assert.equal(typeof t.prompt, 'string');
    assert.ok(t.prompt.length > 40);
    assert.ok(Number.isInteger(t.seed));
    assert.ok(KINDS[t.kind], t.kind);
    assert.equal(typeof KINDS[t.kind].check, 'function');
  }
});

test('tasks.json is reproducible from specs (deterministic generator)', () => {
  assert.deepEqual(buildAll(), tasks);
});

for (const task of tasks) {
  test(`task ${task.id}: checker fails on untouched state, passes after reference solution`, () => {
    const untouched = checkTask(task, generateState(task.seed));
    assert.equal(untouched.pass, false, 'checker must fail on untouched state');
    const solved = checkTask(task, solveTask(task).state);
    assert.deepEqual(solved.reasons, []);
    assert.equal(solved.pass, true);
  });
}

test('checker rejects a state from the wrong seed', () => {
  const t = tasks[0];
  assert.equal(checkTask(t, generateState(t.seed + 1)).pass, false);
});

test('reassign checker rejects a non-nearest technician', () => {
  const t = tasks.find((x) => x.kind === 'reassign_nearest');
  const engine = solveTask(t);
  const job = engine.state.jobs.find((j) => j.id === t.params.jobId);
  const alt = engine.query('findAvailableTechs', { jobId: job.id, date: job.date, start: job.startMin }).result
    .filter((x) => x.techId !== t.params.fromTechId && x.techId !== job.techId && x.distance > engine.query('findAvailableTechs', { jobId: job.id, date: job.date, start: job.startMin }).result[0].distance);
  if (!alt.length) return; // nothing to compare against in this world
  engine.dispatch('scheduleJob', { jobId: job.id, techId: alt[alt.length - 1].techId, date: job.date, start: job.startMin });
  assert.equal(checkTask(t, engine.state).pass, false);
});
