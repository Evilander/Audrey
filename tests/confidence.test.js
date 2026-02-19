import { describe, it, expect } from 'vitest';
import {
  computeConfidence,
  sourceReliability,
  evidenceAgreement,
  recencyDecay,
  retrievalReinforcement,
  DEFAULT_WEIGHTS,
  DEFAULT_SOURCE_RELIABILITY,
  DEFAULT_HALF_LIVES,
} from '../src/confidence.js';

describe('sourceReliability', () => {
  it('returns 0.95 for direct-observation', () => {
    expect(sourceReliability('direct-observation')).toBe(0.95);
  });

  it('returns 0.40 for model-generated', () => {
    expect(sourceReliability('model-generated')).toBe(0.40);
  });

  it('throws for unknown source type', () => {
    expect(() => sourceReliability('unknown')).toThrow();
  });
});

describe('evidenceAgreement', () => {
  it('returns 1.0 when all evidence supports', () => {
    expect(evidenceAgreement(5, 0)).toBe(1.0);
  });

  it('returns 0.5 when evidence is split', () => {
    expect(evidenceAgreement(3, 3)).toBe(0.5);
  });

  it('returns 0.0 when no supporting evidence', () => {
    expect(evidenceAgreement(0, 3)).toBe(0.0);
  });

  it('returns 1.0 when both are 0 (no contradictions = full agreement)', () => {
    expect(evidenceAgreement(0, 0)).toBe(1.0);
  });
});

describe('recencyDecay', () => {
  it('returns 1.0 at time zero', () => {
    expect(recencyDecay(0, 7)).toBeCloseTo(1.0);
  });

  it('returns ~0.5 at the half-life', () => {
    expect(recencyDecay(7, 7)).toBeCloseTo(0.5, 1);
  });

  it('returns ~0.25 at double the half-life', () => {
    expect(recencyDecay(14, 7)).toBeCloseTo(0.25, 1);
  });

  it('approaches 0 for very old memories', () => {
    expect(recencyDecay(365, 7)).toBeLessThan(0.001);
  });
});

describe('retrievalReinforcement', () => {
  it('returns 0 when never retrieved', () => {
    expect(retrievalReinforcement(0, 0)).toBe(0);
  });

  it('increases with retrieval count', () => {
    const a = retrievalReinforcement(1, 0);
    const b = retrievalReinforcement(5, 0);
    expect(b).toBeGreaterThan(a);
  });

  it('decays with time since last retrieval', () => {
    const fresh = retrievalReinforcement(3, 0);
    const stale = retrievalReinforcement(3, 30);
    expect(fresh).toBeGreaterThan(stale);
  });

  it('never exceeds 1.0', () => {
    expect(retrievalReinforcement(1000, 0)).toBeLessThanOrEqual(1.0);
  });
});

describe('computeConfidence', () => {
  it('computes composite confidence from all components', () => {
    const result = computeConfidence({
      sourceType: 'direct-observation',
      supportingCount: 3,
      contradictingCount: 0,
      ageDays: 0,
      halfLifeDays: 7,
      retrievalCount: 0,
      daysSinceRetrieval: 0,
    });
    // w_s*0.95 + w_e*1.0 + w_r*1.0 + w_ret*0
    // 0.30*0.95 + 0.35*1.0 + 0.20*1.0 + 0.15*0
    // = 0.285 + 0.35 + 0.20 + 0 = 0.835
    expect(result).toBeCloseTo(0.835, 2);
  });

  it('returns lower confidence for model-generated source', () => {
    const high = computeConfidence({
      sourceType: 'direct-observation',
      supportingCount: 1, contradictingCount: 0,
      ageDays: 0, halfLifeDays: 7,
      retrievalCount: 0, daysSinceRetrieval: 0,
    });
    const low = computeConfidence({
      sourceType: 'model-generated',
      supportingCount: 1, contradictingCount: 0,
      ageDays: 0, halfLifeDays: 7,
      retrievalCount: 0, daysSinceRetrieval: 0,
    });
    expect(high).toBeGreaterThan(low);
  });

  it('caps model-generated confidence at 0.6', () => {
    const result = computeConfidence({
      sourceType: 'model-generated',
      supportingCount: 100, contradictingCount: 0,
      ageDays: 0, halfLifeDays: 30,
      retrievalCount: 100, daysSinceRetrieval: 0,
    });
    expect(result).toBeLessThanOrEqual(0.6);
  });

  it('decays over time', () => {
    const fresh = computeConfidence({
      sourceType: 'direct-observation',
      supportingCount: 1, contradictingCount: 0,
      ageDays: 0, halfLifeDays: 7,
      retrievalCount: 0, daysSinceRetrieval: 0,
    });
    const old = computeConfidence({
      sourceType: 'direct-observation',
      supportingCount: 1, contradictingCount: 0,
      ageDays: 30, halfLifeDays: 7,
      retrievalCount: 0, daysSinceRetrieval: 0,
    });
    expect(fresh).toBeGreaterThan(old);
  });

  it('allows custom weights', () => {
    const result = computeConfidence({
      sourceType: 'direct-observation',
      supportingCount: 1, contradictingCount: 0,
      ageDays: 0, halfLifeDays: 7,
      retrievalCount: 0, daysSinceRetrieval: 0,
      weights: { source: 1.0, evidence: 0, recency: 0, retrieval: 0 },
    });
    expect(result).toBeCloseTo(0.95, 2);
  });
});
