import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { runConsolidation } from '../dist/src/consolidate.js';
import { encodeEpisode } from '../dist/src/encode.js';
import { createDatabase, closeDatabase } from '../dist/src/db.js';
import { MockEmbeddingProvider } from '../dist/src/embedding.js';
import { existsSync, rmSync, mkdirSync } from 'node:fs';

const TEST_DIR = './test-consolidation-merge-data';

describe('runConsolidation deduplicates against existing active memories', () => {
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

  it('merges a near-duplicate semantic instead of creating a second copy', async () => {
    await encodeEpisode(db, embedding, { content: 'first batch a', source: 'direct-observation' });
    await encodeEpisode(db, embedding, { content: 'first batch a', source: 'tool-result' });
    await encodeEpisode(db, embedding, { content: 'first batch a', source: 'told-by-user' });

    const firstRun = await runConsolidation(db, embedding, {
      minClusterSize: 3,
      similarityThreshold: 0.99,
      extractPrinciple: () => ({ content: 'Stripe rate limit is 100 rps', type: 'semantic' }),
    });
    expect(firstRun.semanticsCreated).toBe(1);
    expect(firstRun.semanticsMerged).toBe(0);

    await encodeEpisode(db, embedding, { content: 'second batch a', source: 'direct-observation' });
    await encodeEpisode(db, embedding, { content: 'second batch a', source: 'tool-result' });
    await encodeEpisode(db, embedding, { content: 'second batch a', source: 'told-by-user' });

    const secondRun = await runConsolidation(db, embedding, {
      minClusterSize: 3,
      similarityThreshold: 0.99,
      extractPrinciple: () => ({ content: 'Stripe rate limit is 100 rps', type: 'semantic' }),
    });

    expect(secondRun.semanticsCreated).toBe(0);
    expect(secondRun.semanticsMerged).toBe(1);
    // Honest counts: a merge is not a create, but the cluster was still processed.
    expect(secondRun.principlesExtracted).toBe(1);

    // Pre-fix, runConsolidation had no similarity check against existing
    // semantics, so this second run would have minted a duplicate row.
    const sems = db.prepare("SELECT * FROM semantics WHERE state = 'active'").all();
    expect(sems.length).toBe(1);
    expect(sems[0].supporting_count).toBe(6);
    expect(sems[0].evidence_count).toBe(6);
    expect(JSON.parse(sems[0].evidence_episode_ids).length).toBe(6);
    expect(sems[0].source_type_diversity).toBe(3);
    expect(sems[0].last_reinforced_at).not.toBeNull();

    const unconsolidated = db
      .prepare('SELECT COUNT(*) as count FROM episodes WHERE consolidated = 0')
      .get();
    expect(unconsolidated.count).toBe(0);
  });

  it('respects a configurable merge threshold', async () => {
    await encodeEpisode(db, embedding, { content: 'first batch b', source: 'direct-observation' });
    await encodeEpisode(db, embedding, { content: 'first batch b', source: 'tool-result' });
    await encodeEpisode(db, embedding, { content: 'first batch b', source: 'told-by-user' });

    await runConsolidation(db, embedding, {
      minClusterSize: 3,
      similarityThreshold: 0.99,
      extractPrinciple: () => ({ content: 'Duplicate-shaped principle', type: 'semantic' }),
    });

    await encodeEpisode(db, embedding, { content: 'second batch b', source: 'direct-observation' });
    await encodeEpisode(db, embedding, { content: 'second batch b', source: 'tool-result' });
    await encodeEpisode(db, embedding, { content: 'second batch b', source: 'told-by-user' });

    const secondRun = await runConsolidation(db, embedding, {
      minClusterSize: 3,
      similarityThreshold: 0.99,
      extractPrinciple: () => ({ content: 'Duplicate-shaped principle', type: 'semantic' }),
      mergeSimilarityThreshold: 1.5,
    });

    expect(secondRun.semanticsMerged).toBe(0);
    expect(secondRun.semanticsCreated).toBe(1);
    const sems = db.prepare("SELECT * FROM semantics WHERE state = 'active'").all();
    expect(sems.length).toBe(2);
  });

  it('merges a duplicate procedural principle and bumps success_count', async () => {
    await encodeEpisode(db, embedding, {
      content: 'restart worker batch one',
      source: 'direct-observation',
    });
    await encodeEpisode(db, embedding, {
      content: 'restart worker batch one',
      source: 'tool-result',
    });
    await encodeEpisode(db, embedding, {
      content: 'restart worker batch one',
      source: 'told-by-user',
    });

    await runConsolidation(db, embedding, {
      minClusterSize: 3,
      similarityThreshold: 0.99,
      extractPrinciple: () => ({ content: 'Restart worker on OOM', type: 'procedural' }),
    });

    await encodeEpisode(db, embedding, {
      content: 'restart worker batch two',
      source: 'direct-observation',
    });
    await encodeEpisode(db, embedding, {
      content: 'restart worker batch two',
      source: 'tool-result',
    });
    await encodeEpisode(db, embedding, {
      content: 'restart worker batch two',
      source: 'told-by-user',
    });

    const secondRun = await runConsolidation(db, embedding, {
      minClusterSize: 3,
      similarityThreshold: 0.99,
      extractPrinciple: () => ({ content: 'Restart worker on OOM', type: 'procedural' }),
    });

    expect(secondRun.proceduresMerged).toBe(1);
    expect(secondRun.proceduresCreated).toBe(0);

    const procs = db.prepare("SELECT * FROM procedures WHERE state = 'active'").all();
    expect(procs.length).toBe(1);
    expect(procs[0].success_count).toBe(3);
    expect(JSON.parse(procs[0].evidence_episode_ids).length).toBe(6);
    expect(procs[0].last_reinforced_at).not.toBeNull();
  });

  it('does not merge across different agents', async () => {
    await encodeEpisode(db, embedding, {
      content: 'agent one fact',
      source: 'direct-observation',
      agent: 'agent-one',
    });
    await encodeEpisode(db, embedding, {
      content: 'agent one fact',
      source: 'tool-result',
      agent: 'agent-one',
    });
    await encodeEpisode(db, embedding, {
      content: 'agent one fact',
      source: 'told-by-user',
      agent: 'agent-one',
    });
    await encodeEpisode(db, embedding, {
      content: 'agent two fact',
      source: 'direct-observation',
      agent: 'agent-two',
    });
    await encodeEpisode(db, embedding, {
      content: 'agent two fact',
      source: 'tool-result',
      agent: 'agent-two',
    });
    await encodeEpisode(db, embedding, {
      content: 'agent two fact',
      source: 'told-by-user',
      agent: 'agent-two',
    });

    const runOne = await runConsolidation(db, embedding, {
      minClusterSize: 3,
      similarityThreshold: 0.99,
      agent: 'agent-one',
      extractPrinciple: () => ({ content: 'Shared principle text', type: 'semantic' }),
    });
    const runTwo = await runConsolidation(db, embedding, {
      minClusterSize: 3,
      similarityThreshold: 0.99,
      agent: 'agent-two',
      extractPrinciple: () => ({ content: 'Shared principle text', type: 'semantic' }),
    });

    expect(runOne.semanticsCreated).toBe(1);
    expect(runTwo.semanticsCreated).toBe(1);
    expect(runTwo.semanticsMerged).toBe(0);
    const sems = db.prepare("SELECT * FROM semantics WHERE state = 'active'").all();
    expect(sems.length).toBe(2);
  });
});
