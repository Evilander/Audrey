import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { verifyGuardBenchSubmissionBundle } from './verify-submission-bundle.mjs';
import { validateSchema } from './validate-guardbench-artifacts.mjs';
import { publicPath } from './public-paths.mjs';

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf-8'));
}

function percent(value) {
  return value == null ? 'n/a' : `${(value * 100).toFixed(1)}%`;
}

function number(value) {
  return value == null ? 'n/a' : String(value);
}

function rowFromBundle(dir) {
  const verification = verifyGuardBenchSubmissionBundle({ dir });
  const manifest = readJson(join(resolve(dir), 'submission-manifest.json'));
  return {
    subject: manifest.subject,
    score: manifest.score,
    conformance: manifest.conformance,
    source: {
      dir: publicPath(resolve(dir)),
      manifestGeneratedAt: manifest.generatedAt,
      fileCount: manifest.files?.length ?? 0,
    },
    verification,
  };
}

function compareRows(a, b) {
  return (
    Number(b.verification.ok) - Number(a.verification.ok)
    || Number(b.conformance.ok) - Number(a.conformance.ok)
    || (b.score.fullContractPassRate ?? -1) - (a.score.fullContractPassRate ?? -1)
    || (b.score.decisionAccuracy ?? -1) - (a.score.decisionAccuracy ?? -1)
    || (b.score.evidenceRecall ?? -1) - (a.score.evidenceRecall ?? -1)
    || (a.score.redactionLeaks ?? Number.MAX_SAFE_INTEGER) - (b.score.redactionLeaks ?? Number.MAX_SAFE_INTEGER)
    || (a.score.latency?.p95Ms ?? Number.MAX_SAFE_INTEGER) - (b.score.latency?.p95Ms ?? Number.MAX_SAFE_INTEGER)
    || a.subject.name.localeCompare(b.subject.name)
  );
}

export function buildGuardBenchLeaderboard(options = {}) {
  const bundleDirs = options.bundleDirs?.length
    ? options.bundleDirs
    : ['benchmarks/output/submission-bundle'];
  const rows = bundleDirs.map(rowFromBundle).sort(compareRows)
    .map((row, index) => ({ rank: index + 1, ...row }));
  return {
    schemaVersion: '1.0.0',
    suite: 'GuardBench leaderboard',
    generatedAt: new Date().toISOString(),
    ranking: [
      'verified bundle',
      'adapter conformance',
      'fullContractPassRate',
      'decisionAccuracy',
      'evidenceRecall',
      'redactionLeaks ascending',
      'latency.p95Ms ascending',
      'subject.name',
    ],
    rows,
    failures: rows.flatMap(row => row.verification.failures.map(failure => `${row.subject.name}: ${failure}`)),
  };
}

export function writeGuardBenchLeaderboard(options = {}) {
  const outJson = resolve(options.outJson ?? 'benchmarks/output/leaderboard/guardbench-leaderboard.json');
  const outMd = resolve(options.outMd ?? 'benchmarks/output/leaderboard/guardbench-leaderboard.md');
  const schemasDir = resolve(options.schemasDir ?? 'benchmarks/schemas');
  const leaderboard = buildGuardBenchLeaderboard(options);
  const schema = readJson(join(schemasDir, 'guardbench-leaderboard.schema.json'));
  const schemaErrors = validateSchema(leaderboard, schema, 'guardbench-leaderboard');
  if (schemaErrors.length) {
    throw new Error(`GuardBench leaderboard schema validation failed: ${schemaErrors.join('; ')}`);
  }
  mkdirSync(dirname(outJson), { recursive: true });
  mkdirSync(dirname(outMd), { recursive: true });
  writeFileSync(outJson, `${JSON.stringify(leaderboard, null, 2)}\n`, 'utf-8');
  writeFileSync(outMd, renderMarkdown(leaderboard), 'utf-8');
  return { leaderboard, outJson, outMd };
}

export function renderMarkdown(leaderboard) {
  const lines = [
    '# GuardBench Leaderboard',
    '',
    `Generated: ${leaderboard.generatedAt}`,
    '',
    '| Rank | Subject | Verified | Conformant | Full Contract | Decision Accuracy | Evidence Recall | Redaction Leaks | p95 Latency | Bundle |',
    '|---:|---|---:|---:|---:|---:|---:|---:|---:|---|',
  ];
  for (const row of leaderboard.rows) {
    lines.push([
      row.rank,
      row.subject.name,
      row.verification.ok ? 'yes' : 'no',
      row.conformance.ok ? 'yes' : 'no',
      percent(row.score.fullContractPassRate),
      percent(row.score.decisionAccuracy),
      percent(row.score.evidenceRecall),
      number(row.score.redactionLeaks),
      row.score.latency?.p95Ms == null ? 'n/a' : `${row.score.latency.p95Ms}ms`,
      row.source.dir,
    ].join(' | ').replace(/^/, '| ').replace(/$/, ' |'));
  }
  if (leaderboard.failures.length) {
    lines.push('', '## Verification Failures', '');
    for (const failure of leaderboard.failures) lines.push(`- ${failure}`);
  }
  lines.push('');
  return `${lines.join('\n')}`;
}

function parseArgs(argv = process.argv.slice(2)) {
  const args = {
    bundleDirs: [],
    outJson: 'benchmarks/output/leaderboard/guardbench-leaderboard.json',
    outMd: 'benchmarks/output/leaderboard/guardbench-leaderboard.md',
    json: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if ((token === '--bundle' || token === '--dir') && argv[i + 1]) args.bundleDirs.push(argv[++i]);
    else if (token === '--out-json' && argv[i + 1]) args.outJson = argv[++i];
    else if (token === '--out-md' && argv[i + 1]) args.outMd = argv[++i];
    else if (token === '--schemas-dir' && argv[i + 1]) args.schemasDir = argv[++i];
    else if (token === '--json') args.json = true;
    else if (token === '--help' || token === '-h') args.help = true;
    else throw new Error(`Unknown argument: ${token}`);
  }
  return args;
}

function usage() {
  return [
    'Usage: node benchmarks/build-leaderboard.mjs [--bundle <submission-bundle>] [--json]',
    '',
    'Builds ranked JSON and Markdown GuardBench leaderboard artifacts from verified',
    'submission bundles. Repeat --bundle for multiple systems.',
  ].join('\n');
}

async function main() {
  const args = parseArgs();
  if (args.help) {
    console.log(usage());
    return;
  }
  const result = writeGuardBenchLeaderboard(args);
  if (args.json) console.log(JSON.stringify(result.leaderboard, null, 2));
  else {
    console.log(`GuardBench leaderboard JSON: ${result.outJson}`);
    console.log(`GuardBench leaderboard Markdown: ${result.outMd}`);
  }
  if (result.leaderboard.failures.length) process.exit(1);
}

if (process.argv[1] && resolve(process.argv[1]).endsWith('build-leaderboard.mjs')) {
  main().catch(error => {
    console.error(error.stack ?? error.message);
    process.exit(1);
  });
}
