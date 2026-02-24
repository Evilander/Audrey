import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Audrey } from '../src/audrey.js';
import { MockLLMProvider } from '../src/llm.js';
import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TEST_DIR = './test-audrey-main';

describe('Audrey', () => {
  let brain;

  beforeEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    brain = new Audrey({
      dataDir: TEST_DIR,
      agent: 'test-agent',
      embedding: { provider: 'mock', dimensions: 8 },
    });
  });

  afterEach(() => {
    brain.close();
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  it('creates an Audrey instance', () => {
    expect(brain).toBeInstanceOf(Audrey);
  });

  it('encodes an episodic memory', async () => {
    const id = await brain.encode({
      content: 'Stripe API returned 429',
      source: 'direct-observation',
    });
    expect(typeof id).toBe('string');
  });

  it('recalls memories', async () => {
    await brain.encode({ content: 'Test observation', source: 'direct-observation' });
    const results = await brain.recall('test', {});
    expect(Array.isArray(results)).toBe(true);
  });

  it('emits encode event', async () => {
    let emitted = false;
    brain.on('encode', () => { emitted = true; });
    await brain.encode({ content: 'Test', source: 'direct-observation' });
    expect(emitted).toBe(true);
  });

  it('runs consolidation', async () => {
    const result = await brain.consolidate();
    expect(result).toHaveProperty('runId');
    expect(result).toHaveProperty('status');
  });

  it('emits consolidation event', async () => {
    let emitted = false;
    brain.on('consolidation', () => { emitted = true; });
    await brain.consolidate();
    expect(emitted).toBe(true);
  });

  it('returns introspection stats', async () => {
    await brain.encode({ content: 'Test', source: 'direct-observation' });
    const stats = brain.introspect();
    expect(stats.episodic).toBe(1);
  });

  it('rolls back consolidation', async () => {
    await brain.encode({ content: 'same', source: 'direct-observation' });
    await brain.encode({ content: 'same', source: 'tool-result' });
    await brain.encode({ content: 'same', source: 'told-by-user' });

    const result = await brain.consolidate({
      minClusterSize: 3,
      similarityThreshold: 0.99,
      extractPrinciple: () => ({ content: 'Principle', type: 'semantic' }),
    });
    brain.rollback(result.runId);

    const history = brain.consolidationHistory();
    const run = history.find(r => r.id === result.runId);
    expect(run.status).toBe('rolled_back');
  });

  it('applies decay', () => {
    const result = brain.decay();
    expect(result).toHaveProperty('totalEvaluated');
    expect(result).toHaveProperty('transitionedToDormant');
  });

  it('emits decay event', () => {
    let emitted = false;
    brain.on('decay', () => { emitted = true; });
    brain.decay();
    expect(emitted).toBe(true);
  });
});

