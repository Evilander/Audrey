import type {
  ConfidenceConfig,
  EpisodeRow,
  SemanticRow,
  ProceduralRow,
  RecallResult,
} from './types.js';
import { computeConfidence, DEFAULT_HALF_LIVES, salienceModifier } from './confidence.js';
import { interferenceModifier } from './interference.js';
import { contextMatchRatio, contextModifier } from './context.js';
import { moodCongruenceModifier, affectSimilarity } from './affect.js';
import { daysBetween, safeJsonParse } from './utils.js';

type ProceduralConfidenceRow = ProceduralRow & { source_type_diversity?: number };

export interface RecallScoringOptions {
  now?: Date;
  confidenceConfig?: Partial<ConfidenceConfig>;
  includeProvenance?: boolean;
}

function computeEpisodicConfidence(
  ep: EpisodeRow,
  now: Date,
  confidenceConfig: Partial<ConfidenceConfig> = {},
): number {
  const ageDays = daysBetween(ep.created_at, now);
  const halfLives = confidenceConfig.halfLives || DEFAULT_HALF_LIVES;
  let confidence = computeConfidence({
    sourceType: ep.source,
    supportingCount: 1,
    contradictingCount: 0,
    ageDays,
    halfLifeDays: halfLives.episodic ?? DEFAULT_HALF_LIVES.episodic,
    retrievalCount: 0,
    daysSinceRetrieval: ageDays,
    weights: confidenceConfig.weights,
    customSourceReliability: confidenceConfig.sourceReliability,
  });
  confidence *= salienceModifier(ep.salience);
  return Math.max(0, Math.min(1, confidence));
}

function computeSemanticConfidence(
  sem: SemanticRow,
  now: Date,
  confidenceConfig: Partial<ConfidenceConfig> = {},
): number {
  const ageDays = daysBetween(sem.created_at, now);
  const daysSinceRetrieval = sem.last_reinforced_at
    ? daysBetween(sem.last_reinforced_at, now)
    : ageDays;
  const halfLives = confidenceConfig.halfLives || DEFAULT_HALF_LIVES;
  let confidence = computeConfidence({
    sourceType: 'tool-result',
    supportingCount: sem.supporting_count || 0,
    contradictingCount: sem.contradicting_count || 0,
    ageDays,
    halfLifeDays: halfLives.semantic ?? DEFAULT_HALF_LIVES.semantic,
    retrievalCount: sem.retrieval_count || 0,
    daysSinceRetrieval,
    weights: confidenceConfig.weights,
    customSourceReliability: confidenceConfig.sourceReliability,
    sourceTypeDiversity: sem.source_type_diversity,
    sourceDiversityWeight: confidenceConfig.sourceDiversityWeight,
  });
  confidence *= interferenceModifier(
    sem.interference_count || 0,
    confidenceConfig.interferenceWeight,
  );
  confidence *= salienceModifier(sem.salience);
  return Math.max(0, Math.min(1, confidence));
}

function computeProceduralConfidence(
  proc: ProceduralConfidenceRow,
  now: Date,
  confidenceConfig: Partial<ConfidenceConfig> = {},
): number {
  const ageDays = daysBetween(proc.created_at, now);
  const daysSinceRetrieval = proc.last_reinforced_at
    ? daysBetween(proc.last_reinforced_at, now)
    : ageDays;
  const halfLives = confidenceConfig.halfLives || DEFAULT_HALF_LIVES;
  let confidence = computeConfidence({
    sourceType: 'tool-result',
    supportingCount: proc.success_count || 0,
    contradictingCount: proc.failure_count || 0,
    ageDays,
    halfLifeDays: halfLives.procedural ?? DEFAULT_HALF_LIVES.procedural,
    retrievalCount: proc.retrieval_count || 0,
    daysSinceRetrieval,
    weights: confidenceConfig.weights,
    customSourceReliability: confidenceConfig.sourceReliability,
    sourceTypeDiversity: proc.source_type_diversity,
    sourceDiversityWeight: confidenceConfig.sourceDiversityWeight,
  });
  confidence *= interferenceModifier(
    proc.interference_count || 0,
    confidenceConfig.interferenceWeight,
  );
  confidence *= salienceModifier(proc.salience);
  return Math.max(0, Math.min(1, confidence));
}

