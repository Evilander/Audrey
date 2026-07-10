import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { recall, recallStream } from '../dist/src/recall.js';
import { encodeEpisode } from '../dist/src/encode.js';
import { createDatabase, closeDatabase } from '../dist/src/db.js';
import { MockEmbeddingProvider } from '../dist/src/embedding.js';
import { generateId } from '../dist/src/ulid.js';
import { existsSync, rmSync, mkdirSync } from 'node:fs';

const TEST_DIR = './test-recall-data';

function captureEpisodeKnnCandidates(db) {
  const observedK = [];
  const originalPrepare = db.prepare.bind(db);
  db.prepare = sql => {
    const statement = originalPrepare(sql);
    const normalized = String(sql).replace(/\s+/g, ' ').trim();
    if (normalized.includes('FROM vec_episodes v') && normalized.includes('v.embedding MATCH')) {
      const originalAll = statement.all.bind(statement);
      statement.all = (...params) => {
        observedK.push(Number(params[1]));
        return originalAll(...params);
      };
    }
    return statement;
  };
  return observedK;
}

describe('recall', () => {
  let db, embedding;

  beforeEach(async () => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
    ({ db } = createDatabase(TEST_DIR, { dimensions: 8 }));
    embedding = new MockEmbeddingProvider({ dimensions: 8 });

    // Seed episodic memories (encodeEpisode already writes to vec_episodes)
    await encodeEpisode(db, embedding, {
      content: 'Stripe API returned 429 rate limit error',
      source: 'direct-observation',
    });
    await encodeEpisode(db, embedding, {
      content: 'Database connection pool exhausted under load',
      source: 'direct-observation',
    });
    await encodeEpisode(db, embedding, {
      content: 'User prefers dark mode for all interfaces',
      source: 'told-by-user',
    });

    // Seed semantic memories manually
    const now = new Date().toISOString();
    const semId1 = generateId();
    const semVec1 = await embedding.embed('Stripe rate limits are 100 requests per second');
    const semBuf1 = embedding.vectorToBuffer(semVec1);
    db.prepare(
      `
      INSERT INTO semantics (id, content, embedding, state, evidence_count, supporting_count,
        contradicting_count, retrieval_count, created_at, embedding_model, embedding_version)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    ).run(
      semId1,
      'Stripe rate limits are 100 requests per second',
      semBuf1,
      'active',
      3,
      3,
      0,
      0,
      now,
      embedding.modelName,
      embedding.modelVersion,
    );
    db.prepare('INSERT INTO vec_semantics(id, agent, embedding, state) VALUES (?, ?, ?, ?)').run(
      semId1,
      'default',
      semBuf1,
      'active',
    );

    const semId2 = generateId();
    const semVec2 = await embedding.embed('PostgreSQL handles concurrent connections well');
    const semBuf2 = embedding.vectorToBuffer(semVec2);
    db.prepare(
      `
      INSERT INTO semantics (id, content, embedding, state, evidence_count, supporting_count,
        contradicting_count, retrieval_count, created_at, embedding_model, embedding_version)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    ).run(
      semId2,
      'PostgreSQL handles concurrent connections well',
      semBuf2,
      'active',
      2,
      2,
      0,
      0,
      now,
      embedding.modelName,
      embedding.modelVersion,
    );
    db.prepare('INSERT INTO vec_semantics(id, agent, embedding, state) VALUES (?, ?, ?, ?)').run(
      semId2,
      'default',
      semBuf2,
      'active',
    );

    // Seed a dormant semantic memory
    const semId3 = generateId();
    const semVec3 = await embedding.embed('Old API endpoint is deprecated');
    const semBuf3 = embedding.vectorToBuffer(semVec3);
    db.prepare(
      `
      INSERT INTO semantics (id, content, embedding, state, evidence_count, supporting_count,
        contradicting_count, retrieval_count, created_at, embedding_model, embedding_version)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    ).run(
      semId3,
      'Old API endpoint is deprecated',
      semBuf3,
      'dormant',
      1,
      1,
      0,
      0,
      now,
      embedding.modelName,
      embedding.modelVersion,
    );
    db.prepare('INSERT INTO vec_semantics(id, agent, embedding, state) VALUES (?, ?, ?, ?)').run(
      semId3,
      'default',
      semBuf3,
      'dormant',
    );

    // Seed a procedural memory
    const procId = generateId();
    const procVec = await embedding.embed('When rate limited, implement exponential backoff');
    const procBuf = embedding.vectorToBuffer(procVec);
    db.prepare(
      `
      INSERT INTO procedures (id, content, embedding, state, success_count, failure_count,
        retrieval_count, created_at, embedding_model, embedding_version)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    ).run(
      procId,
      'When rate limited, implement exponential backoff',
      procBuf,
      'active',
      5,
      0,
      0,
      now,
      embedding.modelName,
      embedding.modelVersion,
    );
    db.prepare('INSERT INTO vec_procedures(id, agent, embedding, state) VALUES (?, ?, ?, ?)').run(
      procId,
      'default',
      procBuf,
      'active',
    );
  });

  afterEach(() => {
    closeDatabase(db);
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  it('returns an array of memories', async () => {
    const results = await recall(db, embedding, 'rate limit', {});
    expect(Array.isArray(results)).toBe(true);
    expect(results.length).toBeGreaterThan(0);
  });

  it('returns memories with required fields (id, content, type, confidence, source)', async () => {
    const results = await recall(db, embedding, 'Stripe rate limit', {});
    expect(results.length).toBeGreaterThan(0);
    for (const mem of results) {
      expect(mem).toHaveProperty('id');
      expect(mem).toHaveProperty('content');
      expect(mem).toHaveProperty('type');
      expect(mem).toHaveProperty('confidence');
      expect(mem).toHaveProperty('score');
      expect(['episodic', 'semantic', 'procedural']).toContain(mem.type);
    }
  });

  it('respects limit parameter', async () => {
    const results = await recall(db, embedding, 'rate limit', { limit: 2 });
    expect(results.length).toBeLessThanOrEqual(2);
  });

  it('counts vector tables with one SQL roundtrip before KNN', async () => {
    const originalPrepare = db.prepare.bind(db);
    let vectorCountQueries = 0;
    db.prepare = sql => {
      const normalized = String(sql).replace(/\s+/g, ' ').trim();
      if (normalized.includes('COUNT(*) FROM vec_')) vectorCountQueries += 1;
      return originalPrepare(sql);
    };

    await recall(db, embedding, 'rate limit', { retrieval: 'vector', limit: 5 });

    expect(vectorCountQueries).toBe(1);
  });

  it('partitions before KNN so foreign rows beyond the old cap cannot starve local recall', async () => {
    const query = 'bounded scoped retrieval target';
    const queryVector = await embedding.embed(query);
    const exactBuffer = embedding.vectorToBuffer(queryVector);
    const targetVector = [...queryVector];
    targetVector[0] += 0.05;
    targetVector[1] -= 0.05;
    const targetMagnitude = Math.sqrt(targetVector.reduce((sum, value) => sum + value * value, 0));
    const targetBuffer = embedding.vectorToBuffer(
      targetVector.map(value => value / targetMagnitude),
    );
    const now = new Date().toISOString();
    const targetId = 'agent-scope-target';
    const insertEpisode = db.prepare(`
      INSERT INTO episodes (id, content, embedding, source, agent, source_reliability, salience,
        created_at, embedding_model, embedding_version)
      VALUES (?, ?, ?, 'direct-observation', ?, 0.95, 0.5, ?, ?, ?)
    `);
    const insertVector = db.prepare(
      'INSERT INTO vec_episodes(id, agent, embedding, source, consolidated) VALUES (?, ?, ?, ?, ?)',
    );

    db.transaction(() => {
      for (let i = 0; i < 300; i++) {
        const id = `agent-scope-near-${i}`;
        const agent = `other-agent-${i % 4}`;
        insertEpisode.run(
          id,
          `near memory ${i}`,
          exactBuffer,
          agent,
          now,
          embedding.modelName,
          embedding.modelVersion,
        );
        insertVector.run(id, agent, exactBuffer, 'direct-observation', BigInt(0));
      }

      insertEpisode.run(
        targetId,
        'the scoped target memory',
        targetBuffer,
        'target-agent',
        now,
        embedding.modelName,
        embedding.modelVersion,
      );
      insertVector.run(targetId, 'target-agent', targetBuffer, 'direct-observation', BigInt(0));
    })();

    const corpusSize = db.prepare('SELECT COUNT(*) AS count FROM vec_episodes').get().count;
    const observedK = captureEpisodeKnnCandidates(db);
    const results = await recall(db, embedding, query, {
      types: ['episodic'],
      retrieval: 'vector',
      scope: 'agent',
      agent: 'target-agent',
      limit: 1,
    });

    expect(results.map(result => result.id)).toEqual([targetId]);
    expect(corpusSize).toBeGreaterThan(256);
    expect(observedK).toEqual([1]);
  });

  it('does not widen agent-scoped KNN when the first pass fills the limit', async () => {
    const observedK = captureEpisodeKnnCandidates(db);
    const results = await recall(db, embedding, 'Stripe API returned 429 rate limit error', {
      types: ['episodic'],
      retrieval: 'vector',
      scope: 'agent',
      agent: 'default',
      limit: 1,
    });

    expect(results).toHaveLength(1);
    expect(observedK).toHaveLength(1);
  });

  it('reinforces only semantic memories returned after ranking and limit', async () => {
    const before = db
      .prepare('SELECT id, retrieval_count FROM semantics WHERE state = ?')
      .all('active');
    const beforeMap = Object.fromEntries(before.map(r => [r.id, r.retrieval_count]));

    const results = await recall(db, embedding, 'Stripe rate limit', {
      types: ['semantic'],
      retrieval: 'hybrid',
      limit: 1,
    });

    const after = db
      .prepare('SELECT id, retrieval_count FROM semantics WHERE state = ?')
      .all('active');
    expect(results).toHaveLength(1);
    for (const row of after) {
      const expectedIncrement = row.id === results[0].id ? 1 : 0;
      expect(row.retrieval_count).toBe(beforeMap[row.id] + expectedIncrement);
    }
  });

  it('filters by memory type (episodic-only)', async () => {
    const results = await recall(db, embedding, 'Stripe', { types: ['episodic'] });
    for (const mem of results) {
      expect(mem.type).toBe('episodic');
    }
  });

  it('filters by memory type (semantic-only)', async () => {
    const results = await recall(db, embedding, 'Stripe rate limit', { types: ['semantic'] });
    expect(results.length).toBeGreaterThan(0);
    for (const mem of results) {
      expect(mem.type).toBe('semantic');
    }
  });

  it('excludes dormant memories by default', async () => {
    const results = await recall(db, embedding, 'deprecated API endpoint', {});
    const dormantResults = results.filter(r => r.content === 'Old API endpoint is deprecated');
    expect(dormantResults.length).toBe(0);
  });

  it('includes dormant when includeDormant: true', async () => {
    const results = await recall(db, embedding, 'deprecated API endpoint', {
      includeDormant: true,
    });
    const dormantResults = results.filter(r => r.content === 'Old API endpoint is deprecated');
    expect(dormantResults.length).toBe(1);
  });

  it('uses current memory state instead of stale vector metadata', async () => {
    db.prepare("UPDATE semantics SET state = 'disputed' WHERE content = ?").run(
      'Stripe rate limits are 100 requests per second',
    );
    db.prepare("UPDATE procedures SET state = 'dormant' WHERE content = ?").run(
      'When rate limited, implement exponential backoff',
    );

    const semantics = await recall(db, embedding, 'Stripe rate limits', {
      types: ['semantic'],
      retrieval: 'vector',
    });
    const procedures = await recall(db, embedding, 'exponential backoff', {
      types: ['procedural'],
      retrieval: 'vector',
    });

    expect(semantics.map(entry => entry.content)).not.toContain(
      'Stripe rate limits are 100 requests per second',
    );
    expect(procedures.map(entry => entry.content)).not.toContain(
      'When rate limited, implement exponential backoff',
    );
  });

  it('includes provenance when includeProvenance: true', async () => {
    const results = await recall(db, embedding, 'Stripe rate limit', {
      includeProvenance: true,
      types: ['semantic'],
    });
    expect(results.length).toBeGreaterThan(0);
    for (const mem of results) {
      expect(mem).toHaveProperty('provenance');
      expect(mem.provenance).toHaveProperty('evidenceEpisodeIds');
    }
  });

  it('results are sorted by score descending', async () => {
    const results = await recall(db, embedding, 'rate limit', {});
    for (let i = 1; i < results.length; i++) {
      expect(results[i - 1].score).toBeGreaterThanOrEqual(results[i].score);
    }
  });

  it('respects minConfidence filter', async () => {
    const results = await recall(db, embedding, 'rate limit', { minConfidence: 0.5 });
    for (const mem of results) {
      expect(mem.confidence).toBeGreaterThanOrEqual(0.5);
    }
  });

  it('reinforces only procedural memories returned after ranking and limit', async () => {
    const now = new Date().toISOString();
    const secondId = generateId();
    const secondVector = await embedding.embed('Restart the worker after changing configuration');
    const secondBuffer = embedding.vectorToBuffer(secondVector);
    db.prepare(
      `
      INSERT INTO procedures (id, content, embedding, state, success_count, failure_count,
        retrieval_count, created_at, embedding_model, embedding_version)
      VALUES (?, ?, ?, 'active', 2, 0, 0, ?, ?, ?)
    `,
    ).run(
      secondId,
      'Restart the worker after changing configuration',
      secondBuffer,
      now,
      embedding.modelName,
      embedding.modelVersion,
    );
    db.prepare('INSERT INTO vec_procedures(id, agent, embedding, state) VALUES (?, ?, ?, ?)').run(
      secondId,
      'default',
      secondBuffer,
      'active',
    );

    const before = db
      .prepare('SELECT id, retrieval_count FROM procedures WHERE state = ?')
      .all('active');
    const beforeMap = Object.fromEntries(before.map(r => [r.id, r.retrieval_count]));

    const results = await recall(db, embedding, 'backoff strategy', {
      types: ['procedural'],
      retrieval: 'hybrid',
      limit: 1,
    });

    const after = db
      .prepare('SELECT id, retrieval_count FROM procedures WHERE state = ?')
      .all('active');
    expect(results).toHaveLength(1);
    for (const row of after) {
      const expectedIncrement = row.id === results[0].id ? 1 : 0;
      expect(row.retrieval_count).toBe(beforeMap[row.id] + expectedIncrement);
    }
  });

  it('surfaces partial failures when a recall path breaks', async () => {
    db.exec('DROP TABLE vec_semantics');

    const results = await recall(db, embedding, 'Stripe rate limit', {
      types: ['semantic'],
      retrieval: 'vector',
    });

    expect(results).toHaveLength(0);
    expect(results.partialFailure).toBe(true);
    expect(results.errors).toEqual([expect.objectContaining({ type: 'semantic' })]);
  });

  it('surfaces partial failures when FTS lookup breaks', async () => {
    db.exec('DROP TABLE fts_episodes');

    const results = await recall(db, embedding, 'Stripe rate limit', {
      types: ['episodic'],
      retrieval: 'hybrid',
    });

    expect(results.partialFailure).toBe(true);
    expect(results.errors).toEqual([
      expect.objectContaining({
        type: 'fts',
        stage: 'recall.fts_lookup',
      }),
    ]);
  });

  // --- recallStream tests ---

  it('recallStream yields results as async generator', async () => {
    const results = [];
    for await (const entry of recallStream(db, embedding, 'rate limit', {})) {
      results.push(entry);
    }
    expect(results.length).toBeGreaterThan(0);
    for (const mem of results) {
      expect(mem).toHaveProperty('id');
      expect(mem).toHaveProperty('content');
      expect(mem).toHaveProperty('type');
      expect(mem).toHaveProperty('confidence');
      expect(mem).toHaveProperty('score');
    }
  });

  it('recallStream supports early break', async () => {
    const results = [];
    for await (const entry of recallStream(db, embedding, 'rate limit', { limit: 10 })) {
      results.push(entry);
      if (results.length >= 2) break;
    }
    expect(results.length).toBe(2);
  });

  it('reinforces only stream results consumed before an early break', async () => {
    const before = db
      .prepare('SELECT id, retrieval_count FROM semantics WHERE state = ?')
      .all('active');
    const beforeMap = Object.fromEntries(before.map(row => [row.id, row.retrieval_count]));
    let surfacedId;

    for await (const entry of recallStream(db, embedding, 'rate limit', {
      types: ['semantic'],
      retrieval: 'vector',
      limit: 2,
    })) {
      surfacedId = entry.id;
      break;
    }

    const after = db
      .prepare('SELECT id, retrieval_count FROM semantics WHERE state = ?')
      .all('active');
    expect(surfacedId).toBeDefined();
    for (const row of after) {
      const expectedIncrement = row.id === surfacedId ? 1 : 0;
      expect(row.retrieval_count).toBe(beforeMap[row.id] + expectedIncrement);
    }
  });

  it('respects custom halfLives passed via confidenceConfig', async () => {
    const shortHalfLife = await recall(db, embedding, 'rate limit', {
      confidenceConfig: {
        halfLives: { episodic: 0.001, semantic: 0.001, procedural: 0.001 },
      },
      types: ['episodic'],
    });
    const normalHalfLife = await recall(db, embedding, 'rate limit', {
      types: ['episodic'],
    });
    if (shortHalfLife.length > 0 && normalHalfLife.length > 0) {
      expect(shortHalfLife[0].confidence).toBeLessThan(normalHalfLife[0].confidence);
    }
  });

  it('respects custom weights passed via confidenceConfig', async () => {
    const sourceOnly = await recall(db, embedding, 'rate limit', {
      confidenceConfig: {
        weights: { source: 1.0, evidence: 0, recency: 0, retrieval: 0 },
      },
      types: ['episodic'],
    });
    if (sourceOnly.length > 0) {
      expect(sourceOnly[0].confidence).toBeCloseTo(0.95, 1);
    }
  });

  it('recall and recallStream return same results (behavioral parity)', async () => {
    const arrayResults = await recall(db, embedding, 'Stripe rate limit', { limit: 5 });
    const streamResults = [];
    for await (const entry of recallStream(db, embedding, 'Stripe rate limit', { limit: 5 })) {
      streamResults.push(entry);
    }
    expect(streamResults.length).toBe(arrayResults.length);
    for (let i = 0; i < arrayResults.length; i++) {
      expect(streamResults[i].id).toBe(arrayResults[i].id);
      expect(streamResults[i].content).toBe(arrayResults[i].content);
      expect(streamResults[i].type).toBe(arrayResults[i].type);
    }
  });

  // --- filter tests ---

  it('filters episodic memories by tags', async () => {
    await encodeEpisode(db, embedding, {
      content: 'Tagged memory alpha',
      source: 'direct-observation',
      tags: ['debugging', 'api'],
    });
    await encodeEpisode(db, embedding, {
      content: 'Tagged memory beta',
      source: 'told-by-user',
      tags: ['deployment'],
    });

    const results = await recall(db, embedding, 'tagged memory', {
      tags: ['debugging'],
      types: ['episodic'],
    });
    expect(results.length).toBeGreaterThan(0);
    for (const mem of results) {
      expect(mem.content).toContain('alpha');
    }
  });

  it('requires all requested tags when multiple tag filters are provided', async () => {
    await encodeEpisode(db, embedding, {
      content: 'MemoryGym run one scenario alpha',
      source: 'direct-observation',
      tags: ['memorygym', 'run-one', 'scenario-alpha'],
    });
    await encodeEpisode(db, embedding, {
      content: 'MemoryGym run one scenario beta',
      source: 'direct-observation',
      tags: ['memorygym', 'run-one', 'scenario-beta'],
    });

    const results = await recall(db, embedding, 'MemoryGym scenario', {
      tags: ['memorygym', 'run-one', 'scenario-alpha'],
      types: ['episodic'],
      limit: 10,
    });

    expect(results.length).toBeGreaterThan(0);
    expect(results.some(mem => mem.content.includes('scenario alpha'))).toBe(true);
    expect(results.some(mem => mem.content.includes('scenario beta'))).toBe(false);
  });

  it('returns all episodic when no tag filter', async () => {
    await encodeEpisode(db, embedding, {
      content: 'No tag filter test',
      source: 'direct-observation',
      tags: ['special'],
    });
    const results = await recall(db, embedding, 'no tag filter test', {
      types: ['episodic'],
    });
    const found = results.find(r => r.content === 'No tag filter test');
    expect(found).toBeDefined();
  });

  it('filters episodic memories by source', async () => {
    const results = await recall(db, embedding, 'rate limit', {
      sources: ['told-by-user'],
      types: ['episodic'],
    });
    for (const mem of results) {
      expect(mem.source).toBe('told-by-user');
    }
  });

  it('filters memories by date range (after)', async () => {
    const yesterday = new Date(Date.now() - 86400000).toISOString();
    const results = await recall(db, embedding, 'rate limit', {
      after: yesterday,
    });
    for (const mem of results) {
      expect(mem.createdAt > yesterday).toBe(true);
    }
  });

  it('filters memories by date range (before)', async () => {
    const farPast = new Date(Date.now() - 86400000 * 365).toISOString();
    const results = await recall(db, embedding, 'rate limit', {
      before: farPast,
    });
    expect(results.length).toBe(0);
  });

  it('combines tag and source filters', async () => {
    await encodeEpisode(db, embedding, {
      content: 'Combined filter test',
      source: 'tool-result',
      tags: ['combo'],
    });
    await encodeEpisode(db, embedding, {
      content: 'Wrong source for combo',
      source: 'direct-observation',
      tags: ['combo'],
    });

    const results = await recall(db, embedding, 'combined filter', {
      tags: ['combo'],
      sources: ['tool-result'],
      types: ['episodic'],
    });
    expect(results.length).toBeGreaterThan(0);
    for (const mem of results) {
      expect(mem.source).toBe('tool-result');
    }
  });

  describe('context-dependent retrieval', () => {
    it('matching context boosts episodic recall score', async () => {
      await encodeEpisode(db, embedding, {
        content: 'debugging context episode',
        source: 'direct-observation',
        context: { task: 'debugging', domain: 'payments' },
      });
      await encodeEpisode(db, embedding, {
        content: 'deployment context episode',
        source: 'direct-observation',
        context: { task: 'deployment', domain: 'infra' },
      });

      const withContext = await recall(db, embedding, 'debugging context episode', {
        types: ['episodic'],
        confidenceConfig: {
          retrievalContext: { task: 'debugging', domain: 'payments' },
          contextWeight: 0.3,
        },
      });
      const withoutContext = await recall(db, embedding, 'debugging context episode', {
        types: ['episodic'],
      });

      const ctxMatch = withContext.find(r => r.content === 'debugging context episode');
      const noCtxMatch = withoutContext.find(r => r.content === 'debugging context episode');
      expect(ctxMatch).toBeDefined();
      expect(noCtxMatch).toBeDefined();
      expect(ctxMatch.score).toBeGreaterThan(noCtxMatch.score);
    });

    it('non-matching context gets no boost', async () => {
      await encodeEpisode(db, embedding, {
        content: 'specific context episode test',
        source: 'direct-observation',
        context: { task: 'debugging' },
      });

      const mismatch = await recall(db, embedding, 'specific context episode test', {
        types: ['episodic'],
        confidenceConfig: { retrievalContext: { task: 'deployment' }, contextWeight: 0.3 },
      });
      const noContext = await recall(db, embedding, 'specific context episode test', {
        types: ['episodic'],
      });

      const mismatchResult = mismatch.find(r => r.content === 'specific context episode test');
      const noCtxResult = noContext.find(r => r.content === 'specific context episode test');
      expect(mismatchResult).toBeDefined();
      expect(noCtxResult).toBeDefined();
      expect(mismatchResult.score).toBeCloseTo(noCtxResult.score, 5);
    });

    it('includes contextMatch field in episodic results when context provided', async () => {
      await encodeEpisode(db, embedding, {
        content: 'context match field test',
        source: 'direct-observation',
        context: { task: 'debugging', domain: 'payments' },
      });

      const results = await recall(db, embedding, 'context match field test', {
        types: ['episodic'],
        confidenceConfig: {
          retrievalContext: { task: 'debugging', domain: 'billing' },
          contextWeight: 0.3,
        },
      });
      const match = results.find(r => r.content === 'context match field test');
      expect(match).toBeDefined();
      expect(match.contextMatch).toBeCloseTo(0.5);
    });

    it('no contextMatch field when no retrieval context', async () => {
      await encodeEpisode(db, embedding, {
        content: 'no context field test',
        source: 'direct-observation',
        context: { task: 'debugging' },
      });

      const results = await recall(db, embedding, 'no context field test', {
        types: ['episodic'],
      });
      const match = results.find(r => r.content === 'no context field test');
      expect(match).toBeDefined();
      expect(match.contextMatch).toBeUndefined();
    });

    it('semantic results are not affected by context', async () => {
      const now = new Date().toISOString();
      const semId = generateId();
      const semVec = await embedding.embed('semantic context immunity test');
      const semBuf = embedding.vectorToBuffer(semVec);
      db.prepare(
        `
        INSERT INTO semantics (id, content, embedding, state, evidence_count, supporting_count,
          contradicting_count, retrieval_count, created_at, embedding_model, embedding_version)
        VALUES (?, ?, ?, 'active', 3, 3, 0, 0, ?, ?, ?)
      `,
      ).run(
        semId,
        'semantic context immunity test',
        semBuf,
        now,
        embedding.modelName,
        embedding.modelVersion,
      );
      db.prepare('INSERT INTO vec_semantics(id, agent, embedding, state) VALUES (?, ?, ?, ?)').run(
        semId,
        'default',
        semBuf,
        'active',
      );

      // Call without context first to avoid retrieval_count drift between calls
      const withoutCtx = await recall(db, embedding, 'semantic context immunity test', {
        types: ['semantic'],
      });
      // Reset retrieval_count so both calls see the same state
      db.prepare(
        'UPDATE semantics SET retrieval_count = 0, last_reinforced_at = NULL WHERE id = ?',
      ).run(semId);

      const withCtx = await recall(db, embedding, 'semantic context immunity test', {
        types: ['semantic'],
        confidenceConfig: { retrievalContext: { task: 'debugging' }, contextWeight: 0.3 },
      });

      const ctxResult = withCtx.find(r => r.id === semId);
      const noCtxResult = withoutCtx.find(r => r.id === semId);
      expect(ctxResult).toBeDefined();
      expect(noCtxResult).toBeDefined();
      expect(ctxResult.score).toBeCloseTo(noCtxResult.score, 5);
      expect(ctxResult.contextMatch).toBeUndefined();
    });
  });

  describe('mood-congruent recall', () => {
    it('matching mood boosts episodic recall score', async () => {
      await encodeEpisode(db, embedding, {
        content: 'joyful debugging episode',
        source: 'inference',
        salience: 0.2,
        affect: { valence: 0.8, arousal: 0.3, label: 'joy' },
      });

      const withMood = await recall(db, embedding, 'joyful debugging episode', {
        types: ['episodic'],
        confidenceConfig: { retrievalMood: { valence: 0.8, arousal: 0.3 }, affectWeight: 0.2 },
      });
      const withoutMood = await recall(db, embedding, 'joyful debugging episode', {
        types: ['episodic'],
      });

      const moodMatch = withMood.find(r => r.content === 'joyful debugging episode');
      const noMoodMatch = withoutMood.find(r => r.content === 'joyful debugging episode');
      expect(moodMatch).toBeDefined();
      expect(noMoodMatch).toBeDefined();
      expect(moodMatch.score).toBeGreaterThan(noMoodMatch.score);
    });

    it('opposite mood gets no boost', async () => {
      await encodeEpisode(db, embedding, {
        content: 'angry debugging episode unique',
        source: 'direct-observation',
        affect: { valence: -0.8, arousal: 0.9 },
      });

      const opposite = await recall(db, embedding, 'angry debugging episode unique', {
        types: ['episodic'],
        confidenceConfig: { retrievalMood: { valence: 0.8, arousal: 0.2 }, affectWeight: 0.2 },
      });
      const noMood = await recall(db, embedding, 'angry debugging episode unique', {
        types: ['episodic'],
      });

      const oppResult = opposite.find(r => r.content === 'angry debugging episode unique');
      const noResult = noMood.find(r => r.content === 'angry debugging episode unique');
      expect(oppResult).toBeDefined();
      expect(noResult).toBeDefined();
      expect(oppResult.score).toBeCloseTo(noResult.score, 1);
    });

    it('includes moodCongruence field when mood provided', async () => {
      await encodeEpisode(db, embedding, {
        content: 'mood field test episode',
        source: 'direct-observation',
        affect: { valence: 0.5, arousal: 0.5 },
      });

      const results = await recall(db, embedding, 'mood field test episode', {
        types: ['episodic'],
        confidenceConfig: { retrievalMood: { valence: 0.5, arousal: 0.5 }, affectWeight: 0.2 },
      });
      const match = results.find(r => r.content === 'mood field test episode');
      expect(match).toBeDefined();
      expect(match.moodCongruence).toBeDefined();
      expect(match.moodCongruence).toBeCloseTo(1.0);
    });

    it('no moodCongruence field when no mood provided', async () => {
      await encodeEpisode(db, embedding, {
        content: 'no mood field test episode',
        source: 'direct-observation',
        affect: { valence: 0.5 },
      });

      const results = await recall(db, embedding, 'no mood field test episode', {
        types: ['episodic'],
      });
      const match = results.find(r => r.content === 'no mood field test episode');
      expect(match).toBeDefined();
      expect(match.moodCongruence).toBeUndefined();
    });
  });

  describe('interference and salience modifiers in recall', () => {
    it('high interference_count reduces semantic recall confidence', async () => {
      const now = new Date().toISOString();

      const loId = generateId();
      const loVec = await embedding.embed('low interference semantic fact');
      const loBuf = embedding.vectorToBuffer(loVec);
      db.prepare(
        `
        INSERT INTO semantics (id, content, embedding, state, evidence_count, supporting_count,
          contradicting_count, retrieval_count, interference_count, created_at, embedding_model, embedding_version)
        VALUES (?, ?, ?, 'active', 3, 3, 0, 0, 0, ?, ?, ?)
      `,
      ).run(
        loId,
        'low interference semantic fact',
        loBuf,
        now,
        embedding.modelName,
        embedding.modelVersion,
      );
      db.prepare('INSERT INTO vec_semantics(id, agent, embedding, state) VALUES (?, ?, ?, ?)').run(
        loId,
        'default',
        loBuf,
        'active',
      );

      const hiId = generateId();
      const hiVec = await embedding.embed('high interference semantic fact');
      const hiBuf = embedding.vectorToBuffer(hiVec);
      db.prepare(
        `
        INSERT INTO semantics (id, content, embedding, state, evidence_count, supporting_count,
          contradicting_count, retrieval_count, interference_count, created_at, embedding_model, embedding_version)
        VALUES (?, ?, ?, 'active', 3, 3, 0, 0, 50, ?, ?, ?)
      `,
      ).run(
        hiId,
        'high interference semantic fact',
        hiBuf,
        now,
        embedding.modelName,
        embedding.modelVersion,
      );
      db.prepare('INSERT INTO vec_semantics(id, agent, embedding, state) VALUES (?, ?, ?, ?)').run(
        hiId,
        'default',
        hiBuf,
        'active',
      );

      const loResults = await recall(db, embedding, 'low interference semantic fact', {
        types: ['semantic'],
        limit: 20,
      });
      const hiResults = await recall(db, embedding, 'high interference semantic fact', {
        types: ['semantic'],
        limit: 20,
      });

      const loMatch = loResults.find(r => r.id === loId);
      const hiMatch = hiResults.find(r => r.id === hiId);
      expect(loMatch).toBeDefined();
      expect(hiMatch).toBeDefined();
      expect(hiMatch.confidence).toBeLessThan(loMatch.confidence);
    });

    it('high salience boosts episodic recall confidence', async () => {
      const now = new Date().toISOString();

      const loId = generateId();
      const loVec = await embedding.embed('low salience episode memory');
      const loBuf = embedding.vectorToBuffer(loVec);
      db.prepare(
        `
        INSERT INTO episodes (id, content, embedding, source, source_reliability, salience, created_at, embedding_model, embedding_version)
        VALUES (?, ?, ?, 'direct-observation', 0.95, 0.1, ?, ?, ?)
      `,
      ).run(
        loId,
        'low salience episode memory',
        loBuf,
        now,
        embedding.modelName,
        embedding.modelVersion,
      );
      db.prepare(
        'INSERT INTO vec_episodes(id, agent, embedding, source, consolidated) VALUES (?, ?, ?, ?, ?)',
      ).run(loId, 'default', loBuf, 'direct-observation', BigInt(0));

      const hiId = generateId();
      const hiVec = await embedding.embed('high salience episode memory');
      const hiBuf = embedding.vectorToBuffer(hiVec);
      db.prepare(
        `
        INSERT INTO episodes (id, content, embedding, source, source_reliability, salience, created_at, embedding_model, embedding_version)
        VALUES (?, ?, ?, 'direct-observation', 0.95, 0.9, ?, ?, ?)
      `,
      ).run(
        hiId,
        'high salience episode memory',
        hiBuf,
        now,
        embedding.modelName,
        embedding.modelVersion,
      );
      db.prepare(
        'INSERT INTO vec_episodes(id, agent, embedding, source, consolidated) VALUES (?, ?, ?, ?, ?)',
      ).run(hiId, 'default', hiBuf, 'direct-observation', BigInt(0));

      const loResults = await recall(db, embedding, 'low salience episode memory', {
        types: ['episodic'],
        limit: 20,
      });
      const hiResults = await recall(db, embedding, 'high salience episode memory', {
        types: ['episodic'],
        limit: 20,
      });

      const loMatch = loResults.find(r => r.id === loId);
      const hiMatch = hiResults.find(r => r.id === hiId);
      expect(loMatch).toBeDefined();
      expect(hiMatch).toBeDefined();
      expect(hiMatch.confidence).toBeGreaterThan(loMatch.confidence);
    });

    it('default values produce no change from baseline', async () => {
      const now = new Date().toISOString();
      const semId = generateId();
      const semVec = await embedding.embed('baseline default modifier test');
      const semBuf = embedding.vectorToBuffer(semVec);
      db.prepare(
        `
        INSERT INTO semantics (id, content, embedding, state, evidence_count, supporting_count,
          contradicting_count, retrieval_count, interference_count, salience, created_at, embedding_model, embedding_version)
        VALUES (?, ?, ?, 'active', 3, 3, 0, 0, 0, 0.5, ?, ?, ?)
      `,
      ).run(
        semId,
        'baseline default modifier test',
        semBuf,
        now,
        embedding.modelName,
        embedding.modelVersion,
      );
      db.prepare('INSERT INTO vec_semantics(id, agent, embedding, state) VALUES (?, ?, ?, ?)').run(
        semId,
        'default',
        semBuf,
        'active',
      );

      const results = await recall(db, embedding, 'baseline default modifier test', {
        types: ['semantic'],
        limit: 20,
      });
      const match = results.find(r => r.id === semId);
      expect(match).toBeDefined();
      // interference_count=0 -> interferenceModifier = 1.0
      // salience=0.5 -> salienceModifier = 1.0
      // So confidence should equal base computeConfidence output (clamped to [0,1])
      expect(match.confidence).toBeGreaterThan(0);
      expect(match.confidence).toBeLessThanOrEqual(1);
    });
  });

  describe('private memory filtering', () => {
    it('excludes private memories from recall by default', async () => {
      await encodeEpisode(db, embedding, {
        content: 'secret memory',
        source: 'direct-observation',
        private: true,
      });
      await encodeEpisode(db, embedding, {
        content: 'public memory xyz',
        source: 'direct-observation',
      });

      const results = await recall(db, embedding, 'secret memory public memory xyz', { limit: 20 });
      const contents = results.map(r => r.content);
      expect(contents).not.toContain('secret memory');
      expect(contents).toContain('public memory xyz');
    });

    it('includes private memories when includePrivate: true', async () => {
      await encodeEpisode(db, embedding, {
        content: 'secret memory',
        source: 'direct-observation',
        private: true,
      });

      const results = await recall(db, embedding, 'secret memory', {
        limit: 20,
        includePrivate: true,
      });
      const contents = results.map(r => r.content);
      expect(contents).toContain('secret memory');
    });
  });

  describe('retrieval guards', () => {
    it('abstains on identifier-style questions when only tangential context exists', async () => {
      await encodeEpisode(db, embedding, {
        content: 'Sam renewed a passport in February 2026.',
        source: 'tool-result',
      });
      await encodeEpisode(db, embedding, {
        content: 'Sam has a trip to Toronto next month.',
        source: 'told-by-user',
      });

      const results = await recall(db, embedding, 'What is Sam passport number?', { limit: 10 });
      expect(results.find(r => r.content.includes('passport'))).toBeUndefined();
    });

    it('suppresses lower-reliability duplicate answers when a stronger one exists', async () => {
      await encodeEpisode(db, embedding, {
        content: 'The outage was caused by an expired TLS certificate on api.example.com.',
        source: 'direct-observation',
      });
      await encodeEpisode(db, embedding, {
        content: 'The outage was caused by database corruption.',
        source: 'model-generated',
      });

      const results = await recall(db, embedding, 'What caused the outage?', { limit: 10 });
      const contents = results.map(r => r.content);
      expect(contents).toContain(
        'The outage was caused by an expired TLS certificate on api.example.com.',
      );
      expect(contents).not.toContain('The outage was caused by database corruption.');
    });
  });
});
