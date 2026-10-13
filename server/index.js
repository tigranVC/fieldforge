#!/usr/bin/env node
// Usage: node server/index.js [--port 3030] [--seed 42]   (or PORT / SEED env vars)
import { createApp } from './app.js';

const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const port = Number(arg('port') ?? process.env.PORT ?? 3030);
const seedRaw = arg('seed') ?? process.env.SEED ?? '42';
const seed = /^\d+$/.test(seedRaw) ? Number(seedRaw) : seedRaw;

const app = createApp({ seed });
app.listen(port, () => {
  console.log(`FieldForge API listening on http://localhost:${port} (seed ${seed})`);
});