function buildEpisodicEntry(
  ep: EpisodeRow,
  confidence: number,
  score: number,
  includeProvenance: boolean,
  contextMatch?: number,
  moodCongruence?: number,
): RecallResult {
  const entry: RecallResult = {
    id: ep.id,
    content: ep.content,
    type: 'episodic',
    confidence,
    score,
    source: ep.source,
    agent: ep.agent ?? 'default',
    createdAt: ep.created_at,
  };
  if (contextMatch !== undefined) {
    entry.contextMatch = contextMatch;
  }
  if (moodCongruence !== undefined) {
    entry.moodCongruence = moodCongruence;
  }
  if (includeProvenance) {
    entry.provenance = {
      source: ep.source,
      sourceReliability: ep.source_reliability,
      createdAt: ep.created_at,
      supersedes: ep.supersedes || null,
    };
  }
  return entry;
}

function buildSemanticEntry(
  sem: SemanticRow,
  confidence: number,
  score: number,
  includeProvenance: boolean,
): RecallResult {
  const entry: RecallResult = {
    id: sem.id,
    content: sem.content,
    type: 'semantic',
    confidence,
    score,
    source: 'consolidation',
    agent: sem.agent ?? 'default',
    state: sem.state,
    createdAt: sem.created_at,
  };
  if (includeProvenance) {
    entry.provenance = {
      evidenceEpisodeIds: safeJsonParse<string[]>(sem.evidence_episode_ids, []),
      evidenceCount: sem.evidence_count || 0,
      supportingCount: sem.supporting_count || 0,
      contradictingCount: sem.contradicting_count || 0,
      consolidationCheckpoint: sem.consolidation_checkpoint || null,
    };
  }
  return entry;
}

function buildProceduralEntry(
  proc: ProceduralConfidenceRow,
  confidence: number,
  score: number,
  includeProvenance: boolean,
): RecallResult {
  const entry: RecallResult = {
    id: proc.id,
    content: proc.content,
    type: 'procedural',
    confidence,
    score,
    source: 'consolidation',
    agent: proc.agent ?? 'default',
    state: proc.state,
    createdAt: proc.created_at,
  };
  if (includeProvenance) {
    entry.provenance = {
      evidenceEpisodeIds: safeJsonParse<string[]>(proc.evidence_episode_ids, []),
      successCount: proc.success_count || 0,
      failureCount: proc.failure_count || 0,
      triggerConditions: proc.trigger_conditions || null,
    };
  }
  return entry;
}

export function scoreEpisodicRow(
  row: EpisodeRow,
  similarity: number,
  { now = new Date(), confidenceConfig = {}, includeProvenance = false }: RecallScoringOptions = {},
): RecallResult {
  let confidence = computeEpisodicConfidence(row, now, confidenceConfig);

  let ctxMatch: number | undefined;
  if (confidenceConfig?.retrievalContext) {
    const encodingCtx = safeJsonParse<Record<string, string>>(row.context, {});
    ctxMatch = contextMatchRatio(encodingCtx, confidenceConfig.retrievalContext);
    confidence *= contextModifier(
      encodingCtx,
      confidenceConfig.retrievalContext,
      confidenceConfig.contextWeight,
    );
    confidence = Math.max(0, Math.min(1, confidence));
  }

  let moodMatch: number | undefined;
  if (confidenceConfig?.retrievalMood) {
    const encodingAffect = safeJsonParse<{ valence?: number; arousal?: number }>(row.affect, {});
    moodMatch = affectSimilarity(encodingAffect, confidenceConfig.retrievalMood);
    confidence *= moodCongruenceModifier(
      encodingAffect,
      confidenceConfig.retrievalMood,
      confidenceConfig.affectWeight,
    );
    confidence = Math.max(0, Math.min(1, confidence));
  }

  return buildEpisodicEntry(
    row,
    confidence,
    similarity * confidence,
    includeProvenance,
    ctxMatch,
    moodMatch,
  );
}

export function scoreSemanticRow(
  row: SemanticRow,
  similarity: number,
  { now = new Date(), confidenceConfig = {}, includeProvenance = false }: RecallScoringOptions = {},
): RecallResult {
  const confidence = computeSemanticConfidence(row, now, confidenceConfig);
  return buildSemanticEntry(row, confidence, similarity * confidence, includeProvenance);
}

export function scoreProceduralRow(
  row: ProceduralConfidenceRow,
  similarity: number,
  { now = new Date(), confidenceConfig = {}, includeProvenance = false }: RecallScoringOptions = {},
): RecallResult {
  const confidence = computeProceduralConfidence(row, now, confidenceConfig);
  return buildProceduralEntry(row, confidence, similarity * confidence, includeProvenance);
}
