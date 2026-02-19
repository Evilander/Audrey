import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { recall } from '../src/recall.js';
import { encodeEpisode } from '../src/encode.js';
import { createDatabase, closeDatabase } from '../src/db.js';
import { MockEmbeddingProvider } from '../src/embedding.js';
import { generateId } from '../src/ulid.js';
import { existsSync, rmSync, mkdirSync } from 'node:fs';

const TEST_DIR = './test-recall-data';

describe('recall', () => {
  let db, embedding;

  beforeEach(async () => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
    db = createDatabase(TEST_DIR);
    embedding = new MockEmbeddingProvider({ dimensions: 8 });

    // Seed episodic memories
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
    const semVec1 = await embedding.embed('Stripe rate limits are 100 requests per second');
    const semBuf1 = embedding.vectorToBuffer(semVec1);
    db.prepare(`
      INSERT INTO semantics (id, content, embedding, state, evidence_count, supporting_count,
        contradicting_count, retrieval_count, created_at, embedding_model, embedding_version)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      generateId(), 'Stripe rate limits are 100 requests per second', semBuf1,
      'active', 3, 3, 0, 0, now, embedding.modelName, embedding.modelVersion
    );

    const semVec2 = await embedding.embed('PostgreSQL handles concurrent connections well');
    const semBuf2 = embedding.vectorToBuffer(semVec2);
    db.prepare(`
      INSERT INTO semantics (id, content, embedding, state, evidence_count, supporting_count,
        contradicting_count, retrieval_count, created_at, embedding_model, embedding_version)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      generateId(), 'PostgreSQL handles concurrent connections well', semBuf2,
      'active', 2, 2, 0, 0, now, embedding.modelName, embedding.modelVersion
    );

    // Seed a dormant semantic memory
    const semVec3 = await embedding.embed('Old API endpoint is deprecated');
    const semBuf3 = embedding.vectorToBuffer(semVec3);
    db.prepare(`
      INSERT INTO semantics (id, content, embedding, state, evidence_count, supporting_count,
        contradicting_count, retrieval_count, created_at, embedding_model, embedding_version)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      generateId(), 'Old API endpoint is deprecated', semBuf3,
      'dormant', 1, 1, 0, 0, now, embedding.modelName, embedding.modelVersion
    );

    // Seed a procedural memory
    const procVec = await embedding.embed('When rate limited, implement exponential backoff');
    const procBuf = embedding.vectorToBuffer(procVec);
    db.prepare(`
      INSERT INTO procedures (id, content, embedding, state, success_count, failure_count,
        retrieval_count, created_at, embedding_model, embedding_version)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      generateId(), 'When rate limited, implement exponential backoff', procBuf,
      'active', 5, 0, 0, now, embedding.modelName, embedding.modelVersion
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

  it('increments retrieval_count on recalled semantic memories', async () => {
    // Get initial counts
    const before = db.prepare('SELECT id, retrieval_count FROM semantics WHERE state = ?').all('active');
    const beforeMap = Object.fromEntries(before.map(r => [r.id, r.retrieval_count]));

    await recall(db, embedding, 'Stripe rate limit', { types: ['semantic'] });

    const after = db.prepare('SELECT id, retrieval_count FROM semantics WHERE state = ?').all('active');
    const afterMap = Object.fromEntries(after.map(r => [r.id, r.retrieval_count]));

    // At least one semantic memory should have its retrieval_count incremented
    const incremented = after.some(r => afterMap[r.id] > (beforeMap[r.id] || 0));
    expect(incremented).toBe(true);
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

  it('also increments retrieval_count on recalled procedural memories', async () => {
    const before = db.prepare('SELECT id, retrieval_count FROM procedures WHERE state = ?').all('active');
    const beforeMap = Object.fromEntries(before.map(r => [r.id, r.retrieval_count]));

    await recall(db, embedding, 'backoff strategy', { types: ['procedural'] });

    const after = db.prepare('SELECT id, retrieval_count FROM procedures WHERE state = ?').all('active');
    const afterMap = Object.fromEntries(after.map(r => [r.id, r.retrieval_count]));

    const incremented = after.some(r => afterMap[r.id] > (beforeMap[r.id] || 0));
    expect(incremented).toBe(true);
  });
});
