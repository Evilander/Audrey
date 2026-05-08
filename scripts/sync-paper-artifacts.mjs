import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = process.cwd();

function readText(path) {
  const absolute = resolve(ROOT, path);
  if (!existsSync(absolute)) throw new Error(`Missing required file: ${path}`);
  return readFileSync(absolute, 'utf-8');
}

function writeText(path, content) {
  writeFileSync(resolve(ROOT, path), content, 'utf-8');
}

function readJson(path) {
  return JSON.parse(readText(path));
}

function metric(value) {
  return String(value);
}

function replaceOrFail(text, pattern, replacement, label) {
  if (!pattern.test(text)) throw new Error(`Could not update ${label}`);
  return text.replace(pattern, replacement);
}

function localRows(summary) {
  return Object.fromEntries(summary.local.overall.map(row => [row.system, row]));
}

function benchmarkTable(summary) {
  const rows = localRows(summary);
  return [
    `| Audrey | ${rows.Audrey.scorePercent} | ${rows.Audrey.passRate} | ${metric(rows.Audrey.avgDurationMs)} |`,
    `| Vector Only | ${rows['Vector Only'].scorePercent} | ${rows['Vector Only'].passRate} | ${metric(rows['Vector Only'].avgDurationMs)} |`,
    `| Keyword + Recency | ${rows['Keyword + Recency'].scorePercent} | ${rows['Keyword + Recency'].passRate} | ${metric(rows['Keyword + Recency'].avgDurationMs)} |`,
    `| Recent Window | ${rows['Recent Window'].scorePercent} | ${rows['Recent Window'].passRate} | ${metric(rows['Recent Window'].avgDurationMs)} |`,
  ].join('\n');
}

function syncEvaluationText(text, summary, guardSummary) {
  let next = text;
  next = replaceOrFail(
    next,
    /The current `benchmarks\/output\/summary\.json` was generated on [^ ]+ with command `node benchmarks\/run\.js --provider mock --dimensions 64` \(Ledger: E24\)\. It reports:/,
    `The current \`benchmarks/output/summary.json\` was generated on ${summary.generatedAt} with command \`node benchmarks/run.js --provider mock --dimensions 64\` (Ledger: E24). It reports:`,
    'benchmark generatedAt',
  );
  next = replaceOrFail(
    next,
    /\| Audrey \| .* \|\n\| Vector Only \| .* \|\n\| Keyword \+ Recency \| .* \|\n\| Recent Window \| .* \|/,
    benchmarkTable(summary),
    'benchmark table',
  );
  next = replaceOrFail(
    next,
    /\| Guard latency p50 \/ p95 \| [^|]+ \|/,
    `| Guard latency p50 / p95 | ${metric(guardSummary.latency.p50Ms)} ms / ${metric(guardSummary.latency.p95Ms)} ms |`,
    'GuardBench latency row',
  );
  return next;
}

function syncReadme(text, guardSummary) {
  return replaceOrFail(
    text,
    /Latest local result in this checkout: 10\/10 scenarios passed, 100% prevention\r?\nrate, 0% false-block rate, 0 raw secret leaks, 0 published artifact leaks in\r?\nthe raw-secret sweep, and [^\r\n]+\r?\np50\/p95 guard latency under the mock-provider methodology\./,
    [
      'Latest local result in this checkout: 10/10 scenarios passed, 100% prevention',
      'rate, 0% false-block rate, 0 raw secret leaks, 0 published artifact leaks in',
      `the raw-secret sweep, and ${metric(guardSummary.latency.p50Ms)}ms / ${metric(guardSummary.latency.p95Ms)}ms`,
      'p50/p95 guard latency under the mock-provider methodology.',
    ].join('\n'),
    'README GuardBench summary',
  );
}

function syncLedger(text, guardSummary) {
  return replaceOrFail(
    text,
    /and [0-9.]+ms\/[0-9.]+ms p50\/p95 guard latency under the mock-provider methodology\. Baseline decision accuracy was no-memory 10%, recent-window 60%, vector-only 40%, and FTS-only 10%, with 0% full-contract pass rate for each baseline\. \| GuardBench local comparative results/,
    `and ${metric(guardSummary.latency.p50Ms)}ms/${metric(guardSummary.latency.p95Ms)}ms p50/p95 guard latency under the mock-provider methodology. Baseline decision accuracy was no-memory 10%, recent-window 60%, vector-only 40%, and FTS-only 10%, with 0% full-contract pass rate for each baseline. | GuardBench local comparative results`,
    'E46 GuardBench latency',
  );
}

const summary = readJson('benchmarks/output/summary.json');
const guardSummary = readJson('benchmarks/output/guardbench-summary.json');

const updates = [
  ['README.md', text => syncReadme(text, guardSummary)],
  ['docs/paper/07-evaluation.md', text => syncEvaluationText(text, summary, guardSummary)],
  ['docs/paper/audrey-paper-v1.md', text => syncEvaluationText(text, summary, guardSummary)],
  ['docs/paper/evidence-ledger.md', text => syncLedger(text, guardSummary)],
];

const changed = [];
for (const [path, updater] of updates) {
  const before = readText(path);
  const after = updater(before);
  if (after !== before) {
    writeText(path, after);
    changed.push(path);
  }
}

console.log(changed.length ? `Synced paper artifacts: ${changed.join(', ')}` : 'Paper artifacts already in sync.');
