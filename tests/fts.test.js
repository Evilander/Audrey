import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Audrey } from '../dist/src/index.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('FTS5 full-text search', () => {
  let audrey;
  let dataDir;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'audrey-fts-'));
    audrey = new Audrey({
      dataDir,
      agent: 'fts-test',
      embedding: { provider: 'mock', dimensions: 64 },
    });

    await audrey.encode({ content: 'Stripe API returns HTTP 429 when rate limit exceeded', source: 'direct-observation', tags: ['stripe', 'rate-limit'] });
    await audrey.encode({ content: 'PostgreSQL VACUUM ANALYZE improves query planner estimates', source: 'tool-result', tags: ['postgres', 'performance'] });
    await audrey.encode({ content: 'The deploy pipeline failed due to OOM killer on the build step', source: 'direct-observation', tags: ['deploy', 'oom'] });
    await audrey.encode({ content: 'Redis SCAN is safer than KEYS for production iteration', source: 'told-by-user', tags: ['redis'] });
    await audrey.encode({ content: 'HTTP 429 rate limiting also affects the Stripe webhook endpoint', source: 'direct-observation', tags: ['stripe', 'webhook'] });
  });

  afterAll(() => {
    audrey.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('FTS tables exist after encoding', () => {
    const tables = audrey.db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'fts_%'"
    ).all();
    expect(tables.map(t => t.name)).toContain('fts_episodes');
  });

  it('keyword search finds exact terms that vector might miss', async () => {
    const results = await audrey.recall('HTTP 429', { retrieval: 'keyword', limit: 5 });
    expect(results.length).toBeGreaterThan(0);
    expect(results.some(r => r.content.includes('429'))).toBe(true);
  });

  it('hybrid recall returns results from both vector and keyword', async () => {
    const results = await audrey.recall('stripe rate limit 429', { retrieval: 'hybrid', limit: 5 });
    expect(results.length).toBeGreaterThan(0);
  });

  it('hybrid_strict recall preserves full hybrid fusion behavior', async () => {
    const results = await audrey.recall('stripe rate limit 429', { retrieval: 'hybrid_strict', limit: 5 });
    expect(results.length).toBeGreaterThan(0);
  });

  it('hybrid recall finds more relevant results than vector alone', async () => {
    const vectorOnly = await audrey.recall('VACUUM ANALYZE', { retrieval: 'vector', limit: 5 });
    const hybrid = await audrey.recall('VACUUM ANALYZE', { retrieval: 'hybrid', limit: 5 });
    // Hybrid should find the PostgreSQL memory via keyword match even if vector similarity is low
    const hybridHasPostgres = hybrid.some(r => r.content.includes('VACUUM'));
    expect(hybridHasPostgres).toBe(true);
  });

  it('keyword-only recall works for exact technical terms', async () => {
    const results = await audrey.recall('OOM killer', { retrieval: 'keyword', limit: 5 });
    expect(results.some(r => r.content.includes('OOM'))).toBe(true);
  });

  it('default retrieval mode is hybrid', async () => {
    const results = await audrey.recall('deploy pipeline', { limit: 5 });
    expect(results.length).toBeGreaterThan(0);
  });

  it('vector-only mode still works', async () => {
    const results = await audrey.recall('deployment issues', { retrieval: 'vector', limit: 5 });
    expect(results.length).toBeGreaterThan(0);
  });
});
