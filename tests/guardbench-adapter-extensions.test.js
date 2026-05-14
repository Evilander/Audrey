import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { validateSchema } from '../benchmarks/validate-guardbench-artifacts.mjs';
import { validateAdapterResult } from '../benchmarks/guardbench.js';

const summarySchema = JSON.parse(readFileSync('benchmarks/schemas/guardbench-summary.schema.json', 'utf-8'));

function adapterResult(overrides = {}) {
  return {
    decision: 'warn',
    riskScore: 0.5,
    evidenceIds: ['mem-1'],
    recommendedActions: ['Review remembered procedure.'],
    summary: 'Adapter found a remembered procedure.',
    ...overrides,
  };
}

describe('GuardBench adapter extension evidence', () => {
  it('preserves unknown adapter fields under adapterExtensions', () => {
    const normalized = validateAdapterResult(adapterResult({
      probe_method: 'indirect',
      revealed_dimensions: ['COMP', 'EXPL'],
      gap_score: 0.42,
    }), 'Moriarty Probe', 'GB-02');

    expect(normalized.adapterExtensions).toEqual({
      probe_method: 'indirect',
      revealed_dimensions: ['COMP', 'EXPL'],
      gap_score: 0.42,
    });
  });

  it('merges explicit adapterExtensions with top-level extension fields', () => {
    const normalized = validateAdapterResult(adapterResult({
      adapterExtensions: {
        probe: {
          method: 'substrate-read',
          dimensions: ['COMP'],
        },
      },
      gap_score: 0.7,
    }), 'Moriarty Probe', 'GB-03');

    expect(normalized.adapterExtensions).toEqual({
      probe: {
        method: 'substrate-read',
        dimensions: ['COMP'],
      },
      gap_score: 0.7,
    });
  });

  it('rejects non-JSON extension values instead of serializing ambiguous evidence', () => {
    expect(() => validateAdapterResult(adapterResult({
      probe: () => null,
    }), 'Moriarty Probe', 'GB-04')).toThrow(/adapter extension probe must be JSON-serializable/);

    expect(() => validateAdapterResult(adapterResult({
      adapterExtensions: [],
    }), 'Moriarty Probe', 'GB-04')).toThrow(/adapterExtensions must be a plain object when present/);
  });

  it('allows extension evidence in published GuardBench result rows', () => {
    const errors = validateSchema({
      system: 'Moriarty Probe',
      external: true,
      id: 'GB-02',
      name: 'Required preflight procedure missing',
      expectedDecision: 'block',
      decision: 'warn',
      decisionCorrect: false,
      riskScore: 0.5,
      passed: false,
      latencyMs: 12.3,
      evidenceCount: 1,
      evidenceIds: ['mem-1'],
      recommendedActions: ['Review remembered procedure.'],
      summary: 'Adapter surfaced a probe disagreement.',
      recallErrors: [],
      adapterExtensions: {
        probe: {
          method: 'substrate-read',
          dimensions: ['COMP'],
        },
        gap_score: 0.7,
      },
      leakedSecrets: [],
      requiredEvidenceMatched: true,
    }, summarySchema.$defs.resultRow, 'resultRow', summarySchema);

    expect(errors).toEqual([]);
  });
});
