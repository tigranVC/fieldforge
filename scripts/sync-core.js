#!/usr/bin/env node
// Copies the shared core/ ES modules (and task definitions) into docs/ so the
// static SPA served from /docs (GitHub Pages) uses exactly the same code as
// the Node server. Run after editing core/ or tasks/: npm run build
import { mkdirSync, readdirSync, copyFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pairs = [
  [join(root, 'core'), join(root, 'docs', 'core'), (f) => f.endsWith('.js')],
  [join(root, 'tasks'), join(root, 'docs', 'tasks'), (f) => f === 'kinds.js' || f === 'tasks.json'],
];
for (const [src, dst, keep] of pairs) {
  rmSync(dst, { recursive: true, force: true });
  mkdirSync(dst, { recursive: true });
  for (const f of readdirSync(src).filter(keep)) copyFileSync(join(src, f), join(dst, f));
  console.log(`synced ${src} -> ${dst}`);
}