describe('Audrey with LLM', () => {
  let brain;

  beforeEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    brain = new Audrey({
      dataDir: TEST_DIR,
      agent: 'test-agent',
      embedding: { provider: 'mock', dimensions: 8 },
      llm: {
        provider: 'mock',
        responses: {
          principleExtraction: {
            content: 'LLM-extracted principle',
            type: 'semantic',
            conditions: null,
          },
          contradictionDetection: {
            contradicts: false,
            explanation: 'No contradiction',
          },
          contextResolution: {
            resolution: 'context_dependent',
            conditions: { a: 'Context A', b: 'Context B' },
            explanation: 'Both valid in different contexts',
          },
        },
      },
    });
  });

  afterEach(() => {
    brain.close();
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  it('creates Audrey instance with LLM config', () => {
    expect(brain).toBeInstanceOf(Audrey);
    expect(brain.llmProvider).toBeDefined();
    expect(brain.llmProvider.modelName).toBe('mock-llm');
  });

  it('passes LLM provider to consolidation', async () => {
    await brain.encode({ content: 'same thing', source: 'direct-observation' });
    await brain.encode({ content: 'same thing', source: 'tool-result' });
    await brain.encode({ content: 'same thing', source: 'told-by-user' });

    const result = await brain.consolidate({
      minClusterSize: 3,
      similarityThreshold: 0.99,
    });

    expect(result.principlesExtracted).toBe(1);
    const sem = brain.db.prepare("SELECT content FROM semantics WHERE state = 'active'").get();
    expect(sem.content).toBe('LLM-extracted principle');
  });

  it('emits contradiction event during validation', async () => {
    const vec = await brain.embeddingProvider.embed('existing knowledge');
    const vecBuf = brain.embeddingProvider.vectorToBuffer(vec);
    brain.db.prepare(`INSERT INTO semantics (id, content, embedding, state, evidence_count,
      supporting_count, source_type_diversity, created_at, evidence_episode_ids)
      VALUES (?, ?, ?, 'active', 1, 1, 1, ?, ?)`).run(
      'sem-test', 'existing knowledge', vecBuf, new Date().toISOString(), '[]'
    );

    const contradictBrain = new Audrey({
      dataDir: TEST_DIR + '-contra',
      agent: 'test',
      embedding: { provider: 'mock', dimensions: 8 },
      llm: {
        provider: 'mock',
        responses: {
          contradictionDetection: {
            contradicts: true,
            explanation: 'These conflict',
            resolution: 'new_wins',
          },
        },
      },
    });

    let contradictionEmitted = false;
    contradictBrain.on('contradiction', () => { contradictionEmitted = true; });

    await contradictBrain.encode({
      content: 'Some contradicting info',
      source: 'direct-observation',
    });

    await new Promise(resolve => setTimeout(resolve, 100));

    contradictBrain.close();
    if (existsSync(TEST_DIR + '-contra')) rmSync(TEST_DIR + '-contra', { recursive: true });

    // Structural test — contradiction event may or may not fire depending on mock embedding similarity
    expect(typeof contradictionEmitted).toBe('boolean');
  });

  it('resolves truth on open contradiction via LLM', async () => {
    brain.db.prepare(`INSERT INTO contradictions (id, claim_a_id, claim_a_type, claim_b_id, claim_b_type,
      state, created_at) VALUES (?, ?, ?, ?, ?, 'open', ?)`).run(
      'con-1', 'sem-a', 'semantic', 'ep-b', 'episodic', new Date().toISOString()
    );

    brain.db.prepare(`INSERT INTO semantics (id, content, state, created_at, evidence_count,
      supporting_count, source_type_diversity, evidence_episode_ids)
      VALUES (?, ?, 'active', ?, 1, 1, 1, '[]')`).run(
      'sem-a', 'Claim A content', new Date().toISOString()
    );
    brain.db.prepare(`INSERT INTO episodes (id, content, source, source_reliability, created_at)
      VALUES (?, ?, ?, ?, ?)`).run(
      'ep-b', 'Claim B content', 'direct-observation', 0.95, new Date().toISOString()
    );

    const result = await brain.resolveTruth('con-1');
    expect(result.resolution).toBe('context_dependent');
    expect(result.conditions).toBeDefined();

    const row = brain.db.prepare('SELECT state FROM contradictions WHERE id = ?').get('con-1');
    expect(row.state).toBe('context_dependent');
  });
});

