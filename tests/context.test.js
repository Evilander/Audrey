import { describe, it, expect } from 'vitest';
import { contextMatchRatio, contextModifier } from '../dist/src/context.js';

describe('contextMatchRatio', () => {
  it('returns 0 when encodingContext is null', () => {
    expect(contextMatchRatio(null, { task: 'debug' })).toBe(0);
  });

  it('returns 0 when retrievalContext is null', () => {
    expect(contextMatchRatio({ task: 'debug' }, null)).toBe(0);
  });

  it('returns 0 when retrievalContext is empty', () => {
    expect(contextMatchRatio({ task: 'debug' }, {})).toBe(0);
  });

  it('returns 0 when no shared keys', () => {
    expect(contextMatchRatio({ task: 'debug' }, { domain: 'payments' })).toBe(0);
  });

  it('returns 1.0 when all retrieval keys match', () => {
    expect(contextMatchRatio(
      { task: 'debug', domain: 'payments' },
      { task: 'debug', domain: 'payments' },
    )).toBe(1.0);
  });

  it('returns 0.5 when half of retrieval keys match', () => {
    expect(contextMatchRatio(
      { task: 'debug', domain: 'payments' },
      { task: 'debug', domain: 'billing' },
    )).toBe(0.5);
  });

  it('divides by retrieval keys, not shared keys', () => {
    expect(contextMatchRatio(
      { task: 'debug' },
      { task: 'debug', domain: 'payments' },
    )).toBe(0.5);
  });

  it('returns 0 when shared keys all mismatch', () => {
    expect(contextMatchRatio(
      { task: 'debug' },
      { task: 'deploy' },
    )).toBe(0);
  });
});

describe('contextModifier', () => {
  it('returns 1.0 when no context provided', () => {
    expect(contextModifier(null, null)).toBe(1.0);
    expect(contextModifier({}, {})).toBe(1.0);
    expect(contextModifier(null, { task: 'debug' })).toBe(1.0);
  });

  it('returns 1.0 + weight when all keys match (default weight 0.3)', () => {
    expect(contextModifier(
      { task: 'debug' },
      { task: 'debug' },
    )).toBeCloseTo(1.3);
  });

  it('returns 1.0 when no keys match', () => {
    expect(contextModifier(
      { task: 'debug' },
      { task: 'deploy' },
    )).toBeCloseTo(1.0);
  });

  it('returns partial boost for partial match', () => {
    const result = contextModifier(
      { task: 'debug', domain: 'payments' },
      { task: 'debug', domain: 'billing' },
    );
    expect(result).toBeCloseTo(1.15);
  });

  it('respects custom weight', () => {
    expect(contextModifier(
      { task: 'debug' },
      { task: 'debug' },
      0.5,
    )).toBeCloseTo(1.5);
  });

  it('returns 1.0 for empty encoding context', () => {
    expect(contextModifier({}, { task: 'debug' })).toBe(1.0);
  });
});
