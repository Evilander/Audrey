import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { encodeEpisode } from '../src/encode.js';
import { createDatabase, closeDatabase } from '../src/db.js';
import { MockEmbeddingProvider } from '../src/embedding.js';
import { existsSync, rmSync, mkdirSync } from 'node:fs';

const TEST_DIR = './test-encode-data';

describe('encodeEpisode', () => {
  let db, embedding;

  beforeEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
    db = createDatabase(TEST_DIR);
    embedding = new MockEmbeddingProvider({ dimensions: 8 });
  });

  afterEach(() => {
    closeDatabase(db);
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  it('creates an episodic memory and returns its ID', async () => {
    const id = await encodeEpisode(db, embedding, {
      content: 'Stripe API returned 429',
      source: 'direct-observation',
    });
    expect(typeof id).toBe('string');
    expect(id.length).toBeGreaterThan(0);
  });

  it('stores content, source, and source_reliability in the database', async () => {
    const id = await encodeEpisode(db, embedding, {
      content: 'Stripe API returned 429',
      source: 'direct-observation',
    });
    const row = db.prepare('SELECT * FROM episodes WHERE id = ?').get(id);
    expect(row.content).toBe('Stripe API returned 429');
    expect(row.source).toBe('direct-observation');
    expect(row.source_reliability).toBe(0.95);
  });

  it('stores embedding as a blob', async () => {
    const id = await encodeEpisode(db, embedding, {
      content: 'test',
      source: 'direct-observation',
    });
    const row = db.prepare('SELECT embedding FROM episodes WHERE id = ?').get(id);
    expect(row.embedding).not.toBeNull();
    expect(Buffer.isBuffer(row.embedding)).toBe(true);
  });

  it('stores causal context', async () => {
    const id = await encodeEpisode(db, embedding, {
      content: 'Rate limit hit',
      source: 'direct-observation',
      causal: { trigger: 'batch-processing', consequence: 'queue-backup' },
    });
    const row = db.prepare('SELECT causal_trigger, causal_consequence FROM episodes WHERE id = ?').get(id);
    expect(row.causal_trigger).toBe('batch-processing');
    expect(row.causal_consequence).toBe('queue-backup');
  });

  it('stores tags as JSON', async () => {
    const id = await encodeEpisode(db, embedding, {
      content: 'test',
      source: 'direct-observation',
      tags: ['stripe', 'rate-limit'],
    });
    const row = db.prepare('SELECT tags FROM episodes WHERE id = ?').get(id);
    expect(JSON.parse(row.tags)).toEqual(['stripe', 'rate-limit']);
  });

  it('stores salience (custom)', async () => {
    const id = await encodeEpisode(db, embedding, {
      content: 'critical error',
      source: 'direct-observation',
      salience: 0.95,
    });
    const row = db.prepare('SELECT salience FROM episodes WHERE id = ?').get(id);
    expect(row.salience).toBe(0.95);
  });

  it('uses default salience of 0.5', async () => {
    const id = await encodeEpisode(db, embedding, {
      content: 'normal event',
      source: 'direct-observation',
    });
    const row = db.prepare('SELECT salience FROM episodes WHERE id = ?').get(id);
    expect(row.salience).toBe(0.5);
  });

  it('stores embedding model and version', async () => {
    const id = await encodeEpisode(db, embedding, {
      content: 'test',
      source: 'direct-observation',
    });
    const row = db.prepare('SELECT embedding_model, embedding_version FROM episodes WHERE id = ?').get(id);
    expect(row.embedding_model).toBe('mock-embedding');
    expect(row.embedding_version).toBe('1.0.0');
  });

  it('supports supersedes link for corrections', async () => {
    const id1 = await encodeEpisode(db, embedding, {
      content: 'Stripe limit is 50 req/s',
      source: 'inference',
    });
    const id2 = await encodeEpisode(db, embedding, {
      content: 'Stripe limit is 100 req/s',
      source: 'direct-observation',
      supersedes: id1,
    });
    const row = db.prepare('SELECT supersedes FROM episodes WHERE id = ?').get(id2);
    expect(row.supersedes).toBe(id1);
    const original = db.prepare('SELECT superseded_by FROM episodes WHERE id = ?').get(id1);
    expect(original.superseded_by).toBe(id2);
  });

  it('rejects invalid source types', async () => {
    await expect(encodeEpisode(db, embedding, {
      content: 'test',
      source: 'made-up',
    })).rejects.toThrow();
  });
});
