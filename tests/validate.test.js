import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { validateMemory, createContradiction, reopenContradiction } from '../src/validate.js';
import { createDatabase, closeDatabase } from '../src/db.js';
import { MockEmbeddingProvider } from '../src/embedding.js';
import { existsSync, rmSync, mkdirSync } from 'node:fs';

const TEST_DIR = './test-validate-data';

describe('validateMemory', () => {
  let db, embedding;

  beforeEach(async () => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
    db = createDatabase(TEST_DIR);
    embedding = new MockEmbeddingProvider({ dimensions: 8 });
  });

  afterEach(() => {
    closeDatabase(db);
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  it('reinforces existing semantic memory when similar episode is added', async () => {
    // Insert a semantic memory
    const vec = await embedding.embed('Stripe rate limit is 100 req/s');
    const vecBuf = embedding.vectorToBuffer(vec);
    db.prepare(`INSERT INTO semantics (id, content, embedding, state, evidence_count,
      supporting_count, source_type_diversity, created_at, evidence_episode_ids)
      VALUES (?, ?, ?, 'active', 1, 1, 1, ?, ?)`).run(
      'sem-1', 'Stripe rate limit is 100 req/s', vecBuf, new Date().toISOString(), JSON.stringify(['ep-0'])
    );

    // Validate a new similar episode (SAME content = SAME embedding = similarity 1.0)
    const result = await validateMemory(db, embedding, {
      id: 'ep-1',
      content: 'Stripe rate limit is 100 req/s',
      source: 'direct-observation',
    });

    expect(result.action).toBe('reinforced');
    const sem = db.prepare('SELECT supporting_count, evidence_episode_ids FROM semantics WHERE id = ?').get('sem-1');
    expect(sem.supporting_count).toBe(2);
    expect(JSON.parse(sem.evidence_episode_ids)).toContain('ep-1');
  });

  it('returns no-action when no similar memories exist', async () => {
    const result = await validateMemory(db, embedding, {
      id: 'ep-1',
      content: 'Completely novel observation about quantum computing',
      source: 'direct-observation',
    });
    expect(result.action).toBe('none');
  });

  it('updates source_type_diversity on reinforcement', async () => {
    const vec = await embedding.embed('test memory content');
    const vecBuf = embedding.vectorToBuffer(vec);
    // Insert semantic with one source type
    db.prepare(`INSERT INTO semantics (id, content, embedding, state, evidence_count,
      supporting_count, source_type_diversity, created_at, evidence_episode_ids)
      VALUES (?, ?, ?, 'active', 1, 1, 1, ?, ?)`).run(
      'sem-2', 'test memory content', vecBuf, new Date().toISOString(), JSON.stringify(['ep-0'])
    );
    // Insert the original episode with source 'inference'
    db.prepare(`INSERT INTO episodes (id, content, source, source_reliability, created_at)
      VALUES (?, ?, ?, ?, ?)`).run('ep-0', 'test memory content', 'inference', 0.6, new Date().toISOString());

    // Reinforce with a different source type
    const result = await validateMemory(db, embedding, {
      id: 'ep-1',
      content: 'test memory content',
      source: 'direct-observation',
    });

    expect(result.action).toBe('reinforced');
    const sem = db.prepare('SELECT source_type_diversity FROM semantics WHERE id = ?').get('sem-2');
    expect(sem.source_type_diversity).toBe(2); // inference + direct-observation
  });
});

describe('createContradiction', () => {
  let db;

  beforeEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
    db = createDatabase(TEST_DIR);
  });

  afterEach(() => {
    closeDatabase(db);
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  it('creates a contradiction record', () => {
    const id = createContradiction(db, 'ep-1', 'episodic', 'ep-2', 'episodic');
    const row = db.prepare('SELECT * FROM contradictions WHERE id = ?').get(id);
    expect(row.state).toBe('open');
    expect(row.claim_a_id).toBe('ep-1');
    expect(row.claim_b_id).toBe('ep-2');
  });

  it('creates resolved contradiction with resolution', () => {
    const id = createContradiction(db, 'sem-1', 'semantic', 'ep-5', 'episodic', { winner: 'sem-1', reason: 'higher confidence' });
    const row = db.prepare('SELECT * FROM contradictions WHERE id = ?').get(id);
    expect(row.state).toBe('resolved');
    expect(JSON.parse(row.resolution).winner).toBe('sem-1');
  });
});

describe('reopenContradiction', () => {
  let db;

  beforeEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
    db = createDatabase(TEST_DIR);
  });

  afterEach(() => {
    closeDatabase(db);
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  it('reopens a resolved contradiction with new evidence', () => {
    const id = createContradiction(db, 'ep-1', 'episodic', 'ep-2', 'episodic', { winner: 'ep-1' });
    reopenContradiction(db, id, 'ep-99');
    const row = db.prepare('SELECT * FROM contradictions WHERE id = ?').get(id);
    expect(row.state).toBe('reopened');
    expect(row.reopen_evidence_id).toBe('ep-99');
    expect(row.reopened_at).not.toBeNull();
  });
});
