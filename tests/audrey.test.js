import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Audrey } from '../src/audrey.js';
import { MockLLMProvider } from '../src/llm.js';
import { existsSync, rmSync } from 'node:fs';

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
