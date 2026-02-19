import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { runConsolidation, clusterEpisodes } from '../src/consolidate.js';
import { encodeEpisode } from '../src/encode.js';
import { createDatabase, closeDatabase } from '../src/db.js';
import { MockEmbeddingProvider } from '../src/embedding.js';
import { MockLLMProvider } from '../src/llm.js';
import { existsSync, rmSync, mkdirSync } from 'node:fs';

const TEST_DIR = './test-consolidate-data';

describe('clusterEpisodes', () => {
  let db, embedding;

  beforeEach(async () => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
    db = createDatabase(TEST_DIR);
    embedding = new MockEmbeddingProvider({ dimensions: 8 });
  });

  afterEach(() => {
    closeDatabase(db);
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  it('returns empty array when no unconsolidated episodes', () => {
    const clusters = clusterEpisodes(db, embedding, {});
    expect(clusters).toEqual([]);
  });

  it('skips already-consolidated episodes', async () => {
    const id = await encodeEpisode(db, embedding, { content: 'Already seen', source: 'direct-observation' });
    db.prepare('UPDATE episodes SET consolidated = 1 WHERE id = ?').run(id);
    const clusters = clusterEpisodes(db, embedding, { similarityThreshold: 0.0, minClusterSize: 1 });
    const hasConsolidated = clusters.flat().some(ep => ep.id === id);
    expect(hasConsolidated).toBe(false);
  });

  it('clusters identical-content episodes together', async () => {
    await encodeEpisode(db, embedding, { content: 'same event', source: 'direct-observation' });
    await encodeEpisode(db, embedding, { content: 'same event', source: 'tool-result' });
    await encodeEpisode(db, embedding, { content: 'same event', source: 'told-by-user' });
    const clusters = clusterEpisodes(db, embedding, { similarityThreshold: 0.99, minClusterSize: 3 });
    expect(clusters.length).toBe(1);
    expect(clusters[0].length).toBe(3);
  });

  it('does not cluster dissimilar episodes', async () => {
    await encodeEpisode(db, embedding, { content: 'alpha bravo charlie', source: 'direct-observation' });
    await encodeEpisode(db, embedding, { content: 'delta echo foxtrot', source: 'direct-observation' });
    const clusters = clusterEpisodes(db, embedding, { similarityThreshold: 0.99, minClusterSize: 2 });
    expect(clusters.length).toBe(0);
  });
});

describe('runConsolidation', () => {
  let db, embedding;

  beforeEach(async () => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
    db = createDatabase(TEST_DIR);
    embedding = new MockEmbeddingProvider({ dimensions: 8 });
  });

  afterEach(() => {
    closeDatabase(db);
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  it('creates a consolidation_run record', async () => {
    const result = await runConsolidation(db, embedding, { minClusterSize: 3 });
    expect(result).toHaveProperty('runId');
    const run = db.prepare('SELECT * FROM consolidation_runs WHERE id = ?').get(result.runId);
    expect(run).not.toBeNull();
    expect(run.status).toBe('completed');
  });

  it('returns statistics', async () => {
    const result = await runConsolidation(db, embedding, { minClusterSize: 3 });
    expect(result).toHaveProperty('episodesEvaluated');
    expect(result).toHaveProperty('clustersFound');
    expect(result).toHaveProperty('principlesExtracted');
  });

  it('extracts principle from clustered episodes using extractPrinciple callback', async () => {
    await encodeEpisode(db, embedding, { content: 'same thing', source: 'direct-observation' });
    await encodeEpisode(db, embedding, { content: 'same thing', source: 'tool-result' });
    await encodeEpisode(db, embedding, { content: 'same thing', source: 'told-by-user' });

    const result = await runConsolidation(db, embedding, {
      minClusterSize: 3,
      similarityThreshold: 0.99,
      extractPrinciple: (episodes) => ({ content: 'This happens repeatedly', type: 'semantic' }),
    });

    expect(result.principlesExtracted).toBe(1);
    const sem = db.prepare("SELECT * FROM semantics WHERE state = 'active'").all();
    expect(sem.length).toBe(1);
    expect(sem[0].content).toBe('This happens repeatedly');
    expect(sem[0].evidence_count).toBe(3);
    expect(sem[0].source_type_diversity).toBe(3);
  });

  it('marks clustered episodes as consolidated', async () => {
    await encodeEpisode(db, embedding, { content: 'same thing', source: 'direct-observation' });
    await encodeEpisode(db, embedding, { content: 'same thing', source: 'tool-result' });
    await encodeEpisode(db, embedding, { content: 'same thing', source: 'told-by-user' });

    await runConsolidation(db, embedding, {
      minClusterSize: 3,
      similarityThreshold: 0.99,
      extractPrinciple: () => ({ content: 'Principle', type: 'semantic' }),
    });

    const unconsolidated = db.prepare('SELECT COUNT(*) as count FROM episodes WHERE consolidated = 0').get();
    expect(unconsolidated.count).toBe(0);
  });

  it('is idempotent — second run with no new episodes produces nothing new', async () => {
    await encodeEpisode(db, embedding, { content: 'test', source: 'direct-observation' });

    await runConsolidation(db, embedding, { minClusterSize: 1, similarityThreshold: 0.5 });
    const run2 = await runConsolidation(db, embedding, { minClusterSize: 1, similarityThreshold: 0.5 });
    expect(run2.episodesEvaluated).toBe(0);
  });

  it('records audit trail with input/output IDs', async () => {
    await encodeEpisode(db, embedding, { content: 'same', source: 'direct-observation' });
    await encodeEpisode(db, embedding, { content: 'same', source: 'tool-result' });
    await encodeEpisode(db, embedding, { content: 'same', source: 'told-by-user' });

    const result = await runConsolidation(db, embedding, {
      minClusterSize: 3,
      similarityThreshold: 0.99,
      extractPrinciple: () => ({ content: 'P', type: 'semantic' }),
    });

    const run = db.prepare('SELECT * FROM consolidation_runs WHERE id = ?').get(result.runId);
    const inputIds = JSON.parse(run.input_episode_ids);
    const outputIds = JSON.parse(run.output_memory_ids);
    expect(inputIds.length).toBe(3);
    expect(outputIds.length).toBe(1);
  });
});

describe('runConsolidation with LLM', () => {
  let db, embedding, llm;

  beforeEach(async () => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
    db = createDatabase(TEST_DIR);
    embedding = new MockEmbeddingProvider({ dimensions: 8 });
    llm = new MockLLMProvider({
      responses: {
        principleExtraction: {
          content: 'Stripe API has a rate limit of 100 requests per second',
          type: 'semantic',
          conditions: ['Only applies to live-mode keys'],
        },
        contradictionDetection: {
          contradicts: false,
          explanation: 'No existing knowledge to contradict',
        },
      },
    });
  });

  afterEach(() => {
    closeDatabase(db);
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  it('uses LLM provider for principle extraction when available', async () => {
    await encodeEpisode(db, embedding, { content: 'same thing', source: 'direct-observation' });
    await encodeEpisode(db, embedding, { content: 'same thing', source: 'tool-result' });
    await encodeEpisode(db, embedding, { content: 'same thing', source: 'told-by-user' });

    const result = await runConsolidation(db, embedding, {
      minClusterSize: 3,
      similarityThreshold: 0.99,
      llmProvider: llm,
    });

    expect(result.principlesExtracted).toBe(1);
    const sem = db.prepare("SELECT * FROM semantics WHERE state = 'active'").all();
    expect(sem.length).toBe(1);
    expect(sem[0].content).toBe('Stripe API has a rate limit of 100 requests per second');
  });

  it('prefers extractPrinciple callback over LLM provider', async () => {
    await encodeEpisode(db, embedding, { content: 'same thing', source: 'direct-observation' });
    await encodeEpisode(db, embedding, { content: 'same thing', source: 'tool-result' });
    await encodeEpisode(db, embedding, { content: 'same thing', source: 'told-by-user' });

    const result = await runConsolidation(db, embedding, {
      minClusterSize: 3,
      similarityThreshold: 0.99,
      llmProvider: llm,
      extractPrinciple: () => ({ content: 'Custom callback principle', type: 'semantic' }),
    });

    const sem = db.prepare("SELECT content FROM semantics WHERE state = 'active'").get();
    expect(sem.content).toBe('Custom callback principle');
  });

  it('stores consolidation_model when using LLM', async () => {
    await encodeEpisode(db, embedding, { content: 'same thing', source: 'direct-observation' });
    await encodeEpisode(db, embedding, { content: 'same thing', source: 'tool-result' });
    await encodeEpisode(db, embedding, { content: 'same thing', source: 'told-by-user' });

    await runConsolidation(db, embedding, {
      minClusterSize: 3,
      similarityThreshold: 0.99,
      llmProvider: llm,
    });

    const sem = db.prepare('SELECT consolidation_model FROM semantics').get();
    expect(sem.consolidation_model).toBe('mock-llm');
  });

  it('falls back to default extraction when no LLM and no callback', async () => {
    await encodeEpisode(db, embedding, { content: 'same thing', source: 'direct-observation' });
    await encodeEpisode(db, embedding, { content: 'same thing', source: 'tool-result' });
    await encodeEpisode(db, embedding, { content: 'same thing', source: 'told-by-user' });

    const result = await runConsolidation(db, embedding, {
      minClusterSize: 3,
      similarityThreshold: 0.99,
    });

    const sem = db.prepare('SELECT content FROM semantics').get();
    expect(sem.content).toContain('Recurring pattern:');
  });
});
