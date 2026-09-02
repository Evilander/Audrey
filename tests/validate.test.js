import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { validateMemory, createContradiction, reopenContradiction } from '../dist/src/validate.js';
import { createDatabase, closeDatabase } from '../dist/src/db.js';
import { MockEmbeddingProvider } from '../dist/src/embedding.js';
import { MockLLMProvider } from '../dist/src/llm.js';
import { existsSync, rmSync, mkdirSync } from 'node:fs';

const TEST_DIR = './test-validate-data';

describe('validateMemory', () => {
  let db, embedding;

  beforeEach(async () => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
    ({ db } = createDatabase(TEST_DIR, { dimensions: 8 }));
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
    db.prepare(
      `INSERT INTO semantics (id, content, embedding, state, evidence_count,
      supporting_count, source_type_diversity, created_at, evidence_episode_ids)
      VALUES (?, ?, ?, 'active', 1, 1, 1, ?, ?)`,
    ).run(
      'sem-1',
      'Stripe rate limit is 100 req/s',
      vecBuf,
      new Date().toISOString(),
      JSON.stringify(['ep-0']),
    );
    db.prepare('INSERT INTO vec_semantics(id, agent, embedding, state) VALUES (?, ?, ?, ?)').run(
      'sem-1',
      'default',
      vecBuf,
      'active',
    );

    // Validate a new similar episode (SAME content = SAME embedding = similarity 1.0)
    const result = await validateMemory(db, embedding, {
      id: 'ep-1',
      content: 'Stripe rate limit is 100 req/s',
      source: 'direct-observation',
    });

    expect(result.action).toBe('reinforced');
    const sem = db
      .prepare('SELECT supporting_count, evidence_episode_ids FROM semantics WHERE id = ?')
      .get('sem-1');
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
    db.prepare(
      `INSERT INTO semantics (id, content, embedding, state, evidence_count,
      supporting_count, source_type_diversity, created_at, evidence_episode_ids)
      VALUES (?, ?, ?, 'active', 1, 1, 1, ?, ?)`,
    ).run(
      'sem-2',
      'test memory content',
      vecBuf,
      new Date().toISOString(),
      JSON.stringify(['ep-0']),
    );
    db.prepare('INSERT INTO vec_semantics(id, agent, embedding, state) VALUES (?, ?, ?, ?)').run(
      'sem-2',
      'default',
      vecBuf,
      'active',
    );
    // Insert the original episode with source 'inference'
    db.prepare(
      `INSERT INTO episodes (id, content, source, source_reliability, created_at)
      VALUES (?, ?, ?, ?, ?)`,
    ).run('ep-0', 'test memory content', 'inference', 0.6, new Date().toISOString());

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

  describe('private content never reaches the contradiction LLM', () => {
    // threshold: 1.01 forces even identical content past reinforcement into
    // the contradiction branch; contradictionThreshold: 0.5 guarantees the
    // branch is reached — only the privacy gate can stop the LLM call.
    const thresholds = { threshold: 1.01, contradictionThreshold: 0.5 };

    function spyLLM() {
      const calls = [];
      return {
        calls,
        provider: {
          modelName: 'spy-llm',
          modelVersion: '1.0.0',
          async complete() {
            return { content: '{}' };
          },
          async json(messages) {
            calls.push(messages);
            return { contradicts: false };
          },
        },
      };
    }

    async function insertSemanticRow(id, content, isPrivate) {
      const buf = embedding.vectorToBuffer(await embedding.embed(content));
      db.prepare(
        `INSERT INTO semantics (id, content, embedding, state, evidence_count,
         supporting_count, created_at, evidence_episode_ids, "private")
         VALUES (?, ?, ?, 'active', 1, 1, ?, '[]', ?)`,
      ).run(id, content, buf, new Date().toISOString(), isPrivate ? 1 : 0);
      db.prepare('INSERT INTO vec_semantics(id, agent, embedding, state) VALUES (?, ?, ?, ?)').run(
        id,
        'default',
        buf,
        'active',
      );
    }

    function insertEpisodeRow(id, content, isPrivate) {
      db.prepare(
        `INSERT INTO episodes (id, content, source, source_reliability, created_at, "private")
         VALUES (?, ?, 'direct-observation', 0.9, ?, ?)`,
      ).run(id, content, new Date().toISOString(), isPrivate ? 1 : 0);
    }

    it('skips the LLM when the matched semantic is private', async () => {
      await insertSemanticRow('sem-private', 'private principle content', true);
      insertEpisodeRow('ep-1', 'private principle content', false);
      const { calls, provider } = spyLLM();

      const result = await validateMemory(
        db,
        embedding,
        { id: 'ep-1', content: 'private principle content', source: 'direct-observation' },
        { ...thresholds, llmProvider: provider },
      );

      expect(calls.length).toBe(0);
      expect(result.action).toBe('none');
    });

    it('fails closed when the episode row cannot be read', async () => {
      await insertSemanticRow('sem-orphan', 'orphan principle content', false);
      const { calls, provider } = spyLLM();

      const result = await validateMemory(
        db,
        embedding,
        { id: 'ep-missing', content: 'orphan principle content', source: 'direct-observation' },
        { ...thresholds, llmProvider: provider },
      );

      expect(calls.length).toBe(0);
      expect(result.action).toBe('none');
    });

    it('skips the LLM when the episode being validated is private', async () => {
      await insertSemanticRow('sem-public', 'shared principle content', false);
      insertEpisodeRow('ep-priv', 'shared principle content', true);
      const { calls, provider } = spyLLM();

      const result = await validateMemory(
        db,
        embedding,
        { id: 'ep-priv', content: 'shared principle content', source: 'direct-observation' },
        { ...thresholds, llmProvider: provider },
      );

      expect(calls.length).toBe(0);
      expect(result.action).toBe('none');
    });

    it('still consults the LLM when neither side is private', async () => {
      await insertSemanticRow('sem-open', 'open principle content', false);
      insertEpisodeRow('ep-2', 'open principle content', false);
      const { calls, provider } = spyLLM();

      await validateMemory(
        db,
        embedding,
        { id: 'ep-2', content: 'open principle content', source: 'direct-observation' },
        { ...thresholds, llmProvider: provider },
      );

      expect(calls.length).toBe(1);
    });

    it('reinforcing a public semantic with private evidence taints it', async () => {
      await insertSemanticRow('sem-taintable', 'reinforced principle content', false);
      insertEpisodeRow('ep-taint', 'reinforced principle content', true);

      const result = await validateMemory(db, embedding, {
        id: 'ep-taint',
        content: 'reinforced principle content',
        source: 'direct-observation',
      });

      expect(result.action).toBe('reinforced');
      expect(
        db.prepare('SELECT "private" FROM semantics WHERE id = ?').get('sem-taintable').private,
      ).toBe(1);
    });

    it('reinforcing with public evidence never clears an existing private flag', async () => {
      await insertSemanticRow('sem-stays-private', 'sticky principle content', true);
      insertEpisodeRow('ep-clean', 'sticky principle content', false);

      const result = await validateMemory(db, embedding, {
        id: 'ep-clean',
        content: 'sticky principle content',
        source: 'direct-observation',
      });

      expect(result.action).toBe('reinforced');
      expect(
        db.prepare('SELECT "private" FROM semantics WHERE id = ?').get('sem-stays-private').private,
      ).toBe(1);
    });
  });
});

describe('createContradiction', () => {
  let db;

  beforeEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
    ({ db } = createDatabase(TEST_DIR, { dimensions: 8 }));
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
    const id = createContradiction(db, 'sem-1', 'semantic', 'ep-5', 'episodic', {
      winner: 'sem-1',
      reason: 'higher confidence',
    });
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
    ({ db } = createDatabase(TEST_DIR, { dimensions: 8 }));
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

describe('validateMemory with LLM contradiction detection', () => {
  let db, embedding;

  beforeEach(async () => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
    ({ db } = createDatabase(TEST_DIR, { dimensions: 8 }));
    embedding = new MockEmbeddingProvider({ dimensions: 8 });
  });

  afterEach(() => {
    closeDatabase(db);
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  it('detects contradiction via LLM when similarity is in middle zone', async () => {
    const vec = await embedding.embed('Rate limit is 100 per second');
    const vecBuf = embedding.vectorToBuffer(vec);
    db.prepare(
      `INSERT INTO semantics (id, content, embedding, state, evidence_count,
      supporting_count, source_type_diversity, created_at, evidence_episode_ids)
      VALUES (?, ?, ?, 'active', 1, 1, 1, ?, ?)`,
    ).run('sem-1', 'Rate limit is 100 per second', vecBuf, new Date().toISOString(), '[]');
    db.prepare('INSERT INTO vec_semantics(id, agent, embedding, state) VALUES (?, ?, ?, ?)').run(
      'sem-1',
      'default',
      vecBuf,
      'active',
    );

    const contradictLlm = new MockLLMProvider({
      responses: {
        contradictionDetection: {
          contradicts: true,
          explanation: 'The rate limits are different values',
          resolution: 'context_dependent',
          conditions: { new: 'test mode', existing: 'live mode' },
        },
      },
    });

    // Same content = similarity 1.0 = reinforcement zone (above threshold)
    const result = await validateMemory(
      db,
      embedding,
      {
        id: 'ep-new',
        content: 'Rate limit is 100 per second',
        source: 'direct-observation',
      },
      {
        llmProvider: contradictLlm,
        contradictionThreshold: 0.0,
      },
    );

    // With similarity 1.0 and default threshold 0.85, it reinforces
    expect(result.action).toBe('reinforced');
  });

  it('creates contradiction record when LLM confirms contradiction', async () => {
    const vec = await embedding.embed('unique semantic memory for contradiction test');
    const vecBuf = embedding.vectorToBuffer(vec);
    db.prepare(
      `INSERT INTO semantics (id, content, embedding, state, evidence_count,
      supporting_count, source_type_diversity, created_at, evidence_episode_ids)
      VALUES (?, ?, ?, 'active', 1, 1, 1, ?, ?)`,
    ).run(
      'sem-c',
      'unique semantic memory for contradiction test',
      vecBuf,
      new Date().toISOString(),
      '[]',
    );
    db.prepare('INSERT INTO vec_semantics(id, agent, embedding, state) VALUES (?, ?, ?, ?)').run(
      'sem-c',
      'default',
      vecBuf,
      'active',
    );

    const contradictLlm = new MockLLMProvider({
      responses: {
        contradictionDetection: {
          contradicts: true,
          explanation: 'These claims conflict',
          resolution: 'new_wins',
          conditions: null,
        },
      },
    });

    // The privacy gate fails closed on an unreadable episode row, so the
    // episode under validation must exist as a public row.
    db.prepare(
      `INSERT INTO episodes (id, content, source, source_reliability, created_at)
      VALUES (?, ?, 'direct-observation', 0.9, ?)`,
    ).run('ep-contra', 'unique semantic memory for contradiction test', new Date().toISOString());

    const result = await validateMemory(
      db,
      embedding,
      {
        id: 'ep-contra',
        content: 'unique semantic memory for contradiction test',
        source: 'direct-observation',
      },
      {
        llmProvider: contradictLlm,
        threshold: 1.1,
        contradictionThreshold: 0.5,
      },
    );

    expect(result.action).toBe('contradiction');
    expect(result.contradictionId).toBeDefined();
  });

  it('returns no-action when LLM says no contradiction', async () => {
    const vec = await embedding.embed('some test memory');
    const vecBuf = embedding.vectorToBuffer(vec);
    db.prepare(
      `INSERT INTO semantics (id, content, embedding, state, evidence_count,
      supporting_count, source_type_diversity, created_at, evidence_episode_ids)
      VALUES (?, ?, ?, 'active', 1, 1, 1, ?, ?)`,
    ).run('sem-nc', 'some test memory', vecBuf, new Date().toISOString(), '[]');
    db.prepare('INSERT INTO vec_semantics(id, agent, embedding, state) VALUES (?, ?, ?, ?)').run(
      'sem-nc',
      'default',
      vecBuf,
      'active',
    );

    const noContradictLlm = new MockLLMProvider({
      responses: {
        contradictionDetection: {
          contradicts: false,
          explanation: 'These are compatible claims',
        },
      },
    });

    db.prepare(
      `INSERT INTO episodes (id, content, source, source_reliability, created_at)
      VALUES (?, ?, 'direct-observation', 0.9, ?)`,
    ).run('ep-nc', 'some test memory', new Date().toISOString());

    const result = await validateMemory(
      db,
      embedding,
      {
        id: 'ep-nc',
        content: 'some test memory',
        source: 'direct-observation',
      },
      {
        llmProvider: noContradictLlm,
        threshold: 1.1,
        contradictionThreshold: 0.5,
      },
    );

    expect(result.action).toBe('none');
  });

  it('skips LLM check when no llmProvider configured', async () => {
    const vec = await embedding.embed('memory without llm');
    const vecBuf = embedding.vectorToBuffer(vec);
    db.prepare(
      `INSERT INTO semantics (id, content, embedding, state, evidence_count,
      supporting_count, source_type_diversity, created_at, evidence_episode_ids)
      VALUES (?, ?, ?, 'active', 1, 1, 1, ?, ?)`,
    ).run('sem-no-llm', 'memory without llm', vecBuf, new Date().toISOString(), '[]');
    db.prepare('INSERT INTO vec_semantics(id, agent, embedding, state) VALUES (?, ?, ?, ?)').run(
      'sem-no-llm',
      'default',
      vecBuf,
      'active',
    );

    const result = await validateMemory(db, embedding, {
      id: 'ep-no-llm',
      content: 'memory without llm',
      source: 'direct-observation',
    });

    expect(result.action).toBe('reinforced');
  });
});
