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
      {
        id: 'a',
        content: 'A',
        type: 'episodic',
        confidence: 0.9,
        score: 0.8,
        source: 'direct-observation',
        createdAt: '2026-01-01T00:00:00Z',
      },
      {
        id: 'b',
        content: 'B',
        type: 'episodic',
        confidence: 0.8,
        score: 0.7,
        source: 'direct-observation',
        createdAt: '2026-01-01T00:00:00Z',
      },
    ];
    const out = fuseResults(audrey.db, {
      vectorResults,
      ftsIds: new Map(),
      mode: 'vector',
    });
    expect(out).toBe(vectorResults);
  });

  it('hybrid mode boosts documents that appear in both vector and FTS', async () => {
    await audrey.encode({
      content: 'Stripe returns HTTP 429 when rate limit exceeded',
      source: 'direct-observation',
      tags: ['stripe'],
    });
    await audrey.encode({
      content: 'Unrelated note about the build cache',
      source: 'direct-observation',
    });
    await audrey.encode({
      content: 'Another unrelated memory about coffee preferences',
      source: 'direct-observation',
    });

    const vectorFirst = await audrey.recall('HTTP 429', { retrieval: 'vector', limit: 5 });
    const hybridFirst = await audrey.recall('HTTP 429', { retrieval: 'hybrid', limit: 5 });

    // Both modes should surface the Stripe memory.
    expect(hybridFirst.some(r => r.content.includes('429'))).toBe(true);
    expect(vectorFirst.some(r => r.content.includes('429'))).toBe(true);

    // The Stripe memory is the only one FTS matches on "HTTP 429" — combined
    // with whatever rank it gets from vector similarity, agreement between
    // both retrievers must put it in first place, not merely no worse than
    // vector-only (three unrelated-content candidates and only one real
    // match means this holds regardless of the mock embedding's vector rank).
    const hybridRank = hybridFirst.findIndex(r => r.content.includes('429'));
    expect(hybridRank).toBe(0);
  });

  it('an FTS-only exact match outranks a higher-scoring vector-only hit', async () => {
    const exactId = await audrey.encode({
      content: 'Zephyr order confirmation reference ZX-90210',
      source: 'direct-observation',
    });

    // A synthetic vector-only candidate with a near-perfect similarity*confidence
    // score — deliberately not present in FTS at all, and not backed by a real
    // row, so this exercises fuseResults() directly rather than depending on
    // the mock embedding provider producing any particular similarity ranking.
    const vectorOnly = {
      id: 'vector-only-adjacent',
      content: 'A semantically related but incorrect memory about order confirmations',
      type: 'episodic',
      confidence: 0.95,
      score: 0.99,
      source: 'direct-observation',
      createdAt: new Date().toISOString(),
    };

    const fused = fuseResults(audrey.db, {
      vectorResults: [vectorOnly],
      ftsIds: new Map([['episodic', [exactId]]]),
      mode: 'hybrid',
    });

    expect(fused[0].id).toBe(exactId);
    expect(fused.some(r => r.id === vectorOnly.id)).toBe(true);
    expect(fused.findIndex(r => r.id === vectorOnly.id)).toBeGreaterThan(0);
  });

  it('FTS-only enrichment respects the private flag on derived rows', async () => {
    const now = new Date().toISOString();
    audrey.db
      .prepare(
        `INSERT INTO semantics (id, content, agent, state, evidence_count, supporting_count,
           created_at, "private") VALUES (?, ?, 'hybrid-test', 'active', 3, 3, ?, 1)`,
      )
      .run('sem-private-fts', 'confidential rollout principle zz41', now);
    audrey.db
      .prepare(
        `INSERT INTO procedures (id, content, agent, state, success_count, failure_count,
           created_at, "private") VALUES (?, ?, 'hybrid-test', 'active', 2, 0, ?, 1)`,
      )
      .run('proc-private-fts', 'confidential deploy procedure zz42', now);

    const ftsIds = new Map([
      ['semantic', ['sem-private-fts']],
      ['procedural', ['proc-private-fts']],
    ]);

    const hidden = fuseResults(audrey.db, {
      vectorResults: [],
      ftsIds,
      mode: 'hybrid',
    });
    expect(hidden.some(r => r.id === 'sem-private-fts')).toBe(false);
    expect(hidden.some(r => r.id === 'proc-private-fts')).toBe(false);

    const shown = fuseResults(audrey.db, {
      vectorResults: [],
      ftsIds,
      mode: 'hybrid',
      includePrivate: true,
    });
    expect(shown.some(r => r.id === 'sem-private-fts')).toBe(true);
    expect(shown.some(r => r.id === 'proc-private-fts')).toBe(true);
  });

  it('keyword mode uses FTS rank order and drops non-FTS hits', async () => {
    await audrey.encode({ content: 'VACUUM ANALYZE optimization', source: 'tool-result' });
    await audrey.encode({
      content: 'Something else entirely about the sky',
      source: 'direct-observation',
    });

    const results = await audrey.recall('VACUUM', { retrieval: 'keyword', limit: 5 });
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].content).toContain('VACUUM');
    // Non-matching content must not appear in a keyword-only result.
    expect(results.every(r => !r.content.includes('sky'))).toBe(true);
  });

  it('keyword identifier intent returns the exact evidence hit without unrelated rows', async () => {
    const exactId = await audrey.encode({
      content: 'Audrey billing account number: 8675309',
      source: 'told-by-user',
    });
    await audrey.encode({
      content: 'Show account settings for the unrelated staging profile',
      source: 'direct-observation',
    });

    const results = await audrey.recall('Show account number', {
      retrieval: 'keyword',
      types: ['episodic'],
      limit: 5,
    });

    expect(results.map(result => result.id)).toEqual([exactId]);
  });

  it.each(['vector', 'hybrid'])(
    '%s identifier intent accepts a paraphrased label with value evidence and an anchor',
    async retrieval => {
      const testKey = ['sk', 'audrey_test_48291'].join('-');
      const exactId = await audrey.encode({
        content: `Production credential: ${testKey}`,
        source: 'told-by-user',
      });
      await audrey.encode({
        content: 'Production API key rotation is documented in the runbook',
        source: 'direct-observation',
      });

      const results = await audrey.recall('show production API key', {
        retrieval,
        types: ['episodic'],
        limit: 5,
      });

      expect(results.map(result => result.id)).toContain(exactId);
      expect(
        results.every(
          result => result.content !== 'Production API key rotation is documented in the runbook',
        ),
      ).toBe(true);
    },
  );

  it.each(['keyword', 'vector', 'hybrid'])(
    '%s identifier intent rejects label-only and tangential memories without a value',
    async retrieval => {
      await audrey.encode({
        content: 'Production API key is managed in the team vault',
        source: 'told-by-user',
      });
      await audrey.encode({
        content: 'Production deployment completed after the credential rotation',
        source: 'direct-observation',
      });
      await audrey.encode({
        content: 'Production account number: 8675309',
        source: 'direct-observation',
      });

      const results = await audrey.recall('show production API key', {
        retrieval,
        types: ['episodic'],
        limit: 5,
      });

      expect(results).toEqual([]);
    },
  );

  it.each(['keyword', 'vector', 'hybrid'])(
    '%s identifier intent returns only the requested owner value',
    async retrieval => {
      const requestedId = await audrey.encode({
        content: 'Sam account number: 24681357',
        source: 'told-by-user',
      });
      const otherOwnerId = await audrey.encode({
        content: 'Alice account number: 8675309',
        source: 'told-by-user',
      });

      const results = await audrey.recall("What is Sam's account number?", {
        retrieval,
        types: ['episodic'],
        limit: 5,
      });

      expect(results.map(result => result.id)).toContain(requestedId);
      expect(results.map(result => result.id)).not.toContain(otherOwnerId);
    },
  );

  it.each(['vector', 'hybrid'])(
    '%s identifier intent does not let shared environment context override owner mismatch',
    async retrieval => {
      const requestedKey = ['sk', 'riley_prod_48291'].join('-');
      const otherKey = ['sk', 'morgan_prod_73164'].join('-');
      const requestedId = await audrey.encode({
        content: `Riley production credential: ${requestedKey}`,
        source: 'told-by-user',
      });
      const otherOwnerId = await audrey.encode({
        content: `Morgan production credential: ${otherKey}`,
        source: 'told-by-user',
      });

      const results = await audrey.recall('show Riley production API key', {
        retrieval,
        types: ['episodic'],
        limit: 5,
      });

      expect(results.map(result => result.id)).toContain(requestedId);
      expect(results.map(result => result.id)).not.toContain(otherOwnerId);
    },
  );

  it('ftsIdsByType returns ranked id lists per memory type', async () => {
    const id1 = await audrey.encode({
      content: 'Redis SCAN safer than KEYS for iteration',
      source: 'told-by-user',
    });
    const id2 = await audrey.encode({
      content: 'Redis Pub/Sub for real-time channels',
      source: 'direct-observation',
    });
    const ids = ftsIdsByType(audrey.db, 'Redis', ['episodic'], 20);
    expect(ids.get('episodic')).toContain(id1);
    expect(ids.get('episodic')).toContain(id2);
  });

  it('ftsIdsByType sanitizes query — no explosion on FTS5 operators', () => {
    expect(() => ftsIdsByType(audrey.db, 'AND OR NOT', ['episodic'], 10)).not.toThrow();
    const out = ftsIdsByType(audrey.db, 'AND OR NOT', ['episodic'], 10);
    expect(out.get('episodic') ?? []).toEqual([]);
  });

  it('ftsIdsByType sanitizes path punctuation', () => {
    expect(() =>
      ftsIdsByType(
        audrey.db,
        'cwd:B:\\projects\\claude\\audrey\\.tmp-vitest tool:Bash',
        ['episodic'],
        10,
      ),
    ).not.toThrow();
  });

  it('hybrid respects tag filters on FTS-only hits', async () => {
    await audrey.encode({
      content: 'alpha-tagged memory about deploys',
      source: 'direct-observation',
      tags: ['alpha'],
    });
    await audrey.encode({
      content: 'beta-tagged memory about deploys',
      source: 'direct-observation',
      tags: ['beta'],
    });

    const results = await audrey.recall('deploys', {
      retrieval: 'hybrid',
      tags: ['alpha'],
      limit: 5,
    });
    expect(results.every(r => r.content.includes('alpha-tagged'))).toBe(true);
    expect(results.some(r => r.content.includes('beta-tagged'))).toBe(false);
  });

  it('hybrid requires all requested tags on FTS-only hits', async () => {
    await audrey.encode({
      content: 'memorygym alpha deploy note',
      source: 'direct-observation',
      tags: ['memorygym', 'run-a', 'scenario-alpha'],
    });
    await audrey.encode({
      content: 'memorygym beta deploy note',
      source: 'direct-observation',
      tags: ['memorygym', 'run-a', 'scenario-beta'],
    });

    const results = await audrey.recall('deploy note', {
      retrieval: 'hybrid',
      tags: ['memorygym', 'run-a', 'scenario-alpha'],
      limit: 5,
    });

    expect(results.some(r => r.content.includes('alpha deploy'))).toBe(true);
    expect(results.some(r => r.content.includes('beta deploy'))).toBe(false);
  });

  it('hybrid respects source filters on FTS-only hits', async () => {
    await audrey.encode({ content: 'first deployment note', source: 'told-by-user' });
    await audrey.encode({ content: 'second deployment note', source: 'direct-observation' });

    const results = await audrey.recall('deployment', {
      retrieval: 'hybrid',
      sources: ['told-by-user'],
      limit: 5,
    });
    expect(results.every(r => r.source === 'told-by-user')).toBe(true);
  });

  it('FTS stays in sync after forget — keyword recall no longer returns the forgotten id', async () => {
    const id = await audrey.encode({
      content: 'a unique redactable phrase xyz123',
      source: 'direct-observation',
    });
    const before = await audrey.recall('xyz123', { retrieval: 'keyword', limit: 5 });
    expect(before.some(r => r.id === id)).toBe(true);

    audrey.forget(id, { purge: true });
    const after = await audrey.recall('xyz123', { retrieval: 'keyword', limit: 5 });
    expect(after.some(r => r.id === id)).toBe(false);
  });
});
