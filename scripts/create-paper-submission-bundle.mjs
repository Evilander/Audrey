import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyPaperClaims } from './verify-paper-claims.mjs';
import { verifyPublicationPack } from './verify-publication-pack.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_OUT_DIR = 'docs/paper/output/submission-bundle';
const PAPER_FILES = [
  'README.md',
  'LICENSE',
  'package.json',
  'docs/AUDREY_PAPER_OUTLINE.md',
  'docs/paper/00-master.md',
  'docs/paper/01-introduction.md',
  'docs/paper/02-related-work.md',
  'docs/paper/03-problem-definition.md',
  'docs/paper/04-design.md',
  'docs/paper/05-guardbench-spec.md',
  'docs/paper/06-implementation.md',
  'docs/paper/07-evaluation.md',
  'docs/paper/08-discussion-limitations.md',
  'docs/paper/09-conclusion.md',
  'docs/paper/appendix-a-demo-transcript.md',
  'docs/paper/arxiv-compile-report.schema.json',
  'docs/paper/arxiv-source.schema.json',
  'docs/paper/audrey-paper-v1.md',
  'docs/paper/browser-launch-plan.json',
  'docs/paper/browser-launch-plan.schema.json',
  'docs/paper/browser-launch-results.json',
  'docs/paper/browser-launch-results.schema.json',
  'docs/paper/claim-register.json',
  'docs/paper/claim-register.schema.json',
  'docs/paper/evidence-ledger.md',
  'docs/paper/paper-submission-bundle.schema.json',
  'docs/paper/publication-pack.json',
  'docs/paper/publication-pack.schema.json',
  'docs/paper/references.bib',
  'docs/paper/SUBMISSION_README.md',
  'docs/paper/output/arxiv/main.tex',
  'docs/paper/output/arxiv/references.bib',
  'docs/paper/output/arxiv/README-arxiv.txt',
  'docs/paper/output/arxiv/arxiv-manifest.json',
  'docs/paper/output/arxiv-compile-report.json',
];
const OPTIONAL_PAPER_FILES = [
  'docs/paper/output/arxiv-compile/main.pdf',
  'docs/paper/output/arxiv-compile/arxiv-compile.log',
];
const BENCHMARK_FILES = [
  'benchmarks/output/summary.json',
  'benchmarks/output/guardbench-manifest.json',
  'benchmarks/output/guardbench-summary.json',
  'benchmarks/output/guardbench-raw.json',
  'benchmarks/output/guardbench-conformance-card.json',
  'benchmarks/output/adapter-self-test/guardbench-adapter-self-test.json',
  'benchmarks/output/external/guardbench-external-dry-run.json',
  'benchmarks/output/external/guardbench-external-evidence.json',
  'benchmarks/output/leaderboard/guardbench-leaderboard.json',
  'benchmarks/output/leaderboard/guardbench-leaderboard.md',
  'benchmarks/output/submission-bundle/submission-manifest.json',
  'benchmarks/output/submission-bundle/validation-report.json',
];
const SCHEMA_FILES = [
  'benchmarks/schemas/guardbench-adapter-registry.schema.json',
  'benchmarks/schemas/guardbench-adapter-self-test.schema.json',
  'benchmarks/schemas/guardbench-conformance-card.schema.json',
  'benchmarks/schemas/guardbench-external-dry-run.schema.json',
  'benchmarks/schemas/guardbench-external-evidence.schema.json',
  'benchmarks/schemas/guardbench-external-run.schema.json',
  'benchmarks/schemas/guardbench-leaderboard.schema.json',
  'benchmarks/schemas/guardbench-manifest.schema.json',
  'benchmarks/schemas/guardbench-publication-verification.schema.json',
  'benchmarks/schemas/guardbench-raw.schema.json',
  'benchmarks/schemas/guardbench-submission-manifest.schema.json',
  'benchmarks/schemas/guardbench-summary.schema.json',
];

function fromRoot(path) {
  return resolve(ROOT, path);
}

function readJson(path) {
  return JSON.parse(readFileSync(fromRoot(path), 'utf-8'));
}

