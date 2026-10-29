import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { rollbackConsolidation, getConsolidationHistory } from '../dist/src/rollback.js';
import { encodeEpisode } from '../dist/src/encode.js';
import { runConsolidation } from '../dist/src/consolidate.js';
import { createDatabase, closeDatabase } from '../dist/src/db.js';
import { MockEmbeddingProvider } from '../dist/src/embedding.js';
import { existsSync, rmSync, mkdirSync } from 'node:fs';

const TEST_DIR = './test-rollback-data';

describe('rollback', () => {
  let db, embedding;
  beforeEach(async () => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
    ({ db } = createDatabase(TEST_DIR, { dimensions: 8 }));
    embedding = new MockEmbeddingProvider({ dimensions: 8 });
  });
  afterEach(() => {
    vi.useRealTimers();
    closeDatabase(db);
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  it('returns consolidation history', async () => {
    await runConsolidation(db, embedding, { minClusterSize: 3 });
    const history = getConsolidationHistory(db);
    expect(Array.isArray(history)).toBe(true);
    expect(history.length).toBe(1);
    expect(history[0]).toHaveProperty('id');
    expect(history[0]).toHaveProperty('status');
  });

  it('rolls back a consolidation run', async () => {
    await encodeEpisode(db, embedding, { content: 'same event', source: 'direct-observation' });
    await encodeEpisode(db, embedding, { content: 'same event', source: 'tool-result' });
    await encodeEpisode(db, embedding, { content: 'same event', source: 'told-by-user' });

    const result = await runConsolidation(db, embedding, {
      minClusterSize: 3,
      similarityThreshold: 0.99,
      extractPrinciple: () => ({ content: 'Test principle', type: 'semantic' }),
    });

    rollbackConsolidation(db, result.runId);

    // Semantic memories rolled back
    const active = db
      .prepare("SELECT COUNT(*) as count FROM semantics WHERE state = 'active'")
      .get();
    expect(active.count).toBe(0);
    const rolledBack = db
      .prepare("SELECT COUNT(*) as count FROM semantics WHERE state = 'rolled_back'")
      .get();
    expect(rolledBack.count).toBe(1);

    // Episodes un-consolidated
    const unconsolidated = db
      .prepare('SELECT COUNT(*) as count FROM episodes WHERE consolidated = 0')
      .get();
    expect(unconsolidated.count).toBe(3);

    // Run marked as rolled_back
    const run = db.prepare('SELECT status FROM consolidation_runs WHERE id = ?').get(result.runId);
    expect(run.status).toBe('rolled_back');
  });

  it('throws for non-existent run ID', () => {
    expect(() => rollbackConsolidation(db, 'nonexistent')).toThrow();
  });

  it('rejects rollback while extraction is running, then permits rollback after completion', async () => {
    for (const source of ['direct-observation', 'tool-result', 'told-by-user']) {
      await encodeEpisode(db, embedding, { content: 'pending event', source });
    }
    let release, entered;
    const gate = new Promise(resolve => {
      release = resolve;
    });
    const started = new Promise(resolve => {
      entered = resolve;
    });
    const pending = runConsolidation(db, embedding, {
      minClusterSize: 3,
      similarityThreshold: 0.99,
      extractPrinciple: async () => {
        entered();
        await gate;
        return { content: 'Pending principle', type: 'semantic' };
      },
    });
    await started;
    const running = getConsolidationHistory(db)[0];
    try {
      expect(running.status).toBe('running');
      expect(() => rollbackConsolidation(db, running.id)).toThrow(/status running/);
      expect(
        db.prepare('SELECT status FROM consolidation_runs WHERE id = ?').get(running.id).status,
      ).toBe('running');
    } finally {
      release();
      await pending;
    }
    const result = await pending;
    expect(result.runId).toBe(running.id);
    expect(rollbackConsolidation(db, result.runId)).toEqual({
      rolledBackMemories: 1,
      restoredEpisodes: 3,
    });
    expect(
      db.prepare("SELECT COUNT(*) AS count FROM semantics WHERE state = 'active'").get().count,
    ).toBe(0);
  });

  it('rejects rollback of failed consolidation runs', async () => {
    db.prepare(
      "INSERT INTO consolidation_runs (id, status, input_episode_ids, output_memory_ids) VALUES ('failed-run', 'failed', '[]', '[]')",
    ).run();
    expect(() => rollbackConsolidation(db, 'failed-run')).toThrow(/status failed/);
    expect(
      db.prepare('SELECT status FROM consolidation_runs WHERE id = ?').get('failed-run').status,
    ).toBe('failed');
  });

  it.each(['semantic', 'procedural'])(
    'requires reverse commit order for overlapping %s merges even when timestamps match',
    async type => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
      const runs = [];
      for (let batch = 0; batch < 3; batch++) {
        for (const source of ['direct-observation', 'tool-result', 'told-by-user']) {
          await encodeEpisode(db, embedding, { content: `batch ${batch}`, source });
        }
        runs.push(
          await runConsolidation(db, embedding, {
            minClusterSize: 3,
            similarityThreshold: 0.99,
            extractPrinciple: () => ({ content: 'Shared principle', type }),
          }),
        );
      }
      const table = type === 'semantic' ? 'semantics' : 'procedures';
      const before = db.prepare(`SELECT * FROM ${table}`).get();
      expect(JSON.parse(before.evidence_episode_ids)).toHaveLength(9);
      const journals = runs.map(run =>
        JSON.parse(
          db.prepare('SELECT rollback_data FROM consolidation_runs WHERE id = ?').get(run.runId)
            .rollback_data,
        ),
      );
      expect(journals.map(journal => journal.commitSequence)).toEqual([1, 2, 3]);

      expect(() => rollbackConsolidation(db, runs[1].runId)).toThrow(/dependent consolidation/);
      expect(db.prepare(`SELECT * FROM ${table}`).get()).toEqual(before);
      expect(
        db.prepare('SELECT COUNT(*) AS count FROM episodes WHERE consolidated = 0').get().count,
      ).toBe(0);
      rollbackConsolidation(db, runs[2].runId);
      rollbackConsolidation(db, runs[1].runId);

      const restored = db.prepare(`SELECT * FROM ${table}`).get();
      expect(JSON.parse(restored.evidence_episode_ids)).toHaveLength(3);
      expect(restored.last_reinforced_at).toBeNull();
      if (type === 'semantic') {
        expect(restored.supporting_count).toBe(3);
        expect(restored.evidence_count).toBe(3);
      } else {
        expect(restored.success_count).toBe(0);
      }
    },
  );

  it.each(['semantic', 'procedural'])(
    'orders mixed-version %s merges by completion time',
    async type => {
      vi.useFakeTimers({ toFake: ['Date'] });
      const runs = [];
      for (let batch = 0; batch < 3; batch++) {
        vi.setSystemTime(new Date(Date.UTC(2026, 0, 1, 0, 0, batch)));
        for (const source of ['direct-observation', 'tool-result', 'told-by-user']) {
          await encodeEpisode(db, embedding, { content: `batch ${batch}`, source });
        }
        runs.push(
          await runConsolidation(db, embedding, {
            minClusterSize: 3,
            similarityThreshold: 0.99,
            extractPrinciple: () => ({ content: 'Shared principle', type }),
          }),
        );
      }
      // An already-running older client writes the same undo journal without
      // the new sequence field, even after newer clients have committed.
      const lastRun = runs[2].runId;
      const journal = JSON.parse(
        db.prepare('SELECT rollback_data FROM consolidation_runs WHERE id = ?').get(lastRun)
          .rollback_data,
      );
      delete journal.commitSequence;
      db.prepare('UPDATE consolidation_runs SET rollback_data = ? WHERE id = ?').run(
        JSON.stringify(journal),
        lastRun,
      );
      const table = type === 'semantic' ? 'semantics' : 'procedures';
      const before = db.prepare(`SELECT * FROM ${table}`).get();
      expect(() => rollbackConsolidation(db, runs[1].runId)).toThrow(/dependent consolidation/);
      expect(db.prepare(`SELECT * FROM ${table}`).get()).toEqual(before);
      rollbackConsolidation(db, lastRun);
      rollbackConsolidation(db, runs[1].runId);
      const restored = db.prepare(`SELECT * FROM ${table}`).get();
      expect(restored.last_reinforced_at).toBeNull();
      expect(JSON.parse(restored.evidence_episode_ids)).toHaveLength(3);
    },
  );

  it.each([undefined, 2])(
    'refuses ambiguous legacy overlap with sequence %s without changing data',
    async sequence => {
      const outputId = 'legacy-semantic';
      db.prepare(
        "INSERT INTO semantics (id, content, state, created_at, evidence_episode_ids) VALUES (?, 'legacy', 'active', ?, '[]')",
      ).run(outputId, '2026-01-01T00:00:00.000Z');
      const undo = {
        version: 1,
        changes: [{ id: outputId, type: 'semantic', created: false, addedEvidence: [] }],
      };
      const insert = db.prepare(
        "INSERT INTO consolidation_runs (id, status, input_episode_ids, output_memory_ids, completed_at, rollback_data) VALUES (?, 'completed', '[]', ?, ?, ?)",
      );
      for (const id of ['legacy-a', 'legacy-b']) {
        insert.run(
          id,
          JSON.stringify([outputId]),
          '2026-01-01T00:00:00.000Z',
          JSON.stringify({
            ...undo,
            ...(id === 'legacy-a' && sequence !== undefined ? { commitSequence: sequence } : {}),
          }),
        );
      }

      expect(() => rollbackConsolidation(db, 'legacy-a')).toThrow(/ambiguous completion order/);
      expect(
        db
          .prepare("SELECT COUNT(*) AS count FROM consolidation_runs WHERE status = 'completed'")
          .get().count,
      ).toBe(2);
      expect(db.prepare('SELECT state FROM semantics WHERE id = ?').get(outputId).state).toBe(
        'active',
      );
    },
  );

  it('throws for already rolled-back run', async () => {
    await encodeEpisode(db, embedding, { content: 'same', source: 'direct-observation' });
    await encodeEpisode(db, embedding, { content: 'same', source: 'tool-result' });
    await encodeEpisode(db, embedding, { content: 'same', source: 'told-by-user' });
    const result = await runConsolidation(db, embedding, {
      minClusterSize: 3,
      similarityThreshold: 0.99,
      extractPrinciple: () => ({ content: 'P', type: 'semantic' }),
    });
    rollbackConsolidation(db, result.runId);
    expect(() => rollbackConsolidation(db, result.runId)).toThrow();
  });
});
