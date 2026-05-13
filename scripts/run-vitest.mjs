import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const tempDir = resolve('.tmp-vitest');
mkdirSync(tempDir, { recursive: true });

const vitestEntry = resolve('node_modules/vitest/vitest.mjs');
const args = process.argv.slice(2);
const mode = args[0] === 'watch' ? [] : ['run'];
const passthrough = args[0] === 'watch' ? args.slice(1) : args;

const child = spawn(process.execPath, [vitestEntry, ...mode, ...passthrough], {
  stdio: 'inherit',
  env: {
    ...process.env,
    TEMP: tempDir,
    TMP: tempDir,
    TMPDIR: tempDir,
  },
});

child.on('error', err => {
  console.error(err);
  process.exit(1);
});

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
