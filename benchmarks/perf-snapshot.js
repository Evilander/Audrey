// Honest performance snapshot for Audrey.
//
// What this measures
// - Encode latency at multiple corpus sizes
// - Hybrid recall latency at multiple corpus sizes
// - Post-encode queue processing time (consolidation/interference/validation pipeline)
//
// What this does NOT do
// - Compare against other memory systems. Synthetic head-to-head numbers are
//   easy to game. If you want a real comparison, run the same workload against
//   the system you care about and post your own results.
// - Use cloud embedding providers. Latency to a remote API is dominated by
//   network round-trip and varies wildly by region and rate-limit state.
//   We use the in-process mock embedding provider so the numbers reflect
//   Audrey's own pipeline (SQLite, sqlite-vec, encode/recall logic, hybrid
//   ranking) without third-party noise. Real-world recall p95 with a local
//   384-dim provider is typically 5-15x higher; with a hosted provider it is
//   dominated by the API call.
//
// How to read the output
// - p50 / p95 / p99 are percentile latencies in milliseconds.
// - The numbers are wall-clock for a single call from a JS caller, including
//   SQLite work and any post-encode queueing on encode rows.
// - Run on your own hardware and embedding provider before quoting numbers
//   anywhere; results scale heavily with CPU, NVMe vs spinning disk, and
//   embedding dimensionality.

import { performance } from 'node:perf_hooks';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir, cpus, totalmem, arch, platform, release } from 'node:os';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { Audrey } from '../dist/src/index.js';

const DEFAULT_SIZES = [100, 1000, 5000];
const DEFAULT_RECALL_RUNS = 50;
const QUERY_POOL = [
  'rate limit handling for HTTP 429 retries',
  'durable agent context across sessions',
  'safe shell behavior on Windows hosts',
  'official authority over inferred preferences',
  'lexical signal for exact identifiers',
  'deployment region migration steps',
  'webhook signature recovery procedure',
  'fraud queue manual review trigger',
];

const SEED_POOL = [
  'Stripe API returned HTTP 429 during checkout retry; needs exponential backoff.',
  'Project memory routing should prefer the local memory layer for durable context.',
  'Tool trace learning marks repeated spawn EPERM failures as risky on Windows shells.',
  'Calendar authority should come from the official source before inferred user notes.',
  'Vector recall is faster but loses BM25 lexical signal on exact identifiers.',
  'Webhook signature recovery requires rotating the signing secret and replaying queued events.',
  'Fraud queue stabilizes when repeated same-BIN disputes are escalated for manual review.',
  'Deployment region migrations should be coordinated against the provider rate-limit window.',
];

function percentile(values, rank) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil((rank / 100) * sorted.length) - 1);
  return sorted[index];
}

function round(value) {
  return Math.round(value * 1000) / 1000;
}

function summarize(values) {
  if (values.length === 0) {
    return { samples: 0, p50: 0, p95: 0, p99: 0, min: 0, max: 0, mean: 0 };
  }
  const total = values.reduce((acc, v) => acc + v, 0);
  return {
    samples: values.length,
    p50: round(percentile(values, 50)),
    p95: round(percentile(values, 95)),
    p99: round(percentile(values, 99)),
    min: round(Math.min(...values)),
    max: round(Math.max(...values)),
    mean: round(total / values.length),
  };
}

function gitSha() {
  // execFileSync, no shell, fixed argv — provenance only, no user input flows in.
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .toString()
      .trim();
  } catch {
    return null;
  }
}

export function resolveAudreyVersion() {
  if (process.env.npm_package_version) {
    return process.env.npm_package_version;
  }

  try {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    return typeof pkg.version === 'string' ? pkg.version : null;
  } catch {
    return null;
  }
}

function machineProvenance() {
  const cpuList = cpus();
  const cpuModel = cpuList[0] ? cpuList[0].model : 'unknown';
  const totalGb = Math.round((totalmem() / 1024 / 1024 / 1024) * 10) / 10;
  return {
    node: process.versions.node,
    v8: process.versions.v8,
    platform: platform(),
    arch: arch(),
    osRelease: release(),
    cpuCount: cpuList.length,
    cpuModel,
    memoryGb: totalGb,
  };
}

