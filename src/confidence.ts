import type { ConfidenceWeights, HalfLives, SourceReliabilityMap, ComputeConfidenceParams } from './types.js';

export const DEFAULT_SOURCE_RELIABILITY: SourceReliabilityMap = {
  'direct-observation': 0.95,
  'told-by-user': 0.90,
  'tool-result': 0.85,
  'inference': 0.60,
  'model-generated': 0.40,
};

export const DEFAULT_WEIGHTS: ConfidenceWeights = {
  source: 0.30,
  evidence: 0.35,
  recency: 0.20,
  retrieval: 0.15,
};

export const DEFAULT_HALF_LIVES: HalfLives = {
  episodic: 7,
  semantic: 30,
  procedural: 90,
};

export const MODEL_GENERATED_CONFIDENCE_CAP: number = 0.6;

export function sourceReliability(sourceType: string, customReliability?: SourceReliabilityMap): number {
  const table = customReliability || DEFAULT_SOURCE_RELIABILITY;
  const value = table[sourceType];
  if (value === undefined) {
    throw new Error(`Unknown source type: ${sourceType}. Valid types: ${Object.keys(table).join(', ')}`);
  }
  return value;
}

export function evidenceAgreement(supportingCount: number, contradictingCount: number): number {
  const total = supportingCount + contradictingCount;
  if (total === 0) return 1.0;
  return supportingCount / total;
}

export function recencyDecay(ageDays: number, halfLifeDays: number): number {
  if (!(halfLifeDays > 0)) {
    throw new RangeError(`recencyDecay: halfLifeDays must be > 0 (got ${halfLifeDays})`);
  }
  const lambda = Math.LN2 / halfLifeDays;
  return Math.exp(-lambda * ageDays);
}

export function retrievalReinforcement(retrievalCount: number, daysSinceRetrieval: number): number {
  if (retrievalCount === 0) return 0;
  const lambdaRet = Math.LN2 / 14;
  const baseReinforcement = 0.3 * Math.log(1 + retrievalCount);
  const recencyWeight = Math.exp(-lambdaRet * daysSinceRetrieval);
  const spacedBonus = Math.min(0.15, 0.02 * Math.log(1 + daysSinceRetrieval));
  return Math.min(1.0, baseReinforcement * recencyWeight + spacedBonus);
}

export function salienceModifier(salience?: number | null): number {
  const s = salience ?? 0.5;
  return 0.5 + s;
}

export function computeConfidence({
  sourceType,
  supportingCount,
  contradictingCount,
  ageDays,
  halfLifeDays,
  retrievalCount,
  daysSinceRetrieval,
  weights,
  customSourceReliability,
}: ComputeConfidenceParams): number {
  const w = weights || DEFAULT_WEIGHTS;

  const s = sourceReliability(sourceType, customSourceReliability);
  const e = evidenceAgreement(supportingCount, contradictingCount);
  const r = recencyDecay(ageDays, halfLifeDays);
  const ret = retrievalReinforcement(retrievalCount, daysSinceRetrieval);

  let confidence = w.source * s + w.evidence * e + w.recency * r + w.retrieval * ret;

  if (sourceType === 'model-generated') {
    confidence = Math.min(confidence, MODEL_GENERATED_CONFIDENCE_CAP);
  }

  return Math.max(0, Math.min(1, confidence));
}
