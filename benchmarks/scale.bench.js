import { performance } from 'node:perf_hooks';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';
import { Audrey, createDatabase, closeDatabase, buildPreflight } from '../dist/src/index.js';
import { insertEvent, recentFailures } from '../dist/src/events.js';

// perf.bench.js seeds ~20 episodes and never touches memory_events, so it
// cannot see cost that only shows up at scale: recentFailures() turning
// near-quadratic on a large event table, or createDatabase() re-scanning
// every embedding column on every hook process. This file seeds a
// tens-of-thousands-row store once and gates the operations that run on
// that same per-hook-process path.

const DIMENSIONS = 64;
const EPISODE_COUNT = 20000;
const SEMANTIC_COUNT = 3000;
const PROCEDURE_COUNT = 3000;
const EVENT_COUNT = 50000;
const CONTENT_POOL_SIZE = 200;
const DELTA_EPISODE_COUNT = 500;
const RUNS = 20;

// Budget source: the recentFailures()/createDatabase() perf fix (see
// CHANGELOG). Pre-fix recentFailures() measured ~199ms at 10k memory_events
// and ~24s at 100k — a roughly quadratic curve that puts a 50k-row table
// (this file's scale) at ~5s under the old correlated-subquery
// implementation. Each budget below sits an order of magnitude under that
// regression floor while leaving headroom over the index-backed, single-pass
// cost this file exists to protect, and well under the 30s PreToolUse host
// timeout.
export const SCALE_PERF_BUDGETS = Object.freeze({
  recentFailuresP95Ms: 500,
  capsuleP95Ms: 1500,
  preflightP95Ms: 2000,
  coldReopenSteadyP95Ms: 300,
  coldReopenCatchUpMs: 800,
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

function createScaleDataDir() {
  const parents = [
    process.env.AUDREY_PERF_PARENT_DIR,
    tmpdir(),
    join(process.cwd(), 'benchmarks', '.tmp'),
  ].filter(Boolean);
  let lastError;

  for (const parent of parents) {
    try {
      mkdirSync(parent, { recursive: true });
      return mkdtempSync(join(parent, 'audrey-scale-'));
    } catch (err) {
      lastError = err;
    }
  }

  throw lastError || new Error('Unable to create Audrey scale benchmark data directory');
}

const CONTENT_TEMPLATES = [
  'Stripe webhook retry exhausted exponential backoff after HTTP 429 during checkout.',
  'npm run build failed on Windows with EPERM spawning rimraf against dist/.',
  'Vector recall returned stale neighbors after a dimension change skipped reembedding.',
  'Guard blocked a repeated failing Bash command until the underlying fix landed.',
  'Consolidation merged three redundant episodes about calendar authority.',
  'FTS5 backfill missed rows written by a legacy pre-v9 migration path.',
  'Autopilot capsule truncated a must-follow warning past its char budget.',
  'Extinction learning cleared a stale failure streak once Edit succeeded again.',
  'Project scoping kept a foreign-repo failure from blocking this workspace.',
  'Hybrid recall favored BM25 over vector similarity for an exact identifier.',
];

const TOOL_NAMES = [
  'Bash',
  'Edit',
  'Write',
  'Read',
  'Grep',
  'Glob',
  'WebFetch',
  'MultiEdit',
  'NotebookEdit',
  'mcp__audrey-memory__memory_recall',
  'mcp__audrey-memory__memory_encode',
  'Task',
];

const ACTOR_AGENTS = ['claude-code', 'codex', undefined];

const EPISODE_SOURCES = [
  'direct-observation',
  'told-by-user',
  'tool-result',
  'inference',
  'model-generated',
];

function isoAt(baseMs, offsetMs) {
  return new Date(baseMs + offsetMs).toISOString();
}

async function seedMemoryRecords(db, embeddingProvider) {
  const pool = [];
  for (let i = 0; i < CONTENT_POOL_SIZE; i += 1) {
    pool.push(`${CONTENT_TEMPLATES[i % CONTENT_TEMPLATES.length]} Scale sample ${i}.`);
  }
  const vectors = await embeddingProvider.embedBatch(pool);
  const buffers = vectors.map(vector => embeddingProvider.vectorToBuffer(vector));

  const insertEpisode = db.prepare(`
    INSERT INTO episodes (
      id, content, embedding, source, agent, source_reliability, salience,
      context, affect, created_at, embedding_model, embedding_version, consolidated
    ) VALUES (
      @id, @content, @embedding, @source, @agent, 0.8, 0.5, '{}', '{}',
      @createdAt, @model, @version, 0
    )
  `);
  const insertVecEpisode = db.prepare(
    'INSERT INTO vec_episodes (id, agent, embedding, source, consolidated) VALUES (?, ?, ?, ?, ?)',
  );
  const insertSemantic = db.prepare(`
    INSERT INTO semantics (id, content, agent, embedding, state, created_at)
    VALUES (@id, @content, @agent, @embedding, 'active', @createdAt)
  `);
  const insertVecSemantic = db.prepare(
    "INSERT INTO vec_semantics (id, agent, embedding, state) VALUES (?, ?, ?, 'active')",
  );
  const insertProcedure = db.prepare(`
    INSERT INTO procedures (id, content, agent, embedding, state, created_at)
    VALUES (@id, @content, @agent, @embedding, 'active', @createdAt)
  `);
  const insertVecProcedure = db.prepare(
    "INSERT INTO vec_procedures (id, agent, embedding, state) VALUES (?, ?, ?, 'active')",
  );

  const now = Date.now();
  const spanMs = 60 * 24 * 60 * 60 * 1000; // 60 days of synthetic long-term-memory history

  const seedTx = db.transaction(() => {
    for (let i = 0; i < EPISODE_COUNT; i += 1) {
      const id = `ep-scale-${i}`;
      const createdAt = isoAt(now - spanMs, Math.floor((i / EPISODE_COUNT) * spanMs));
      const source = EPISODE_SOURCES[i % EPISODE_SOURCES.length];
      const embedding = buffers[i % CONTENT_POOL_SIZE];
      insertEpisode.run({
        id,
        content: pool[i % CONTENT_POOL_SIZE],
        embedding,
        source,
        agent: 'scale-bench',
        createdAt,
        model: embeddingProvider.modelName,
        version: embeddingProvider.modelVersion,
      });
      insertVecEpisode.run(id, 'scale-bench', embedding, source, BigInt(0));
    }

    for (let i = 0; i < SEMANTIC_COUNT; i += 1) {
      const id = `sem-scale-${i}`;
      const createdAt = isoAt(now - spanMs, Math.floor((i / SEMANTIC_COUNT) * spanMs));
      const embedding = buffers[i % CONTENT_POOL_SIZE];
      insertSemantic.run({
        id,
        content: pool[i % CONTENT_POOL_SIZE],
        agent: 'scale-bench',
        embedding,
        createdAt,
      });
      insertVecSemantic.run(id, 'scale-bench', embedding);
    }

    for (let i = 0; i < PROCEDURE_COUNT; i += 1) {
      const id = `proc-scale-${i}`;
      const createdAt = isoAt(now - spanMs, Math.floor((i / PROCEDURE_COUNT) * spanMs));
      const embedding = buffers[i % CONTENT_POOL_SIZE];
      insertProcedure.run({
        id,
        content: pool[i % CONTENT_POOL_SIZE],
        agent: 'scale-bench',
        embedding,
        createdAt,
      });
      insertVecProcedure.run(id, 'scale-bench', embedding);
    }
  });
  seedTx();
}

function seedMemoryEvents(db) {
  const now = Date.now();
  const spanMs = 10 * 24 * 60 * 60 * 1000; // 10 days of synthetic tool-call history
  const earliest = new Date(now - spanMs).toISOString();

  const seedTx = db.transaction(() => {
    for (let i = 0; i < EVENT_COUNT; i += 1) {
      const tool = TOOL_NAMES[i % TOOL_NAMES.length];
      const agent = ACTOR_AGENTS[i % ACTOR_AGENTS.length];
      const createdAt = isoAt(now - spanMs, Math.floor((i / EVENT_COUNT) * spanMs));
      const mod = i % 10;
      // Deterministic 70% succeeded / 20% failed / 5% blocked / 5% skipped
      // mix — realistic without relying on Math.random(), so the seed (and
      // therefore the timings) is reproducible across CI runs.
      const outcome =
        mod < 7 ? 'succeeded' : mod < 9 ? 'failed' : i % 2 === 0 ? 'blocked' : 'skipped';
      insertEvent(db, {
        eventType: outcome === 'failed' ? 'PostToolUseFailure' : 'PostToolUse',
        source: 'tool-trace',
        toolName: tool,
        actorAgent: agent,
        outcome,
        errorSummary: outcome === 'failed' ? `${tool} failed at sample ${i}` : undefined,
        createdAt,
      });
    }

    // Guarantee a few tools end on an unresolved failure streak so
    // recentFailures() always has real rows to rank, independent of how the
    // deterministic mix above happens to land for any given tool.
    for (const [index, tool] of ['Bash', 'Edit', 'WebFetch'].entries()) {
      insertEvent(db, {
        eventType: 'PostToolUseFailure',
        source: 'tool-trace',
        toolName: tool,
        actorAgent: 'claude-code',
        outcome: 'failed',
        errorSummary: `${tool} still failing at benchmark end`,
        createdAt: isoAt(now, 1000 * (index + 1)),
      });
    }
  });
  seedTx();

  return { earliest };
}

export async function runScaleBenchmark({
  runs = RUNS,
  budgets = SCALE_PERF_BUDGETS,
  out = console.log,
} = {}) {
  const dataDir = createScaleDataDir();
  const audrey = new Audrey({
    dataDir,
    agent: 'scale-bench',
    embedding: { provider: 'mock', dimensions: DIMENSIONS },
    llm: { provider: 'mock' },
  });

  try {
    await seedMemoryRecords(audrey.db, audrey.embeddingProvider);
    const { earliest } = seedMemoryEvents(audrey.db);

    const recentFailuresTimes = [];
    let lastFailures = [];
    for (let i = 0; i < runs; i += 1) {
      const startedAt = performance.now();
      lastFailures = recentFailures(audrey.db, {
        since: earliest,
        actorAgent: 'claude-code',
        limit: 20,
      });
      recentFailuresTimes.push(performance.now() - startedAt);
    }
    if (lastFailures.length === 0) {
      throw new Error(
        'recentFailures returned no active streaks; the seed is not exercising the fix',
      );
    }

    const capsuleTimes = [];
    for (let i = 0; i < runs; i += 1) {
      const startedAt = performance.now();
      await audrey.capsule('Bash exponential backoff webhook retry', {
        limit: 12,
        includeRisks: true,
        includeContradictions: true,
      });
      capsuleTimes.push(performance.now() - startedAt);
    }

    const preflightTimes = [];
    for (let i = 0; i < runs; i += 1) {
      const startedAt = performance.now();
      await buildPreflight(audrey, 'Bash: npm run build', {
        tool: 'Bash',
        recordEvent: false,
        includeCapsule: false,
      });
      preflightTimes.push(performance.now() - startedAt);
    }

    audrey.close();

    // Cold createDatabase() reopen, steady state: everything is already
    // synced, so this should cost a handful of MAX(rowid) lookups rather
    // than a full table scan.
    const steadyReopenTimes = [];
    let anyMigrated = false;
    for (let i = 0; i < runs; i += 1) {
      const startedAt = performance.now();
      const { db, migrated } = createDatabase(dataDir, { dimensions: DIMENSIONS });
      steadyReopenTimes.push(performance.now() - startedAt);
      anyMigrated = anyMigrated || migrated;
      closeDatabase(db);
    }
    if (anyMigrated) {
      throw new Error('createDatabase() reported a migration gap on an already-synced store');
    }

    // Cold createDatabase() reopen after a different connection wrote new
    // episodes without syncing vec0 — exactly the gap the high-water mark
    // exists to close on the next process's open. The catch-up cost should
    // scale with the delta (DELTA_EPISODE_COUNT), not the full table.
    const deltaContents = [];
    for (let i = 0; i < DELTA_EPISODE_COUNT; i += 1) {
      deltaContents.push(`${CONTENT_TEMPLATES[i % CONTENT_TEMPLATES.length]} Delta sample ${i}.`);
    }
    const deltaVectors = await audrey.embeddingProvider.embedBatch(deltaContents);
    const deltaBuffers = deltaVectors.map(vector =>
      audrey.embeddingProvider.vectorToBuffer(vector),
    );

    const dbPath = join(dataDir, 'audrey.db');
    const strayWriter = new Database(dbPath);
    try {
      const insertStray = strayWriter.prepare(`
        INSERT INTO episodes (
          id, content, embedding, source, agent, source_reliability, salience,
          context, affect, created_at, consolidated
        ) VALUES (
          @id, @content, @embedding, 'tool-result', 'scale-bench', 0.8, 0.5, '{}', '{}',
          @createdAt, 0
        )
      `);
      const strayTx = strayWriter.transaction(() => {
        for (let i = 0; i < DELTA_EPISODE_COUNT; i += 1) {
          insertStray.run({
            id: `ep-scale-delta-${i}`,
            content: deltaContents[i],
            embedding: deltaBuffers[i],
            createdAt: new Date().toISOString(),
          });
        }
      });
      strayTx();
    } finally {
      strayWriter.close();
    }

    const catchUpStartedAt = performance.now();
    const { db: catchUpDb, migrated: catchUpMigrated } = createDatabase(dataDir, {
      dimensions: DIMENSIONS,
    });
    const coldReopenCatchUpMs = roundMs(performance.now() - catchUpStartedAt);
    if (catchUpMigrated) {
      throw new Error(
        'createDatabase() left an unresolved sync gap after a same-dimension catch-up',
      );
    }
    const synced = catchUpDb
      .prepare("SELECT COUNT(*) AS c FROM vec_episodes WHERE id LIKE 'ep-scale-delta-%'")
      .get();
    closeDatabase(catchUpDb);
    if (synced.c !== DELTA_EPISODE_COUNT) {
      throw new Error(
        `createDatabase() catch-up synced ${synced.c}/${DELTA_EPISODE_COUNT} stray episodes`,
      );
    }

    const result = {
      runs,
      scale: {
        episodes: EPISODE_COUNT + DELTA_EPISODE_COUNT,
        semantics: SEMANTIC_COUNT,
        procedures: PROCEDURE_COUNT,
        memory_events: EVENT_COUNT + 3,
      },
      budgets,
      recent_failures_ms: stats(recentFailuresTimes),
      capsule_ms: stats(capsuleTimes),
      preflight_ms: stats(preflightTimes),
      cold_reopen_steady_ms: stats(steadyReopenTimes),
      cold_reopen_catch_up_ms: coldReopenCatchUpMs,
    };

    assertBudget('recentFailures p95', result.recent_failures_ms.p95, budgets.recentFailuresP95Ms);
    assertBudget('capsule p95', result.capsule_ms.p95, budgets.capsuleP95Ms);
    assertBudget('preflight p95', result.preflight_ms.p95, budgets.preflightP95Ms);
    assertBudget(
      'cold reopen (steady) p95',
      result.cold_reopen_steady_ms.p95,
      budgets.coldReopenSteadyP95Ms,
    );
    assertBudget(
      'cold reopen (catch-up)',
      result.cold_reopen_catch_up_ms,
      budgets.coldReopenCatchUpMs,
    );

    out(
      `Audrey scale gate passed: recentFailures p95=${result.recent_failures_ms.p95}ms, ` +
        `capsule p95=${result.capsule_ms.p95}ms, preflight p95=${result.preflight_ms.p95}ms, ` +
        `cold reopen steady p95=${result.cold_reopen_steady_ms.p95}ms, ` +
        `cold reopen catch-up=${result.cold_reopen_catch_up_ms}ms`,
    );
    return result;
  } finally {
    audrey.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runScaleBenchmark().catch(err => {
    console.error('[audrey] scale gate failed:', err);
    process.exit(1);
  });
}