function createDataDir() {
  const parents = [
    process.env.AUDREY_PERF_PARENT_DIR,
    tmpdir(),
    join(process.cwd(), 'benchmarks', '.tmp'),
  ].filter(Boolean);

  let lastError;
  for (const parent of parents) {
    try {
      mkdirSync(parent, { recursive: true });
      return mkdtempSync(join(parent, 'audrey-perf-snapshot-'));
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError || new Error('Unable to create perf snapshot data directory');
}

function parseArgs(argv = process.argv.slice(2)) {
  const args = {
    sizes: [...DEFAULT_SIZES],
    recallRuns: DEFAULT_RECALL_RUNS,
    out: null,
    json: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === '--sizes' && argv[i + 1]) {
      args.sizes = argv[++i]
        .split(',')
        .map((s) => Number.parseInt(s.trim(), 10))
        .filter((n) => Number.isFinite(n) && n > 0);
    } else if (token === '--recall-runs' && argv[i + 1]) {
      args.recallRuns = Number.parseInt(argv[++i], 10);
    } else if (token === '--out' && argv[i + 1]) {
      args.out = resolve(argv[++i]);
    } else if (token === '--json') {
      args.json = true;
    }
  }
  return args;
}

async function runOneSize({ size, recallRuns }) {
  const dataDir = createDataDir();
  const audrey = new Audrey({
    dataDir,
    agent: 'perf-snapshot',
    embedding: { provider: 'mock', dimensions: 64 },
    llm: { provider: 'mock' },
  });

  const queueProcessingTimes = [];
  audrey.on('post-encode-complete', (event) => {
    queueProcessingTimes.push(event.processing_ms);
  });

  try {
    const encodeTimes = [];
    for (let i = 0; i < size; i++) {
      const content = `${SEED_POOL[i % SEED_POOL.length]} (sample ${i})`;
      const startedAt = performance.now();
      await audrey.encode({
        content,
        source: 'direct-observation',
        tags: ['perf-snapshot'],
      });
      encodeTimes.push(performance.now() - startedAt);
    }

    const drain = await audrey.drainPostEncodeQueue(60_000);
    if (!drain.drained) {
      throw new Error(`post-encode queue did not drain at size=${size}`);
    }

    const recallTimes = [];
    for (let i = 0; i < recallRuns; i++) {
      const query = QUERY_POOL[i % QUERY_POOL.length];
      const startedAt = performance.now();
      await audrey.recall(query, { limit: 5, retrieval: 'hybrid' });
      recallTimes.push(performance.now() - startedAt);
    }

    return {
      corpusSize: size,
      encodeMs: summarize(encodeTimes),
      hybridRecallMs: summarize(recallTimes),
      postEncodeQueueMs: summarize(queueProcessingTimes),
      queueEvents: queueProcessingTimes.length,
    };
  } finally {
    audrey.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
}

export async function runPerfSnapshot({ sizes = DEFAULT_SIZES, recallRuns = DEFAULT_RECALL_RUNS } = {}) {
  const startedAt = Date.now();
  const sized = [];
  for (const size of sizes) {
    sized.push(await runOneSize({ size, recallRuns }));
  }
  return {
    generatedAt: new Date(startedAt).toISOString(),
    durationMs: Date.now() - startedAt,
    audreyVersion: resolveAudreyVersion(),
    gitSha: gitSha(),
    methodology: {
      embedding: 'mock provider, 64 dimensions (in-process, no network)',
      llm: 'mock provider (in-process)',
      retrieval: 'hybrid (vector + lexical) with limit=5',
      sizes,
      recallRunsPerSize: recallRuns,
      notes:
        'Latency is wall-clock for a single call from a JS caller. Cloud and ' +
        'local 384-dim providers will report higher recall latency dominated by ' +
        'embedding cost and network. Run on your own hardware before quoting.',
    },
    machine: machineProvenance(),
    sizes: sized,
  };
}

function formatMs(value) {
  if (value === 0) return '0';
  if (value < 1) return value.toFixed(2);
  return value.toFixed(1);
}

export function formatMarkdownTable(snapshot) {
  const lines = [];
  lines.push(
    `Audrey perf snapshot — ${snapshot.audreyVersion || 'dev'} on ${snapshot.machine.platform}/${snapshot.machine.arch}`,
  );
  lines.push('');
  lines.push(
    `Node ${snapshot.machine.node} · ${snapshot.machine.cpuCount}x ${snapshot.machine.cpuModel} · ${snapshot.machine.memoryGb} GB RAM`,
  );
  lines.push(
    `Generated ${snapshot.generatedAt}${snapshot.gitSha ? ` (${snapshot.gitSha})` : ''}`,
  );
  lines.push('');
  lines.push('| Corpus size | Encode p50 (ms) | Encode p95 (ms) | Recall p50 (ms) | Recall p95 (ms) | Recall p99 (ms) |');
  lines.push('|---|---|---|---|---|---|');
  for (const row of snapshot.sizes) {
    lines.push(
      `| ${row.corpusSize.toLocaleString()} ` +
        `| ${formatMs(row.encodeMs.p50)} ` +
        `| ${formatMs(row.encodeMs.p95)} ` +
        `| ${formatMs(row.hybridRecallMs.p50)} ` +
        `| ${formatMs(row.hybridRecallMs.p95)} ` +
        `| ${formatMs(row.hybridRecallMs.p99)} |`,
    );
  }
  return lines.join('\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = parseArgs();
  runPerfSnapshot({ sizes: args.sizes, recallRuns: args.recallRuns })
    .then((snapshot) => {
      if (args.out) {
        writeFileSync(args.out, JSON.stringify(snapshot, null, 2) + '\n');
      }
      if (args.json) {
        process.stdout.write(JSON.stringify(snapshot, null, 2) + '\n');
      } else {
        process.stdout.write(formatMarkdownTable(snapshot) + '\n');
      }
    })
    .catch((err) => {
      console.error('[audrey] perf snapshot failed:', err);
      process.exit(1);
    });
}
