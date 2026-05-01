import { performance } from 'node:perf_hooks';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { Audrey } from '../dist/src/index.js';

const RUNS = 20;

// Budget source: CHANGELOG.md#0220---2026-04-28, from the Audrey/MemoryGym
// latency pass. This mock-provider gate catches mechanical regressions in
// Audrey CI before live GPU benchmarks or MemoryGym release gates find them.
export const PERF_BUDGETS = Object.freeze({
  encodeResponseP95Ms: 50,
  hybridRecallP95Ms: 25,
  queueProcessingP50Ms: 5,
});

function roundMs(value) {
  return Math.round(value * 1000) / 1000;
}

function percentile(values, percentileRank) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil((percentileRank / 100) * sorted.length) - 1);
  return sorted[index];
}

function stats(values) {
  if (values.length === 0) {
    return { p50: 0, p95: 0, min: 0, max: 0 };
  }
  return {
    p50: roundMs(percentile(values, 50)),
    p95: roundMs(percentile(values, 95)),
    min: roundMs(Math.min(...values)),
    max: roundMs(Math.max(...values)),
  };
}

function assertBudget(name, actual, budget) {
  if (actual >= budget) {
    throw new Error(`${name} ${actual}ms exceeded budget ${budget}ms`);
  }
}

function seedContent(index) {
  const cases = [
    'Stripe API returned HTTP 429 during checkout retry and needs exponential backoff.',
    'Project memory routing should prefer Audrey MCP for durable agent context.',
    'Tool trace learning marks repeated npm spawn EPERM failures as risky on Windows shells.',
    'Calendar authority should come from the official source before inferred user notes.',
    'Vector recall is faster but loses BM25 lexical signal on exact identifiers.',
  ];
  return `${cases[index % cases.length]} Perf sample ${index}.`;
}

function createPerfDataDir() {
  const parents = [
    process.env.AUDREY_PERF_PARENT_DIR,
    tmpdir(),
    join(process.cwd(), 'benchmarks', '.tmp'),
  ].filter(Boolean);
  let lastError;

  for (const parent of parents) {
    try {
      mkdirSync(parent, { recursive: true });
      return mkdtempSync(join(parent, 'audrey-perf-'));
    } catch (err) {
      lastError = err;
    }
  }

  throw lastError || new Error('Unable to create Audrey perf benchmark data directory');
}

export async function runPerfBenchmark({
  runs = RUNS,
  budgets = PERF_BUDGETS,
  out = console.log,
} = {}) {
  const dataDir = createPerfDataDir();
  const audrey = new Audrey({
    dataDir,
    agent: 'perf-bench',
    embedding: { provider: 'mock', dimensions: 64 },
    llm: { provider: 'mock' },
  });

  const queueProcessingTimes = [];
  audrey.on('post-encode-complete', event => {
    queueProcessingTimes.push(event.processing_ms);
  });

  try {
    const encodeTimes = [];
    for (let i = 0; i < runs; i += 1) {
      const startedAt = performance.now();
      await audrey.encode({
        content: seedContent(i),
        source: 'direct-observation',
        tags: ['perf-gate'],
        affect: { valence: i % 2 === 0 ? 0.3 : -0.1, arousal: 0.2 },
      });
      encodeTimes.push(performance.now() - startedAt);
    }

    const drain = await audrey.drainPostEncodeQueue(5000);
    if (!drain.drained) {
      throw new Error(`post-encode queue did not drain: ${drain.pendingIds.join(', ')}`);
    }

    const recallTimes = [];
    for (let i = 0; i < runs; i += 1) {
      const startedAt = performance.now();
      await audrey.recall('Stripe API 429 retry memory routing', {
        limit: 5,
        retrieval: 'hybrid',
      });
      recallTimes.push(performance.now() - startedAt);
    }

    const result = {
      runs,
      budgets,
      encode_response_ms: stats(encodeTimes),
      hybrid_recall_ms: stats(recallTimes),
      queue_processing_ms: stats(queueProcessingTimes),
      queue_events: queueProcessingTimes.length,
      status: {
        pending_consolidation_count: audrey.memoryStatus().pending_consolidation_count,
        default_retrieval_mode: audrey.memoryStatus().default_retrieval_mode,
      },
    };

    if (queueProcessingTimes.length !== runs) {
      throw new Error(`expected ${runs} post-encode queue events, got ${queueProcessingTimes.length}`);
    }

    assertBudget('encode response p95', result.encode_response_ms.p95, budgets.encodeResponseP95Ms);
    assertBudget('hybrid recall p95', result.hybrid_recall_ms.p95, budgets.hybridRecallP95Ms);
    assertBudget('queue processing p50', result.queue_processing_ms.p50, budgets.queueProcessingP50Ms);

    out(`Audrey perf gate passed: encode p95=${result.encode_response_ms.p95}ms, `
      + `hybrid recall p95=${result.hybrid_recall_ms.p95}ms, `
      + `queue p50=${result.queue_processing_ms.p50}ms`);
    return result;
  } finally {
    audrey.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runPerfBenchmark().catch(err => {
    console.error('[audrey] perf gate failed:', err);
    process.exit(1);
  });
}
