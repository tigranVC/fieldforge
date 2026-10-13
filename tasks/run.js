#!/usr/bin/env node
// Verifies every task: the checker must FAIL on the untouched seeded state and
// PASS after the reference solution runs. Exit code 1 on any problem.
//   node tasks/run.js            # all tasks
//   node tasks/run.js t07 t12    # tasks whose id starts with the given prefixes
import { generateState } from '../core/index.js';
import { loadTasks, checkTask, solveTask } from './index.js';

const filters = process.argv.slice(2);
const tasks = loadTasks().filter((t) => filters.length === 0 || filters.some((f) => t.id.startsWith(f)));
let bad = 0;
for (const task of tasks) {
  const untouched = checkTask(task, generateState(task.seed));
  let solved;
  try {
    solved = checkTask(task, solveTask(task).state);
  } catch (e) {
    solved = { pass: false, reasons: [`reference solution threw: ${e.message}`] };
  }
  const ok = !untouched.pass && solved.pass;
  if (!ok) bad++;
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${task.id.padEnd(34)} untouched=${untouched.pass ? 'PASS(!)' : 'fail'} reference=${solved.pass ? 'pass' : `FAIL ${solved.reasons.join('; ')}`}`);
}
console.log(`\n${tasks.length - bad}/${tasks.length} tasks verified`);
process.exit(bad ? 1 : 0);
