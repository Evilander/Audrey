import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { arousalSalienceBoost, affectSimilarity, moodCongruenceModifier, detectResonance } from '../src/affect.js';
import { createDatabase, closeDatabase } from '../src/db.js';
import { createEmbeddingProvider } from '../src/embedding.js';
import { encodeEpisode } from '../src/encode.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('arousalSalienceBoost', () => {
  it('returns 0 when arousal is undefined', () => {
    expect(arousalSalienceBoost(undefined)).toBe(0);
  });

  it('returns 0 when arousal is null', () => {
    expect(arousalSalienceBoost(null)).toBe(0);
  });

  it('peaks near arousal=0.7', () => {
    const atPeak = arousalSalienceBoost(0.7);
    const below = arousalSalienceBoost(0.3);
    const above = arousalSalienceBoost(1.0);
    expect(atPeak).toBeGreaterThan(below);
    expect(atPeak).toBeGreaterThan(above);
    expect(atPeak).toBeCloseTo(1.0, 1);
  });

  it('returns low value at arousal=0', () => {
    expect(arousalSalienceBoost(0)).toBeLessThan(0.15);
  });

  it('returns moderate value at arousal=1.0', () => {
    const val = arousalSalienceBoost(1.0);
    expect(val).toBeGreaterThan(0.2);
    expect(val).toBeLessThan(0.8);
  });

  it('is symmetric around 0.7', () => {
    const below = arousalSalienceBoost(0.4);
    const above = arousalSalienceBoost(1.0);
    expect(below).toBeCloseTo(above, 1);
  });
});

describe('affectSimilarity', () => {
  it('returns 0 when either affect is null', () => {
    expect(affectSimilarity(null, { valence: 0.5 })).toBe(0);
    expect(affectSimilarity({ valence: 0.5 }, null)).toBe(0);
  });

  it('returns 0 when either valence is undefined', () => {
    expect(affectSimilarity({}, { valence: 0.5 })).toBe(0);
    expect(affectSimilarity({ valence: 0.5 }, {})).toBe(0);
  });

  it('returns 1.0 for identical affect', () => {
    expect(affectSimilarity(
      { valence: 0.5, arousal: 0.7 },
      { valence: 0.5, arousal: 0.7 },
    )).toBeCloseTo(1.0);
  });

  it('returns 0 for opposite valence', () => {
    expect(affectSimilarity(
      { valence: -1.0 },
      { valence: 1.0 },
    )).toBeCloseTo(0);
  });

  it('returns 0.5 for orthogonal valence (valence-only)', () => {
    const sim = affectSimilarity(
      { valence: 0.0 },
      { valence: 1.0 },
    );
    expect(sim).toBeCloseTo(0.5, 1);
  });

  it('weights valence more than arousal', () => {
    const sameValDiffArousal = affectSimilarity(
      { valence: 0.5, arousal: 0.0 },
      { valence: 0.5, arousal: 1.0 },
    );
    const diffValSameArousal = affectSimilarity(
      { valence: -0.5, arousal: 0.5 },
      { valence: 0.5, arousal: 0.5 },
    );
    expect(sameValDiffArousal).toBeGreaterThan(diffValSameArousal);
  });

  it('handles valence-only comparison', () => {
    const sim = affectSimilarity(
      { valence: 0.8 },
      { valence: 0.8 },
    );
    expect(sim).toBeCloseTo(1.0);
  });
});