function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function bundleDisplayPath(path) {
  const rel = relative(ROOT, path);
  if (rel && !rel.startsWith('..') && !isAbsolute(rel)) return rel.replaceAll('\\', '/');
  return path.replaceAll('\\', '/');
}

function parseArgs(argv = process.argv.slice(2)) {
  const args = {
    outDir: DEFAULT_OUT_DIR,
    json: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === '--out-dir' && argv[i + 1]) args.outDir = argv[++i];
    else if (token === '--json') args.json = true;
    else if (token === '--help' || token === '-h') args.help = true;
    else throw new Error(`Unknown argument: ${token}`);
  }
  return args;
}

function usage() {
  return `Usage: node scripts/create-paper-submission-bundle.mjs [options]

Options:
  --out-dir <path>  Output directory. Default: ${DEFAULT_OUT_DIR}.
  --json            Print the machine-readable bundle manifest.
`;
}

function copyIntoBundle(source, outDir) {
  const sourcePath = fromRoot(source);
  if (!existsSync(sourcePath)) throw new Error(`Missing source file for paper bundle: ${source}`);
  const target = join(outDir, source.replaceAll('\\', '/'));
  mkdirSync(dirname(target), { recursive: true });
  cpSync(sourcePath, target);
  return {
    path: relative(outDir, target).replaceAll('\\', '/'),
    source,
    bytes: readFileSync(target).byteLength,
    sha256: sha256File(target),
  };
}

export async function writePaperSubmissionBundle(options = {}) {
  const outDir = fromRoot(options.outDir ?? DEFAULT_OUT_DIR);
  const claimVerification = await verifyPaperClaims();
  const publicationPackVerification = await verifyPublicationPack();
  if (!claimVerification.ok) {
    throw new Error(`Cannot create paper submission bundle with invalid claims: ${claimVerification.failures.join('; ')}`);
  }
  if (!publicationPackVerification.ok) {
    throw new Error(`Cannot create paper submission bundle with invalid publication pack: ${publicationPackVerification.failures.join('; ')}`);
  }

  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  const optionalFiles = OPTIONAL_PAPER_FILES.filter(source => existsSync(fromRoot(source)));
  const files = [...PAPER_FILES, ...optionalFiles, ...BENCHMARK_FILES, ...SCHEMA_FILES]
    .map(source => copyIntoBundle(source, outDir))
    .sort((a, b) => a.path.localeCompare(b.path));
  const guardSummary = readJson('benchmarks/output/guardbench-summary.json');
  const manifest = {
    schemaVersion: '1.0.0',
    suite: 'Audrey paper submission bundle',
    generatedAt: new Date().toISOString(),
    sourceRoot: '.',
    outDir: bundleDisplayPath(outDir),
    claimVerification: {
      ok: claimVerification.ok,
      count: claimVerification.claims.length,
    },
    publicationPackVerification: {
      ok: publicationPackVerification.ok,
      count: publicationPackVerification.entries.length,
    },
    guardBenchSnapshot: {
      passed: guardSummary.passed,
      scenarios: guardSummary.scenarios,
      redactionLeaks: guardSummary.redactionLeaks,
      artifactLeaks: guardSummary.artifactRedactionSweep?.leakCount ?? 0,
      latencyP50Ms: guardSummary.latency?.p50Ms ?? 0,
      latencyP95Ms: guardSummary.latency?.p95Ms ?? 0,
    },
    files,
  };
  const manifestPath = join(outDir, 'paper-submission-manifest.json');
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf-8');

  return {
    outDir,
    manifestPath,
    manifest,
    files: files.map(file => file.path),
  };
}

async function main() {
  const args = parseArgs();
  if (args.help) {
    console.log(usage());
    return;
  }

  const result = await writePaperSubmissionBundle(args);
  if (args.json) console.log(JSON.stringify(result.manifest, null, 2));
  else {
    console.log(`Paper submission bundle: ${result.outDir}`);
    console.log(`Files: ${result.manifest.files.length}`);
    console.log(`Manifest: ${result.manifestPath}`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(error.stack ?? error.message);
    process.exit(1);
  });
}
