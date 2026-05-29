import { execFileSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyArxivCompile } from '../../scripts/verify-arxiv-compile.mjs';

// Vitest globalSetup. The release/publication integration tests in
// tests/guardbench.test.js read the canonical artifact outputs that
// `npm run test:artifacts` produces (GuardBench results, external-adapter
// evidence, arXiv source, paper submission bundle). This hook bootstraps those
// outputs on demand so a bare `vitest run` is green without the full pretest
// chain.
//
// It deliberately does NOT run two steps from `test:artifacts`:
//   - `paper:sync`, which rewrites tracked docs/paper/*.md with machine-local
//     benchmark numbers, and
//   - the real LaTeX compile, which embeds a machine-local absolute path in the
//     PDF and would fail the bundle's redaction check on the machine that
//     compiled it.
// Both are still exercised by `npm run release:gate:paper`. Here we force a
// deterministic, PDF-free, pending compile report instead.

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

function generate(relScript, args = []) {
  try {
    execFileSync(process.execPath, [resolve(root, relScript), ...args], {
      cwd: root,
      stdio: 'pipe',
    });
  } catch (err) {
    const detail = err.stderr?.toString().trim() || err.stdout?.toString().trim() || err.message;
    throw new Error(`release-artifact setup failed running ${relScript}: ${detail}`, {
      cause: err,
    });
  }
}

function ensure(relPath, build) {
  if (!existsSync(resolve(root, relPath))) build();
}

export default async function ensureReleaseArtifacts() {
  // Force a deterministic, PDF-free arXiv compile state. A prior real LaTeX
  // compile may have left a poisoned PDF behind; remove it so the paper bundle
  // built by the tests never embeds a machine-local absolute path.
  rmSync(resolve(root, 'docs/paper/output/arxiv-compile/main.pdf'), { force: true });
  rmSync(resolve(root, 'docs/paper/output/arxiv-compile/arxiv-compile.log'), { force: true });

  ensure('benchmarks/output/summary.json', () => generate('benchmarks/run.js'));
  ensure('benchmarks/output/guardbench-summary.json', () =>
    generate('benchmarks/guardbench.js', ['--check']),
  );
  ensure('benchmarks/output/guardbench-conformance-card.json', () =>
    generate('benchmarks/create-conformance-card.mjs'),
  );
  ensure('benchmarks/output/submission-bundle/submission-manifest.json', () =>
    generate('benchmarks/create-submission-bundle.mjs'),
  );
  ensure('benchmarks/output/leaderboard', () => generate('benchmarks/build-leaderboard.mjs'));
  ensure('benchmarks/output/adapter-self-test', () => generate('benchmarks/adapter-self-test.mjs'));
  ensure('benchmarks/output/external/guardbench-external-dry-run.json', () =>
    generate('benchmarks/dry-run-external-adapters.mjs'),
  );
  ensure('benchmarks/output/external/guardbench-external-evidence.json', () =>
    generate('benchmarks/verify-external-evidence.mjs', ['--allow-pending']),
  );
  ensure('docs/paper/output/arxiv/arxiv-manifest.json', () =>
    generate('scripts/create-arxiv-source.mjs'),
  );

  // Always (re)write a deterministic pending compile report and a fresh paper
  // bundle so a prior real compile cannot leave a stale "compiled" report or a
  // poisoned bundle behind.
  await verifyArxivCompile({ commandExists: () => false, allowMissing: true });
  generate('scripts/create-paper-submission-bundle.mjs');
}
