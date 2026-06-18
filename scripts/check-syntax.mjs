// Syntax gate for all JS sources using Node's own parser (`node --check`).
// No external linter dependency. Exits non-zero if any file fails to parse.

import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dirs = ['electron', 'src', 'renderer', 'scripts'];
const exts = new Set(['.js', '.mjs', '.cjs']);

async function* walk(dir) {
  let entries = [];
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (e.name === 'node_modules') continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(full);
    else if (exts.has(path.extname(e.name))) yield full;
  }
}

let failures = 0;
let checked = 0;

for (const base of dirs) {
  for await (const file of walk(path.join(root, base))) {
    checked++;
    try {
      await run(process.execPath, ['--check', file]);
    } catch (err) {
      failures++;
      console.error(`✗ ${path.relative(root, file)}\n${err.stderr || err.message}`);
    }
  }
}

if (failures) {
  console.error(`\n${failures} file(s) failed syntax check (of ${checked}).`);
  process.exit(1);
}
console.log(`✓ Syntax OK for ${checked} JS file(s).`);
