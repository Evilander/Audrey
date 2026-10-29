import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { createDatabase, closeDatabase } from '../dist/src/db.js';
import { MockEmbeddingProvider } from '../dist/src/embedding.js';
import { encodeEpisode } from '../dist/src/encode.js';
import { recall } from '../dist/src/recall.js';
import { insertFTSSemantic, insertFTSProcedure } from '../dist/src/fts.js';
import { memoryRecallToolSchema } from '../dist/mcp-server/tool-schemas.js';

let db, directory, embedding;
const content = 'lighthouse deployment records';
const age = new Date(Date.now() - 30 * 86400000).toISOString();
const reinforced = new Date(Date.now() - 7 * 86400000).toISOString();

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'audrey-retrieval-invariants-'));
  ({ db } = createDatabase(directory, { dimensions: 8 }));
  embedding = new MockEmbeddingProvider({ dimensions: 8 });
});

afterEach(() => {
  closeDatabase(db);
  rmSync(directory, { recursive: true, force: true });
});

async function seed(type, id = type, state = 'active', agent = 'owner', text = content) {
  if (type === 'episodic') {
    const episode = await encodeEpisode(db, embedding, {
      content: text,
      agent,
      source: 'told-by-user',
      salience: 0.1,
      context: { project: 'old' },
      affect: { valence: -0.8, arousal: 0.2 },
    });
    db.prepare('UPDATE episodes SET created_at = ? WHERE id = ?').run(age, episode);
    return episode;
  }
  const table = type === 'semantic' ? 'semantics' : 'procedures';
  const buffer = embedding.vectorToBuffer(await embedding.embed(text));
  const counts =
    type === 'semantic' ? 'supporting_count, contradicting_count' : 'success_count, failure_count';
  db.prepare(
    `INSERT INTO ${table}(id,content,agent,embedding,state,created_at,salience,retrieval_count,last_reinforced_at,interference_count,${counts}) VALUES (?,?,?,?,?,?,0.2,3,?,2,4,1)`,
  ).run(id, text, agent, buffer, state, age, reinforced);
  db.prepare(`INSERT INTO vec_${table}(id,agent,embedding,state) VALUES (?,?,?,?)`).run(
    id,
    agent,
    buffer,
    state,
  );
  (type === 'semantic' ? insertFTSSemantic : insertFTSProcedure)(db, id, text);
  return id;
}

function resetRetrieval(type) {
  if (type === 'episodic') return;
  const table = type === 'semantic' ? 'semantics' : 'procedures';
  db.prepare(`UPDATE ${table} SET retrieval_count=3,last_reinforced_at=?`).run(reinforced);
}

describe('retrieval scoring invariants', () => {
  it.each(['episodic', 'semantic', 'procedural'])(
    'uses identical %s confidence, filters and provenance for vector and FTS candidates',
    async type => {
      const id = await seed(type);
      const options = {
        types: [type],
        scope: 'agent',
        agent: 'owner',
        includeProvenance: true,
        confidenceConfig: {
          weights: { source: 0.1, evidence: 0.2, recency: 0.3, retrieval: 0.4 },
          halfLives: { episodic: 10, semantic: 10, procedural: 10 },
          retrievalContext: { project: 'current' },
          retrievalMood: { valence: 0.8, arousal: 0.8 },
        },
      };
      const [baseline] = await recall(db, embedding, content, { ...options, retrieval: 'vector' });
      expect(baseline.id).toBe(id);
      expect(baseline.confidence).toBeLessThan(0.8);
      for (const retrieval of ['vector', 'keyword', 'hybrid']) {
        if (retrieval === 'hybrid') {
          const table =
            type === 'episodic' ? 'episodes' : type === 'semantic' ? 'semantics' : 'procedures';
          db.prepare(`DELETE FROM vec_${table} WHERE id=?`).run(id);
        }
        resetRetrieval(type);
        const [result] = await recall(db, embedding, content, {
          ...options,
          retrieval,
          minConfidence: baseline.confidence - 0.001,
        });
        expect(result.id).toBe(id);
        expect(result.confidence).toBeCloseTo(baseline.confidence, 6);
        expect(result.provenance).toEqual(baseline.provenance);
        expect(result.contextMatch).toEqual(baseline.contextMatch);
        expect(result.moodCongruence).toEqual(baseline.moodCongruence);
        resetRetrieval(type);
        expect(
          await recall(db, embedding, content, {
            ...options,
            retrieval,
            minConfidence: baseline.confidence + 0.001,
          }),
        ).toEqual([]);
      }
    },
  );

  it.each(['semantic', 'procedural'])(
    'keyword retrieval honors all live %s states and the agent scope',
    async type => {
      for (const state of [
        'active',
        'context_dependent',
        'dormant',
        'disputed',
        'superseded',
        'rolled_back',
      ]) {
        await seed(type, state, state, 'owner', `lighthouse ${state}`);
      }
      await seed(type, 'other-agent', 'active', 'other', 'lighthouse outsider');
      const options = {
        retrieval: 'keyword',
        types: [type],
        scope: 'agent',
        agent: 'owner',
        limit: 10,
      };
      expect((await recall(db, embedding, 'lighthouse', options)).map(r => r.id).sort()).toEqual([
        'active',
        'context_dependent',
      ]);
      expect(
        (await recall(db, embedding, 'lighthouse', { ...options, includeDormant: true }))
          .map(r => r.id)
          .sort(),
      ).toEqual(['active', 'context_dependent', 'dormant']);
    },
  );
});

describe('recall input boundaries', () => {
  it.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
    'rejects limit %s before embedding or database work',
    async limit => {
      const provider = { embed: vi.fn() };
      for (const retrieval of ['vector', 'keyword', 'hybrid']) {
        await expect(recall(null, provider, content, { limit, retrieval })).rejects.toThrow(
          'positive integer',
        );
      }
      expect(provider.embed).not.toHaveBeenCalled();
    },
  );

  it('rejects fractional MCP limits while accepting supported integer limits', () => {
    const schema = z.object(memoryRecallToolSchema);
    expect(schema.safeParse({ query: content, limit: 1.5 }).success).toBe(false);
    expect(schema.safeParse({ query: content, limit: 1 }).success).toBe(true);
    expect(schema.safeParse({ query: content, limit: 50 }).success).toBe(true);
  });
});
