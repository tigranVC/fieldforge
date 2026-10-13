import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

test('docs/core is an exact copy of core/ (run npm run build after edits)', () => {
  const files = readdirSync(join(root, 'core')).filter((f) => f.endsWith('.js'));
  assert.deepEqual(readdirSync(join(root, 'docs', 'core')).sort(), files.sort());
  for (const f of files) assert.equal(readFileSync(join(root, 'docs', 'core', f), 'utf8'), readFileSync(join(root, 'core', f), 'utf8'), f);
  for (const f of ['kinds.js', 'tasks.json']) assert.equal(readFileSync(join(root, 'docs', 'tasks', f), 'utf8'), readFileSync(join(root, 'tasks', f), 'utf8'), f);
});

test('SPA entry points exist and the browser API exposes every action', async () => {
  for (const f of ['index.html', 'app.js', 'api.js', 'style.css', '.nojekyll']) assert.ok(existsSync(join(root, 'docs', f)), f);
  const api = readFileSync(join(root, 'docs', 'api.js'), 'utf8');
  assert.match(api, /window\.fieldforge = api/);
  assert.match(api, /for \(const name of Object\.keys\(core\.ACTIONS\)\)/);
});