describe('moodCongruenceModifier', () => {
  it('returns 1.0 when no affect provided', () => {
    expect(moodCongruenceModifier(null, null)).toBe(1.0);
    expect(moodCongruenceModifier({}, {})).toBe(1.0);
    expect(moodCongruenceModifier(null, { valence: 0.5 })).toBe(1.0);
  });

  it('returns 1.0 + weight for identical affect (default weight 0.2)', () => {
    expect(moodCongruenceModifier(
      { valence: 0.5, arousal: 0.7 },
      { valence: 0.5, arousal: 0.7 },
    )).toBeCloseTo(1.2);
  });

  it('returns ~1.0 for opposite valence', () => {
    const result = moodCongruenceModifier(
      { valence: -1.0 },
      { valence: 1.0 },
    );
    expect(result).toBeCloseTo(1.0, 1);
  });

  it('respects custom weight', () => {
    expect(moodCongruenceModifier(
      { valence: 0.5, arousal: 0.7 },
      { valence: 0.5, arousal: 0.7 },
      0.4,
    )).toBeCloseTo(1.4);
  });

  it('returns partial boost for partial valence match', () => {
    const result = moodCongruenceModifier(
      { valence: 0.5 },
      { valence: 0.0 },
    );
    expect(result).toBeGreaterThan(1.0);
    expect(result).toBeLessThan(1.2);
  });
});

describe('detectResonance', () => {
  let db, dataDir, embedding;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'audrey-'));
    embedding = createEmbeddingProvider({ provider: 'mock', dimensions: 64 });
    ({ db } = createDatabase(dataDir, { dimensions: 64 }));
  });

  afterEach(() => {
    closeDatabase(db);
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('returns empty array when no prior episodes exist', async () => {
    const id = await encodeEpisode(db, embedding, {
      content: 'first memory ever',
      source: 'direct-observation',
      affect: { valence: 0.5, arousal: 0.6 },
    });
    const resonances = await detectResonance(db, embedding, id, {
      content: 'first memory ever',
      affect: { valence: 0.5, arousal: 0.6 },
    });
    expect(resonances).toEqual([]);
  });

  it('detects resonance with emotionally similar prior episode', async () => {
    await encodeEpisode(db, embedding, {
      content: 'debugging a frustrating auth bug',
      source: 'direct-observation',
      affect: { valence: -0.4, arousal: 0.7, label: 'frustration' },
    });

    const newId = await encodeEpisode(db, embedding, {
      content: 'debugging a frustrating auth bug',
      source: 'direct-observation',
      affect: { valence: -0.3, arousal: 0.6, label: 'frustration' },
    });

    const resonances = await detectResonance(db, embedding, newId, {
      content: 'debugging a frustrating auth bug',
      affect: { valence: -0.3, arousal: 0.6 },
    }, { threshold: 0.5, affectThreshold: 0.5 });

    expect(resonances.length).toBeGreaterThan(0);
    expect(resonances[0].emotionalSimilarity).toBeGreaterThan(0.5);
    expect(resonances[0].priorEpisodeId).toBeDefined();
    expect(resonances[0].priorContent).toBe('debugging a frustrating auth bug');
    expect(resonances[0].semanticSimilarity).toBeGreaterThan(0.5);
    expect(resonances[0].timeDeltaDays).toBeGreaterThanOrEqual(0);
  });

  it('does not resonate with emotionally dissimilar episodes', async () => {
    await encodeEpisode(db, embedding, {
      content: 'debugging went really well today',
      source: 'direct-observation',
      affect: { valence: 0.8, arousal: 0.3, label: 'satisfaction' },
    });

    const newId = await encodeEpisode(db, embedding, {
      content: 'debugging went really well today',
      source: 'direct-observation',
      affect: { valence: -0.8, arousal: 0.9, label: 'rage' },
    });

    const resonances = await detectResonance(db, embedding, newId, {
      content: 'debugging went really well today',
      affect: { valence: -0.8, arousal: 0.9 },
    }, { threshold: 0.5, affectThreshold: 0.9 });

    expect(resonances).toEqual([]);
  });

  it('returns empty when affect is missing', async () => {
    const id = await encodeEpisode(db, embedding, {
      content: 'no affect memory',
      source: 'direct-observation',
    });
    const resonances = await detectResonance(db, embedding, id, {
      content: 'no affect memory',
    });
    expect(resonances).toEqual([]);
  });

  it('respects enabled=false', async () => {
    const resonances = await detectResonance(db, null, 'any', {
      content: 'test',
      affect: { valence: 0.5 },
    }, { enabled: false });
    expect(resonances).toEqual([]);
  });
});
