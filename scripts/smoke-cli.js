#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cli = join(root, 'dist', 'mcp-server', 'index.js');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

function fail(message, result) {
  console.error(`[audrey smoke] ${message}`);
  if (result) {
    if (result.stdout) console.error(`stdout:\n${result.stdout}`);
    if (result.stderr) console.error(`stderr:\n${result.stderr}`);
  }
  process.exit(1);
}

if (!existsSync(cli)) {
  fail(`missing built CLI at ${cli}; run npm run build first`);
}

function createTempRoot() {
  const candidates = [
    process.env.AUDREY_SMOKE_TMPDIR,
    tmpdir(),
    join(root, '.tmp'),
  ].filter(Boolean);
  const failures = [];

  for (const candidate of candidates) {
    try {
      mkdirSync(candidate, { recursive: true });
      return mkdtempSync(join(candidate, 'audrey-smoke-'));
    } catch (error) {
      failures.push(`${candidate}: ${error.code ?? error.message}`);
    }
  }

  fail(`unable to create smoke temp directory (${failures.join('; ')})`);
}

const tempRoot = createTempRoot();
const env = {
  ...process.env,
  AUDREY_DATA_DIR: join(tempRoot, 'store'),
  AUDREY_EMBEDDING_PROVIDER: 'mock',
  AUDREY_LLM_PROVIDER: 'mock',
};

function run(label, args) {
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd: root,
    env,
    encoding: 'utf8',
    timeout: 60_000,
  });
  if (result.error) {
    fail(`${label} failed to spawn: ${result.error.message}`, result);
  }
  if (result.status !== 0) {
    fail(`${label} exited ${result.status}`, result);
  }
  return result.stdout;
}

try {
  const version = run('--version', ['--version']).trim();
  if (version !== `audrey ${pkg.version}`) {
    fail(`version mismatch: expected audrey ${pkg.version}, got ${version}`);
  }

  const doctor = JSON.parse(run('doctor --json', ['doctor', '--json']));
  if (doctor.version !== pkg.version || doctor.ok !== true) {
    fail(`doctor --json returned unexpected release status: ${JSON.stringify({
      version: doctor.version,
      ok: doctor.ok,
    })}`);
  }

  const demo = run('demo', ['demo']);
  if (!demo.includes('Audrey 60-second memory demo') || !demo.includes('Recall proof:')) {
    fail('demo output did not include expected proof markers', { stdout: demo, stderr: '' });
  }

  console.log(`[audrey smoke] CLI smoke checks passed for ${pkg.version}`);
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}
