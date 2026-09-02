import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { runConsolidation } from '../dist/src/consolidate.js';
import { encodeEpisode } from '../dist/src/encode.js';
import { createDatabase, closeDatabase } from '../dist/src/db.js';
import { MockEmbeddingProvider } from '../dist/src/embedding.js';
import { MockLLMProvider } from '../dist/src/llm.js';
import { existsSync, rmSync, mkdirSync } from 'node:fs';

const TEST_DIR = './test-consolidation-privacy-data';

describe('runConsolidation excludes private episodes from cloud LLM consolidation', () => {
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

  it('never sends private episode content to the LLM provider, and still consolidates it locally', async () => {
    await encodeEpisode(db, embedding, {
      content: 'my private diary entry about anxiety',
      source: 'direct-observation',
      private: true,
    });
    await encodeEpisode(db, embedding, {
      content: 'my private diary entry about anxiety',
      source: 'tool-result',
      private: true,
    });
    await encodeEpisode(db, embedding, {
      content: 'my private diary entry about anxiety',
      source: 'told-by-user',
      private: true,
    });

    const seenMessages = [];
    const llm = {
      modelName: 'spy-llm',
      modelVersion: '1.0.0',
      async complete() {
        return { content: '{}' };
      },
      async json(messages) {
        seenMessages.push(messages);
        return { content: 'Should never be produced from private content', type: 'semantic' };
      },
    };

    const result = await runConsolidation(db, embedding, {
      minClusterSize: 3,
      similarityThreshold: 0.99,
      llmProvider: llm,
    });

    // Pre-fix, clusterEpisodes had no privacy filter, so the private cluster
    // would have been sent straight into llmExtractPrinciple -> llm.json().
    expect(seenMessages.length).toBe(0);

    const sem = db.prepare("SELECT * FROM semantics WHERE state = 'active'").all();
    expect(sem.length).toBe(1);
    expect(sem[0].content).toContain('Recurring pattern:');
    expect(sem[0].consolidation_model).toBeNull();
    // Taint: the derived row restates private episode content, so it must
    // inherit the private flag.
    expect(sem[0].private).toBe(1);

    const unconsolidated = db
      .prepare('SELECT COUNT(*) as count FROM episodes WHERE consolidated = 0')
      .get();
    expect(unconsolidated.count).toBe(0);
    expect(result.principlesExtracted).toBe(1);
  });

  it('still sends non-private episodes to the LLM in the same run that excludes private ones', async () => {
    await encodeEpisode(db, embedding, {
      content: 'shared team fact',
      source: 'direct-observation',
    });
    await encodeEpisode(db, embedding, { content: 'shared team fact', source: 'tool-result' });
    await encodeEpisode(db, embedding, { content: 'shared team fact', source: 'told-by-user' });
    await encodeEpisode(db, embedding, {
      content: 'private note about health',
      source: 'direct-observation',
      private: true,
    });
    await encodeEpisode(db, embedding, {
      content: 'private note about health',
      source: 'tool-result',
      private: true,
    });
    await encodeEpisode(db, embedding, {
      content: 'private note about health',
      source: 'told-by-user',
      private: true,
    });

    const llm = new MockLLMProvider({
      responses: {
        principleExtraction: { content: 'Cloud-derived principle', type: 'semantic' },
      },
    });

    const result = await runConsolidation(db, embedding, {
      minClusterSize: 3,
      similarityThreshold: 0.99,
      llmProvider: llm,
    });

    const sems = db.prepare("SELECT * FROM semantics WHERE state = 'active'").all();
    expect(sems.length).toBe(2);
    expect(
      sems.some(
        s => s.content === 'Cloud-derived principle' && s.consolidation_model === 'mock-llm',
      ),
    ).toBe(true);
    expect(
      sems.some(s => s.content.includes('Recurring pattern:') && s.consolidation_model === null),
    ).toBe(true);
    expect(result.principlesExtracted).toBe(2);

    // Taint splits with the clusters: the shared-derived row is public, the
    // private-derived row inherits private = 1.
    const cloudDerived = sems.find(s => s.content === 'Cloud-derived principle');
    const localDerived = sems.find(s => s.content.includes('Recurring pattern:'));
    expect(cloudDerived.private).toBe(0);
    expect(localDerived.private).toBe(1);
  });

  it('processes private episodes through the normal local path when no LLM provider is configured', async () => {
    await encodeEpisode(db, embedding, {
      content: 'private note without llm configured',
      source: 'direct-observation',
      private: true,
    });
    await encodeEpisode(db, embedding, {
      content: 'private note without llm configured',
      source: 'tool-result',
      private: true,
    });
    await encodeEpisode(db, embedding, {
      content: 'private note without llm configured',
      source: 'told-by-user',
      private: true,
    });

    const result = await runConsolidation(db, embedding, {
      minClusterSize: 3,
      similarityThreshold: 0.99,
    });
    expect(result.principlesExtracted).toBe(1);
    const sem = db.prepare("SELECT * FROM semantics WHERE state = 'active'").get();
    expect(sem.content).toContain('Recurring pattern:');
    expect(sem.private).toBe(1);
  });

  it('taints the derived row when a mixed local cluster contains any private episode', async () => {
    // No llmProvider: private and non-private episodes cluster together, so
    // one private episode in the cluster must taint the derived row.
    await encodeEpisode(db, embedding, {
      content: 'mixed cluster observation',
      source: 'direct-observation',
    });
    await encodeEpisode(db, embedding, {
      content: 'mixed cluster observation',
      source: 'tool-result',
    });
    await encodeEpisode(db, embedding, {
      content: 'mixed cluster observation',
      source: 'told-by-user',
      private: true,
    });

    const result = await runConsolidation(db, embedding, {
      minClusterSize: 3,
      similarityThreshold: 0.99,
    });
    expect(result.principlesExtracted).toBe(1);
    const sem = db.prepare("SELECT * FROM semantics WHERE state = 'active'").get();
    expect(sem.private).toBe(1);
  });

  it('leaves derived rows public when no evidence episode is private', async () => {
    await encodeEpisode(db, embedding, {
      content: 'entirely public observation',
      source: 'direct-observation',
    });
    await encodeEpisode(db, embedding, {
      content: 'entirely public observation',
      source: 'tool-result',
    });
    await encodeEpisode(db, embedding, {
      content: 'entirely public observation',
      source: 'told-by-user',
    });

    await runConsolidation(db, embedding, { minClusterSize: 3, similarityThreshold: 0.99 });
    const sem = db.prepare("SELECT * FROM semantics WHERE state = 'active'").get();
    expect(sem.private).toBe(0);
  });
});