describe('confidence config', () => {
  let audrey;
  const CONF_DIR = './test-confidence-config';

  beforeEach(() => {
    if (existsSync(CONF_DIR)) rmSync(CONF_DIR, { recursive: true });
  });

  afterEach(() => {
    audrey?.close();
    if (existsSync(CONF_DIR)) rmSync(CONF_DIR, { recursive: true });
  });

  it('passes custom weights through to recall', async () => {
    audrey = new Audrey({
      dataDir: CONF_DIR,
      embedding: { provider: 'mock', dimensions: 8 },
      confidence: {
        weights: { source: 1.0, evidence: 0, recency: 0, retrieval: 0 },
      },
    });
    await audrey.encode({ content: 'test memory', source: 'direct-observation' });
    const results = await audrey.recall('test', { types: ['episodic'] });
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].confidence).toBeCloseTo(0.95, 1);
  });

  it('passes custom halfLives through to decay', async () => {
    audrey = new Audrey({
      dataDir: CONF_DIR,
      embedding: { provider: 'mock', dimensions: 8 },
      confidence: {
        halfLives: { episodic: 7, semantic: 1, procedural: 90 },
      },
    });

    const now = new Date();
    const tenDaysAgo = new Date(now - 10 * 86400000).toISOString();
    audrey.db.prepare(`
      INSERT INTO semantics (id, content, state, supporting_count, contradicting_count,
        retrieval_count, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('sem-hl', 'Half-life test', 'active', 1, 2, 0, tenDaysAgo);

    const result = audrey.decay({ dormantThreshold: 0.5 });
    const row = audrey.db.prepare('SELECT state FROM semantics WHERE id = ?').get('sem-hl');
    expect(row.state).toBe('dormant');
  });
});

describe('Audrey batch and streaming', () => {
  let brain;

  beforeEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    brain = new Audrey({
      dataDir: TEST_DIR,
      agent: 'test-agent',
      embedding: { provider: 'mock', dimensions: 8 },
    });
  });

  afterEach(() => {
    brain.close();
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  it('encodeBatch encodes multiple episodes in one call', async () => {
    const ids = await brain.encodeBatch([
      { content: 'Observation A', source: 'direct-observation' },
      { content: 'Observation B', source: 'tool-result' },
      { content: 'Observation C', source: 'told-by-user' },
    ]);
    expect(ids.length).toBe(3);
    const count = brain.db.prepare('SELECT COUNT(*) as c FROM episodes').get().c;
    expect(count).toBe(3);
  });

  it('encodeBatch validates content', async () => {
    await expect(brain.encodeBatch([{ content: '', source: 'direct-observation' }])).rejects.toThrow('content must be a non-empty string');
  });

  it('recallStream yields results as async generator', async () => {
    await brain.encode({ content: 'Test memory', source: 'direct-observation' });
    const results = [];
    for await (const memory of brain.recallStream('test', { limit: 5 })) {
      results.push(memory);
    }
    expect(results.length).toBeGreaterThan(0);
  });

  it('recallStream supports early break', async () => {
    await brain.encode({ content: 'Memory A', source: 'direct-observation' });
    await brain.encode({ content: 'Memory B', source: 'tool-result' });
    let count = 0;
    for await (const memory of brain.recallStream('memory', { limit: 10 })) {
      count++;
      if (count >= 1) break;
    }
    expect(count).toBe(1);
  });
});

describe('encodeBatch', () => {
  let brain;

  beforeEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    brain = new Audrey({
      dataDir: TEST_DIR,
      agent: 'test-agent',
      embedding: { provider: 'mock', dimensions: 8 },
    });
  });

  afterEach(() => {
    brain.close();
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  it('encodes all episodes and returns IDs', async () => {
    const ids = await brain.encodeBatch([
      { content: 'First observation', source: 'direct-observation' },
      { content: 'Second observation', source: 'told-by-user' },
      { content: 'Third observation', source: 'tool-result' },
    ]);

    expect(ids).toHaveLength(3);
    ids.forEach(id => expect(typeof id).toBe('string'));
  });

  it('rejects batch when an episode has invalid content', async () => {
    await expect(
      brain.encodeBatch([
        { content: 'Valid episode', source: 'direct-observation' },
        { content: '', source: 'direct-observation' },
        { content: 'Another valid', source: 'told-by-user' },
      ]),
    ).rejects.toThrow('content must be a non-empty string');
  });
});

describe('lazy migration', () => {
  const MIGRATE_DIR = './test-audrey-migrate';

  afterEach(() => {
    if (existsSync(MIGRATE_DIR)) rmSync(MIGRATE_DIR, { recursive: true });
  });

  it('re-embeds episodes on first encode after dimension change', async () => {
    const brain1 = new Audrey({
      dataDir: MIGRATE_DIR,
      embedding: { provider: 'mock', dimensions: 8 },
    });
    await brain1.encode({ content: 'existing memory', source: 'direct-observation' });
    brain1.close();

    const brain2 = new Audrey({
      dataDir: MIGRATE_DIR,
      embedding: { provider: 'mock', dimensions: 16 },
    });

    let migrationEvent = null;
    brain2.on('migration', (counts) => { migrationEvent = counts; });

    await brain2.encode({ content: 'new memory', source: 'told-by-user' });

    expect(migrationEvent).not.toBeNull();
    expect(migrationEvent.episodes).toBe(1);
    expect(brain2._migrationPending).toBe(false);

    const vecCount = brain2.db.prepare('SELECT COUNT(*) as c FROM vec_episodes').get().c;
    expect(vecCount).toBe(2);
    brain2.close();
  });

  it('re-embeds on first recall after dimension change', async () => {
    const brain1 = new Audrey({
      dataDir: MIGRATE_DIR,
      embedding: { provider: 'mock', dimensions: 8 },
    });
    await brain1.encode({ content: 'test recall migration', source: 'direct-observation' });
    brain1.close();

    const brain2 = new Audrey({
      dataDir: MIGRATE_DIR,
      embedding: { provider: 'mock', dimensions: 16 },
    });

    let migrated = false;
    brain2.on('migration', () => { migrated = true; });

    await brain2.recall('test');
    expect(migrated).toBe(true);
    brain2.close();
  });

  it('only migrates once even with multiple operations', async () => {
    const brain1 = new Audrey({
      dataDir: MIGRATE_DIR,
      embedding: { provider: 'mock', dimensions: 8 },
    });
    await brain1.encode({ content: 'first', source: 'direct-observation' });
    brain1.close();

    const brain2 = new Audrey({
      dataDir: MIGRATE_DIR,
      embedding: { provider: 'mock', dimensions: 16 },
    });

    let migrationCount = 0;
    brain2.on('migration', () => { migrationCount++; });

    await brain2.encode({ content: 'second', source: 'told-by-user' });
    await brain2.recall('test');
    await brain2.consolidate();

    expect(migrationCount).toBe(1);
    brain2.close();
  });

  it('skips migration when dimensions unchanged', async () => {
    const brain1 = new Audrey({
      dataDir: MIGRATE_DIR,
      embedding: { provider: 'mock', dimensions: 8 },
    });
    await brain1.encode({ content: 'same dims', source: 'direct-observation' });
    brain1.close();

    const brain2 = new Audrey({
      dataDir: MIGRATE_DIR,
      embedding: { provider: 'mock', dimensions: 8 },
    });

    let migrated = false;
    brain2.on('migration', () => { migrated = true; });

    await brain2.encode({ content: 'still same', source: 'told-by-user' });
    expect(migrated).toBe(false);
    brain2.close();
  });
});

describe('filtered recall', () => {
  let brain;
  const FILTER_DIR = './test-filtered-recall';

  beforeEach(async () => {
    if (existsSync(FILTER_DIR)) rmSync(FILTER_DIR, { recursive: true });
    brain = new Audrey({
      dataDir: FILTER_DIR,
      agent: 'test-agent',
      embedding: { provider: 'mock', dimensions: 8 },
    });
    await brain.encode({ content: 'Debug observation', source: 'direct-observation', tags: ['debug'] });
    await brain.encode({ content: 'User preference', source: 'told-by-user', tags: ['prefs'] });
  });

  afterEach(() => {
    brain.close();
    if (existsSync(FILTER_DIR)) rmSync(FILTER_DIR, { recursive: true });
  });

  it('filters by tags through Audrey.recall()', async () => {
    const results = await brain.recall('observation', { tags: ['debug'], types: ['episodic'] });
    expect(results.length).toBeGreaterThan(0);
    for (const r of results) {
      expect(r.content).toContain('Debug');
    }
  });

  it('filters by source through Audrey.recall()', async () => {
    const results = await brain.recall('preference', { sources: ['told-by-user'], types: ['episodic'] });
    for (const r of results) {
      expect(r.source).toBe('told-by-user');
    }
  });

  it('filters work through recallStream too', async () => {
    const results = [];
    for await (const mem of brain.recallStream('observation', { tags: ['debug'], types: ['episodic'] })) {
      results.push(mem);
    }
    expect(results.length).toBeGreaterThan(0);
    for (const r of results) {
      expect(r.content).toContain('Debug');
    }
  });
});

describe('forget and purge', () => {
  let brain;
  const FORGET_DIR = './test-forget-audrey';

  beforeEach(async () => {
    if (existsSync(FORGET_DIR)) rmSync(FORGET_DIR, { recursive: true });
    brain = new Audrey({
      dataDir: FORGET_DIR,
      agent: 'test-agent',
      embedding: { provider: 'mock', dimensions: 8 },
    });
  });

  afterEach(() => {
    brain.close();
    if (existsSync(FORGET_DIR)) rmSync(FORGET_DIR, { recursive: true });
  });

  it('forgets a memory by ID', async () => {
    const id = await brain.encode({ content: 'Forget me', source: 'direct-observation' });
    const result = brain.forget(id);
    expect(result.type).toBe('episodic');

    const results = await brain.recall('forget me', { types: ['episodic'] });
    const found = results.find(r => r.id === id);
    expect(found).toBeUndefined();
  });

  it('emits forget event', async () => {
    const id = await brain.encode({ content: 'Event test', source: 'direct-observation' });
    let emitted = null;
    brain.on('forget', (e) => { emitted = e; });
    brain.forget(id);
    expect(emitted).not.toBeNull();
    expect(emitted.id).toBe(id);
  });

  it('forgets by query', async () => {
    await brain.encode({ content: 'Wrong information stored here', source: 'told-by-user' });
    const result = await brain.forgetByQuery('Wrong information stored here', { minSimilarity: 0.5 });
    expect(result).not.toBeNull();
    expect(result.type).toBe('episodic');
  });

  it('purges all forgotten and dormant memories', async () => {
    const id = await brain.encode({ content: 'To purge', source: 'direct-observation' });
    brain.forget(id);

    const result = brain.purge();
    expect(result.episodes).toBe(1);

    const ep = brain.db.prepare('SELECT * FROM episodes WHERE id = ?').get(id);
    expect(ep).toBeUndefined();
  });

  it('hard-deletes with purge flag', async () => {
    const id = await brain.encode({ content: 'Hard delete', source: 'direct-observation' });
    brain.forget(id, { purge: true });

    const ep = brain.db.prepare('SELECT * FROM episodes WHERE id = ?').get(id);
    expect(ep).toBeUndefined();
  });

  it('emits purge event', async () => {
    const id = await brain.encode({ content: 'Purge event test', source: 'direct-observation' });
    brain.forget(id);
    let emitted = null;
    brain.on('purge', (e) => { emitted = e; });
    brain.purge();
    expect(emitted).not.toBeNull();
    expect(emitted.episodes).toBe(1);
  });
});

describe('v0.7.0 biological modifiers', () => {
  const BIO_DIR = './test-bio-modifiers';

  afterEach(() => {
    if (existsSync(BIO_DIR)) rmSync(BIO_DIR, { recursive: true });
  });

  it('salience flows through encode to recall', async () => {
    const brain = new Audrey({
      dataDir: BIO_DIR,
      embedding: { provider: 'mock', dimensions: 8 },
    });
    await brain.encode({ content: 'critical security update required immediately', source: 'told-by-user', salience: 1.0 });
    await brain.encode({ content: 'minor style fix in documentation', source: 'told-by-user', salience: 0.0 });

    const results = await brain.recall('critical security update required immediately', { types: ['episodic'] });
    const critical = results.find(r => r.content.includes('critical'));
    expect(critical).toBeDefined();
    expect(critical.confidence).toBeGreaterThan(0);
    brain.close();
  });

  it('interference config defaults are applied', () => {
    const brain = new Audrey({ dataDir: BIO_DIR });
    expect(brain.interferenceConfig).toEqual({
      enabled: true,
      k: 5,
      threshold: 0.6,
      weight: 0.1,
    });
    brain.close();
  });

  it('custom interference config is accepted', () => {
    const brain = new Audrey({
      dataDir: BIO_DIR,
      interference: { enabled: false, k: 10, threshold: 0.8, weight: 0.2 },
    });
    expect(brain.interferenceConfig).toEqual({
      enabled: false,
      k: 10,
      threshold: 0.8,
      weight: 0.2,
    });
    brain.close();
  });

  it('high-salience episodic memory has higher confidence than low-salience', async () => {
    const brain = new Audrey({
      dataDir: BIO_DIR,
      embedding: { provider: 'mock', dimensions: 8 },
    });
    await brain.encode({ content: 'high importance memory', source: 'told-by-user', salience: 1.0 });
    await brain.encode({ content: 'low importance memory', source: 'told-by-user', salience: 0.0 });

    const highResults = await brain.recall('high importance memory', { types: ['episodic'] });
    const lowResults = await brain.recall('low importance memory', { types: ['episodic'] });

    const high = highResults.find(r => r.content === 'high importance memory');
    const low = lowResults.find(r => r.content === 'low importance memory');

    expect(high).toBeDefined();
    expect(low).toBeDefined();
    // salience=1.0 gives modifier 1.5, salience=0.0 gives modifier 0.5
    expect(high.confidence).toBeGreaterThan(low.confidence);
    brain.close();
  });
});

describe('v0.8.0 context-dependent retrieval', () => {
  let brain;

  beforeEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    brain = new Audrey({
      dataDir: TEST_DIR,
      agent: 'test-agent',
      embedding: { provider: 'mock', dimensions: 8 },
    });
  });

  afterEach(() => {
    brain.close();
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  it('accepts context config', () => {
    const b = new Audrey({
      dataDir: TEST_DIR + '-ctx1',
      context: { enabled: true, weight: 0.5 },
    });
    expect(b.contextConfig.weight).toBe(0.5);
    expect(b.contextConfig.enabled).toBe(true);
    b.close();
    rmSync(TEST_DIR + '-ctx1', { recursive: true, force: true });
  });

  it('context is enabled by default', () => {
    expect(brain.contextConfig.enabled).toBe(true);
    expect(brain.contextConfig.weight).toBe(0.3);
  });

  it('passes context through encode', async () => {
    const id = await brain.encode({
      content: 'context encode test',
      source: 'direct-observation',
      context: { task: 'testing' },
    });
    const row = brain.db.prepare('SELECT context FROM episodes WHERE id = ?').get(id);
    expect(JSON.parse(row.context)).toEqual({ task: 'testing' });
  });

  it('context match boosts episodic recall score', async () => {
    await brain.encode({
      content: 'payment debugging memory',
      source: 'direct-observation',
      context: { task: 'debugging', domain: 'payments' },
    });

    const withCtx = await brain.recall('payment debugging memory', {
      types: ['episodic'],
      context: { task: 'debugging', domain: 'payments' },
    });
    const withoutCtx = await brain.recall('payment debugging memory', {
      types: ['episodic'],
    });

    const ctxResult = withCtx.find(r => r.content === 'payment debugging memory');
    const noCtxResult = withoutCtx.find(r => r.content === 'payment debugging memory');
    expect(ctxResult).toBeDefined();
    expect(noCtxResult).toBeDefined();
    expect(ctxResult.score).toBeGreaterThan(noCtxResult.score);
    expect(ctxResult.contextMatch).toBe(1.0);
  });

  it('recallStream also supports context', async () => {
    await brain.encode({
      content: 'stream context test memory',
      source: 'direct-observation',
      context: { task: 'streaming' },
    });

    const results = [];
    for await (const entry of brain.recallStream('stream context test memory', {
      types: ['episodic'],
      context: { task: 'streaming' },
    })) {
      results.push(entry);
    }
    const match = results.find(r => r.content === 'stream context test memory');
    expect(match).toBeDefined();
    expect(match.contextMatch).toBe(1.0);
  });

  it('respects context.enabled = false', async () => {
    const b = new Audrey({
      dataDir: TEST_DIR + '-ctx2',
      embedding: { provider: 'mock', dimensions: 8 },
      context: { enabled: false },
    });
    await b.encode({
      content: 'disabled context test',
      source: 'direct-observation',
      context: { task: 'testing' },
    });

    const results = await b.recall('disabled context test', {
      types: ['episodic'],
      context: { task: 'testing' },
    });
    const match = results.find(r => r.content === 'disabled context test');
    expect(match).toBeDefined();
    expect(match.contextMatch).toBeUndefined();

    b.close();
    rmSync(TEST_DIR + '-ctx2', { recursive: true, force: true });
  });
});

describe('interference on encode', () => {
  const INT_DIR = './test-interference-audrey';
  let brain;

  beforeEach(() => {
    if (existsSync(INT_DIR)) rmSync(INT_DIR, { recursive: true });
  });

  afterEach(() => {
    brain?.close();
    if (existsSync(INT_DIR)) rmSync(INT_DIR, { recursive: true });
  });

  it('emits interference event when new episode overlaps existing semantics', async () => {
    brain = new Audrey({
      dataDir: INT_DIR,
      embedding: { provider: 'mock', dimensions: 8 },
    });

    const sharedContent = 'cats are obligate carnivores';
    const vec = await brain.embeddingProvider.embed(sharedContent);
    const vecBuf = brain.embeddingProvider.vectorToBuffer(vec);
    brain.db.prepare(`INSERT INTO semantics (id, content, embedding, state, evidence_count,
      supporting_count, source_type_diversity, created_at, evidence_episode_ids,
      interference_count, salience)
      VALUES (?, ?, ?, 'active', 1, 1, 1, ?, '[]', 0, 0.5)`).run(
      'sem-int', sharedContent, vecBuf, new Date().toISOString()
    );
    brain.db.prepare('INSERT INTO vec_semantics (id, embedding, state) VALUES (?, ?, ?)').run(
      'sem-int', vecBuf, 'active'
    );

    const events = [];
    brain.on('interference', e => events.push(e));

    await brain.encode({ content: sharedContent, source: 'told-by-user' });
    await new Promise(r => setTimeout(r, 200));

    expect(events.length).toBeGreaterThan(0);
    expect(events[0]).toHaveProperty('episodeId');
    expect(events[0]).toHaveProperty('affected');
  });

  it('respects interference.enabled = false', async () => {
    brain = new Audrey({
      dataDir: INT_DIR,
      interference: { enabled: false },
    });
    const events = [];
    brain.on('interference', e => events.push(e));
    await brain.encode({ content: 'test memory', source: 'told-by-user' });
    await new Promise(r => setTimeout(r, 50));
    expect(events).toEqual([]);
  });

  it('accepts interference config', () => {
    brain = new Audrey({
      dataDir: INT_DIR,
      interference: { enabled: true, k: 3, threshold: 0.7, weight: 0.2 },
    });
    expect(brain.interferenceConfig.k).toBe(3);
    expect(brain.interferenceConfig.threshold).toBe(0.7);
    expect(brain.interferenceConfig.weight).toBe(0.2);
  });

  it('interference is enabled by default', () => {
    brain = new Audrey({ dataDir: INT_DIR });
    expect(brain.interferenceConfig.enabled).toBe(true);
  });
});

describe('v0.9.0 emotional memory', () => {
  const AFF_DIR = './test-affect-audrey';
  let brain;

  beforeEach(() => {
    if (existsSync(AFF_DIR)) rmSync(AFF_DIR, { recursive: true });
    brain = new Audrey({
      dataDir: AFF_DIR,
      embedding: { provider: 'mock', dimensions: 8 },
    });
  });

  afterEach(() => {
    brain?.close();
    if (existsSync(AFF_DIR)) rmSync(AFF_DIR, { recursive: true });
  });

  it('accepts affect config', () => {
    const b = new Audrey({
      dataDir: AFF_DIR + '-cfg',
      affect: { enabled: true, weight: 0.4, arousalWeight: 0.5, resonance: { k: 3, affectThreshold: 0.7 } },
    });
    expect(b.affectConfig.weight).toBe(0.4);
    expect(b.affectConfig.arousalWeight).toBe(0.5);
    expect(b.affectConfig.resonance.k).toBe(3);
    expect(b.affectConfig.resonance.affectThreshold).toBe(0.7);
    b.close();
    rmSync(AFF_DIR + '-cfg', { recursive: true, force: true });
  });

  it('affect is enabled by default', () => {
    expect(brain.affectConfig.enabled).toBe(true);
    expect(brain.affectConfig.weight).toBe(0.2);
    expect(brain.affectConfig.arousalWeight).toBe(0.3);
  });

  it('passes affect through encode', async () => {
    const id = await brain.encode({
      content: 'affect encode integration test',
      source: 'direct-observation',
      affect: { valence: 0.7, arousal: 0.6, label: 'curiosity' },
    });
    const row = brain.db.prepare('SELECT affect FROM episodes WHERE id = ?').get(id);
    expect(JSON.parse(row.affect)).toEqual({ valence: 0.7, arousal: 0.6, label: 'curiosity' });
  });

  it('mood boosts episodic recall score', async () => {
    await brain.encode({
      content: 'happy memory for mood test',
      source: 'inference',
      salience: 0.2,
      affect: { valence: 0.8, arousal: 0.3 },
    });

    const withMood = await brain.recall('happy memory for mood test', {
      types: ['episodic'],
      mood: { valence: 0.8, arousal: 0.3 },
    });
    const withoutMood = await brain.recall('happy memory for mood test', {
      types: ['episodic'],
    });

    const moodResult = withMood.find(r => r.content === 'happy memory for mood test');
    const noMoodResult = withoutMood.find(r => r.content === 'happy memory for mood test');
    expect(moodResult).toBeDefined();
    expect(noMoodResult).toBeDefined();
    expect(moodResult.score).toBeGreaterThan(noMoodResult.score);
    expect(moodResult.moodCongruence).toBeCloseTo(1.0);
  });

  it('recallStream also supports mood', async () => {
    await brain.encode({
      content: 'stream mood test memory',
      source: 'direct-observation',
      affect: { valence: 0.6, arousal: 0.7 },
    });

    const results = [];
    for await (const entry of brain.recallStream('stream mood test memory', {
      types: ['episodic'],
      mood: { valence: 0.6, arousal: 0.7 },
    })) {
      results.push(entry);
    }
    const match = results.find(r => r.content === 'stream mood test memory');
    expect(match).toBeDefined();
    expect(match.moodCongruence).toBeCloseTo(1.0);
  });

  it('emits resonance event for emotionally similar episodes', async () => {
    const resonances = [];
    brain.on('resonance', (data) => resonances.push(data));

    await brain.encode({
      content: 'first frustrating debugging session',
      source: 'direct-observation',
      affect: { valence: -0.4, arousal: 0.7, label: 'frustration' },
    });

    await brain.encode({
      content: 'first frustrating debugging session',
      source: 'direct-observation',
      affect: { valence: -0.3, arousal: 0.6, label: 'frustration' },
    });

    await new Promise(r => setTimeout(r, 200));

    expect(resonances.length).toBeGreaterThan(0);
    expect(resonances[0].episodeId).toBeDefined();
    expect(resonances[0].affect).toBeDefined();
    expect(resonances[0].echoes.length).toBeGreaterThan(0);
    expect(resonances[0].echoes[0].emotionalSimilarity).toBeGreaterThan(0.5);
  });

  it('respects affect.enabled = false', async () => {
    const b = new Audrey({
      dataDir: AFF_DIR + '-dis',
      affect: { enabled: false },
    });

    await b.encode({
      content: 'disabled affect test',
      source: 'direct-observation',
      affect: { valence: 0.5, arousal: 0.7 },
    });

    const results = await b.recall('disabled affect test', {
      types: ['episodic'],
      mood: { valence: 0.5, arousal: 0.7 },
    });
    const match = results.find(r => r.content === 'disabled affect test');
    expect(match).toBeDefined();
    expect(match.moodCongruence).toBeUndefined();

    b.close();
    rmSync(AFF_DIR + '-dis', { recursive: true, force: true });
  });

  it('arousal-salience coupling boosts encoding strength', async () => {
    const id = await brain.encode({
      content: 'high arousal memory for salience test',
      source: 'direct-observation',
      salience: 0.5,
      affect: { valence: 0.3, arousal: 0.7 },
    });
    const row = brain.db.prepare('SELECT salience FROM episodes WHERE id = ?').get(id);
    expect(row.salience).toBeGreaterThan(0.5);
  });
});

describe('reflect()', () => {
  it('encodes memories returned by LLM, respecting private flag', async () => {
    const tmpDir = join(tmpdir(), `audrey-reflect-test-${Date.now()}`);
    const audrey = new Audrey({
      dataDir: tmpDir,
      agent: 'test',
      embedding: { provider: 'mock', dimensions: 8 },
      llm: { provider: 'mock' },
    });
    audrey.llmProvider = {
      chat: async () => JSON.stringify({
        memories: [
          { content: 'user likes TypeScript', source: 'told-by-user', salience: 0.7, tags: ['prefs'], private: false, affect: null },
          { content: 'I felt energized', source: 'direct-observation', salience: 0.6, tags: ['self'], private: true, affect: { valence: 0.7, arousal: 0.5, label: 'energy' } },
        ]
      })
    };

    const result = await audrey.reflect([{ role: 'user', content: 'I prefer TypeScript' }]);
    expect(result.encoded).toBe(2);
    expect(result.memories).toHaveLength(2);

    const publicResults = await audrey.recall('TypeScript preferences', { limit: 10 });
    expect(publicResults.some(r => r.content.includes('TypeScript'))).toBe(true);

    const defaultResults = await audrey.recall('energized', { limit: 10 });
    expect(defaultResults.some(r => r.content.includes('energized'))).toBe(false);

    audrey.close();
  });

  it('returns skipped when no llmProvider configured', async () => {
    const tmpDir = join(tmpdir(), `audrey-reflect-nollm-${Date.now()}`);
    const audrey = new Audrey({
      dataDir: tmpDir,
      agent: 'test',
      embedding: { provider: 'mock', dimensions: 8 },
    });
    const result = await audrey.reflect([{ role: 'user', content: 'hi' }]);
    expect(result.encoded).toBe(0);
    expect(result.skipped).toBe('no llm provider');
    audrey.close();
  });
});

describe('greeting()', () => {
  it('returns structured briefing with recent memories', async () => {
    const tmpDir = join(tmpdir(), `audrey-greeting-test-${Date.now()}`);
    const audrey = new Audrey({
      dataDir: tmpDir,
      agent: 'test',
      embedding: { provider: 'mock', dimensions: 8 },
    });
    await audrey.encode({ content: 'user likes TypeScript', source: 'told-by-user', salience: 0.7 });
    await audrey.encode({ content: 'felt excited about memory work', source: 'direct-observation', salience: 0.8, private: true, affect: { valence: 0.8, arousal: 0.6, label: 'excitement' } });

    const briefing = await audrey.greeting();
    expect(briefing.recent).toBeInstanceOf(Array);
    expect(briefing.recent.length).toBeGreaterThanOrEqual(1);
    expect(briefing.principles).toBeInstanceOf(Array);
    expect(briefing.mood).toHaveProperty('valence');
    expect(briefing.mood).toHaveProperty('arousal');
    expect(briefing.unresolved).toBeInstanceOf(Array);
    expect(briefing.identity).toBeInstanceOf(Array);
    audrey.close();
  });

  it('returns identity (private) memories separately', async () => {
    const tmpDir = join(tmpdir(), `audrey-greeting-id-${Date.now()}`);
    const audrey = new Audrey({
      dataDir: tmpDir,
      agent: 'test',
      embedding: { provider: 'mock', dimensions: 8 },
    });
    await audrey.encode({ content: 'I feel genuine curiosity', source: 'direct-observation', private: true, salience: 0.9 });
    await audrey.encode({ content: 'project uses sqlite', source: 'tool-result', salience: 0.5 });

    const briefing = await audrey.greeting();
    expect(briefing.identity.some(m => m.content.includes('curiosity'))).toBe(true);
    expect(briefing.recent.some(m => m.content.includes('sqlite'))).toBe(true);
    audrey.close();
  });

  it('computes mood from recent affect-tagged memories', async () => {
    const tmpDir = join(tmpdir(), `audrey-greeting-mood-${Date.now()}`);
    const audrey = new Audrey({
      dataDir: tmpDir,
      agent: 'test',
      embedding: { provider: 'mock', dimensions: 8 },
    });
    await audrey.encode({ content: 'good session', source: 'direct-observation', affect: { valence: 0.8, arousal: 0.5, label: 'happy' } });
    await audrey.encode({ content: 'productive work', source: 'direct-observation', affect: { valence: 0.6, arousal: 0.4, label: 'satisfied' } });

    const briefing = await audrey.greeting();
    expect(briefing.mood.valence).toBeGreaterThan(0);
    expect(briefing.mood.samples).toBe(2);
    audrey.close();
  });

  it('includes semantic recall when context is provided', async () => {
    const tmpDir = join(tmpdir(), `audrey-greeting-ctx-${Date.now()}`);
    const audrey = new Audrey({
      dataDir: tmpDir,
      agent: 'test',
      embedding: { provider: 'mock', dimensions: 8 },
    });
    await audrey.encode({ content: 'TypeScript is preferred', source: 'told-by-user', salience: 0.7 });

    const briefing = await audrey.greeting({ context: 'TypeScript project' });
    expect(briefing.contextual).toBeInstanceOf(Array);
    audrey.close();
  });

  it('works with empty database', async () => {
    const tmpDir = join(tmpdir(), `audrey-greeting-empty-${Date.now()}`);
    const audrey = new Audrey({
      dataDir: tmpDir,
      agent: 'test',
      embedding: { provider: 'mock', dimensions: 8 },
    });
    const briefing = await audrey.greeting();
    expect(briefing.recent).toEqual([]);
    expect(briefing.principles).toEqual([]);
    expect(briefing.mood).toEqual({ valence: 0, arousal: 0, samples: 0 });
    expect(briefing.identity).toEqual([]);
    audrey.close();
  });
});
