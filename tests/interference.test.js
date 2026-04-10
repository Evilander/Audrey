import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { applyInterference, interferenceModifier } from '../dist/src/interference.js';
import { createDatabase, closeDatabase } from '../dist/src/db.js';
import { createEmbeddingProvider } from '../dist/src/embedding.js';
import { encodeEpisode } from '../dist/src/encode.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

let db, dataDir, embeddingProvider;
beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'audrey-'));
  embeddingProvider = createEmbeddingProvider({ provider: 'mock', dimensions: 64 });
  ({ db } = createDatabase(dataDir, { dimensions: 64 }));
});
afterEach(() => {
  closeDatabase(db);
  rmSync(dataDir, { recursive: true, force: true });
});

describe('applyInterference', () => {
  it('returns empty array when no similar semantics exist', async () => {
    const episodeId = await encodeEpisode(db, embeddingProvider, {
      content: 'The sky is blue on clear days',
      source: 'direct-observation',
    });

    const affected = await applyInterference(db, embeddingProvider, episodeId, {
      content: 'The sky is blue on clear days',
    });

    expect(affected).toEqual([]);
  });

  it('increments interference_count on similar semantics', async () => {
    const semanticContent = 'Cats are obligate carnivores';
    const vector = await embeddingProvider.embed(semanticContent);
    const buffer = embeddingProvider.vectorToBuffer(vector);
    db.prepare(`
      INSERT INTO semantics (id, content, embedding, state, created_at, interference_count, salience)
      VALUES (?, ?, ?, 'active', ?, 0, 0.5)
    `).run('sem-1', semanticContent, buffer, new Date().toISOString());
    db.prepare('INSERT INTO vec_semantics(id, embedding, state) VALUES (?, ?, ?)').run('sem-1', buffer, 'active');

    const episodeId = await encodeEpisode(db, embeddingProvider, {
      content: semanticContent,
      source: 'direct-observation',
    });

    const affected = await applyInterference(db, embeddingProvider, episodeId, {
      content: semanticContent,
    });

    expect(affected.length).toBeGreaterThanOrEqual(1);
    const semHit = affected.find(a => a.id === 'sem-1');
    expect(semHit).toBeDefined();
    expect(semHit.newCount).toBe(1);
    expect(semHit.type).toBe('semantic');
    expect(semHit.similarity).toBeCloseTo(1.0, 1);

    const row = db.prepare('SELECT interference_count FROM semantics WHERE id = ?').get('sem-1');
    expect(row.interference_count).toBe(1);
  });

  it('does not affect dissimilar memories', async () => {
    const cookingContent = 'Sear steak at 450 degrees for a crispy crust';
    const vector = await embeddingProvider.embed(cookingContent);
    const buffer = embeddingProvider.vectorToBuffer(vector);
    db.prepare(`
      INSERT INTO semantics (id, content, embedding, state, created_at, interference_count, salience)
      VALUES (?, ?, ?, 'active', ?, 0, 0.5)
    `).run('sem-cook', cookingContent, buffer, new Date().toISOString());
    db.prepare('INSERT INTO vec_semantics(id, embedding, state) VALUES (?, ?, ?)').run('sem-cook', buffer, 'active');

    const episodeId = await encodeEpisode(db, embeddingProvider, {
      content: 'Thunderstorms expected this weekend with heavy rainfall',
      source: 'direct-observation',
    });

    const affected = await applyInterference(db, embeddingProvider, episodeId, {
      content: 'Thunderstorms expected this weekend with heavy rainfall',
    }, { threshold: 0.99 });

    expect(affected).toEqual([]);

    const row = db.prepare('SELECT interference_count FROM semantics WHERE id = ?').get('sem-cook');
    expect(row.interference_count).toBe(0);
  });

  it('respects enabled=false config', async () => {
    const episodeId = await encodeEpisode(db, embeddingProvider, {
      content: 'This should not trigger interference',
      source: 'direct-observation',
    });

    const affected = await applyInterference(db, embeddingProvider, episodeId, {
      content: 'This should not trigger interference',
    }, { enabled: false });

    expect(affected).toEqual([]);
  });
});

describe('interferenceModifier', () => {
  it('returns correct values for known inputs', () => {
    expect(interferenceModifier(0, 0.1)).toBeCloseTo(1.0, 5);
    expect(interferenceModifier(5, 0.1)).toBeCloseTo(1 / 1.5, 5);
    expect(interferenceModifier(10, 0.1)).toBeCloseTo(0.5, 5);
    expect(interferenceModifier(1, 0.1)).toBeCloseTo(1 / 1.1, 5);
  });

  it('uses default weight of 0.1', () => {
    expect(interferenceModifier(5)).toBeCloseTo(1 / 1.5, 5);
  });
});
