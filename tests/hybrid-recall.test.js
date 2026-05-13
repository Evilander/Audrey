import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Audrey } from '../dist/src/index.js';
import { fuseResults, ftsIdsByType } from '../dist/src/hybrid-recall.js';
import { existsSync, rmSync, mkdirSync } from 'node:fs';

const TEST_DIR = './test-hybrid-recall-data';

describe('hybrid-recall — RRF fusion', () => {
  let audrey;

  beforeEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
    mkdirSync(TEST_DIR, { recursive: true });
    audrey = new Audrey({
      dataDir: TEST_DIR,
      agent: 'hybrid-test',
      embedding: { provider: 'mock', dimensions: 8 },
    });
  });

  afterEach(() => {
    audrey.close();
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("fuseResults in 'vector' mode is a pass-through", () => {
    const vectorResults = [
      { id: 'a', content: 'A', type: 'episodic', confidence: 0.9, score: 0.8, source: 'direct-observation', createdAt: '2026-01-01T00:00:00Z' },
      { id: 'b', content: 'B', type: 'episodic', confidence: 0.8, score: 0.7, source: 'direct-observation', createdAt: '2026-01-01T00:00:00Z' },
    ];
    const out = fuseResults(audrey.db, {
      vectorResults,
      ftsIds: new Map(),
      mode: 'vector',
    });
    expect(out).toBe(vectorResults);
  });

  it("hybrid mode boosts documents that appear in both vector and FTS", async () => {
    await audrey.encode({ content: 'Stripe returns HTTP 429 when rate limit exceeded', source: 'direct-observation', tags: ['stripe'] });
    await audrey.encode({ content: 'Unrelated note about the build cache', source: 'direct-observation' });
    await audrey.encode({ content: 'Another unrelated memory about coffee preferences', source: 'direct-observation' });

    const vectorFirst = await audrey.recall('HTTP 429', { retrieval: 'vector', limit: 5 });
    const hybridFirst = await audrey.recall('HTTP 429', { retrieval: 'hybrid', limit: 5 });

    // Both modes should surface the Stripe memory.
    expect(hybridFirst.some(r => r.content.includes('429'))).toBe(true);
    expect(vectorFirst.some(r => r.content.includes('429'))).toBe(true);

    // Hybrid should rank the FTS-matching memory at least as high as vector-only.
    const hybridRank = hybridFirst.findIndex(r => r.content.includes('429'));
    const vectorRank = vectorFirst.findIndex(r => r.content.includes('429'));
    expect(hybridRank).toBeLessThanOrEqual(vectorRank);
  });

  it("keyword mode uses FTS rank order and drops non-FTS hits", async () => {
    await audrey.encode({ content: 'VACUUM ANALYZE optimization', source: 'tool-result' });
    await audrey.encode({ content: 'Something else entirely about the sky', source: 'direct-observation' });

    const results = await audrey.recall('VACUUM', { retrieval: 'keyword', limit: 5 });
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].content).toContain('VACUUM');
    // Non-matching content must not appear in a keyword-only result.
    expect(results.every(r => !r.content.includes('sky'))).toBe(true);
  });

  it("ftsIdsByType returns ranked id lists per memory type", async () => {
    const id1 = await audrey.encode({ content: 'Redis SCAN safer than KEYS for iteration', source: 'told-by-user' });
    const id2 = await audrey.encode({ content: 'Redis Pub/Sub for real-time channels', source: 'direct-observation' });
    const ids = ftsIdsByType(audrey.db, 'Redis', ['episodic'], 20);
    expect(ids.get('episodic')).toContain(id1);
    expect(ids.get('episodic')).toContain(id2);
  });

  it("ftsIdsByType sanitizes query — no explosion on FTS5 operators", () => {
    expect(() => ftsIdsByType(audrey.db, 'AND OR NOT', ['episodic'], 10)).not.toThrow();
    const out = ftsIdsByType(audrey.db, 'AND OR NOT', ['episodic'], 10);
    expect(out.get('episodic') ?? []).toEqual([]);
  });

  it("ftsIdsByType sanitizes path punctuation", () => {
    expect(() => ftsIdsByType(audrey.db, 'cwd:B:\\projects\\claude\\audrey\\.tmp-vitest tool:Bash', ['episodic'], 10)).not.toThrow();
  });

  it("hybrid respects tag filters on FTS-only hits", async () => {
    await audrey.encode({ content: 'alpha-tagged memory about deploys', source: 'direct-observation', tags: ['alpha'] });
    await audrey.encode({ content: 'beta-tagged memory about deploys', source: 'direct-observation', tags: ['beta'] });

    const results = await audrey.recall('deploys', { retrieval: 'hybrid', tags: ['alpha'], limit: 5 });
    expect(results.every(r => r.content.includes('alpha-tagged'))).toBe(true);
    expect(results.some(r => r.content.includes('beta-tagged'))).toBe(false);
  });

  it("hybrid requires all requested tags on FTS-only hits", async () => {
    await audrey.encode({ content: 'memorygym alpha deploy note', source: 'direct-observation', tags: ['memorygym', 'run-a', 'scenario-alpha'] });
    await audrey.encode({ content: 'memorygym beta deploy note', source: 'direct-observation', tags: ['memorygym', 'run-a', 'scenario-beta'] });

    const results = await audrey.recall('deploy note', {
      retrieval: 'hybrid',
      tags: ['memorygym', 'run-a', 'scenario-alpha'],
      limit: 5,
    });

    expect(results.some(r => r.content.includes('alpha deploy'))).toBe(true);
    expect(results.some(r => r.content.includes('beta deploy'))).toBe(false);
  });

  it("hybrid respects source filters on FTS-only hits", async () => {
    await audrey.encode({ content: 'first deployment note', source: 'told-by-user' });
    await audrey.encode({ content: 'second deployment note', source: 'direct-observation' });

    const results = await audrey.recall('deployment', { retrieval: 'hybrid', sources: ['told-by-user'], limit: 5 });
    expect(results.every(r => r.source === 'told-by-user')).toBe(true);
  });

  it("FTS stays in sync after forget — keyword recall no longer returns the forgotten id", async () => {
    const id = await audrey.encode({ content: 'a unique redactable phrase xyz123', source: 'direct-observation' });
    const before = await audrey.recall('xyz123', { retrieval: 'keyword', limit: 5 });
    expect(before.some(r => r.id === id)).toBe(true);

    audrey.forget(id, { purge: true });
    const after = await audrey.recall('xyz123', { retrieval: 'keyword', limit: 5 });
    expect(after.some(r => r.id === id)).toBe(false);
  });
});
