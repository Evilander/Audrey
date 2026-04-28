import Database from 'better-sqlite3';
import type { Affect, EmbeddingProvider, ResonanceConfig } from './types.js';

export interface ResonanceResult {
  priorEpisodeId: string;
  priorContent: string;
  priorAffect: Partial<Affect>;
  semanticSimilarity: number;
  emotionalSimilarity: number;
  timeDeltaDays: number;
  priorCreatedAt: string;
}

export function arousalSalienceBoost(arousal: number | undefined | null): number {
  if (arousal === undefined || arousal === null) return 0;
  // Inverted-U (Yerkes-Dodson): peaks at 0.7, Gaussian sigma=0.3
  return Math.exp(-Math.pow(arousal - 0.7, 2) / (2 * 0.3 * 0.3));
}

export function affectSimilarity(a: Partial<Affect> | null, b: Partial<Affect> | null): number {
  if (!a || !b) return 0;
  if (a.valence === undefined || b.valence === undefined) return 0;
  const valenceDist = Math.abs(a.valence - b.valence);
  const valenceSim = 1.0 - (valenceDist / 2.0);
  if (a.arousal === undefined || b.arousal === undefined) return valenceSim;
  const arousalSim = 1.0 - Math.abs(a.arousal - b.arousal);
  // Valence is primary (70%), arousal secondary (30%) per Bower 1981
  return 0.7 * valenceSim + 0.3 * arousalSim;
}

export function moodCongruenceModifier(
  encodingAffect: Partial<Affect> | null,
  retrievalMood: Partial<Affect> | null,
  weight = 0.2,
): number {
  if (!encodingAffect || !retrievalMood) return 1.0;
  const similarity = affectSimilarity(encodingAffect, retrievalMood);
  if (similarity === 0) return 1.0;
  return 1.0 + (weight * similarity);
}

export async function detectResonance(
  db: Database.Database,
  embeddingProvider: EmbeddingProvider,
  episodeId: string,
  params: { content: string; affect?: Affect },
  config: ResonanceConfig = {},
  embedding?: { vector?: number[]; buffer?: Buffer },
): Promise<ResonanceResult[]> {
  const { enabled = true, k = 5, threshold = 0.5, affectThreshold = 0.6 } = config;
  const { content, affect } = params;
  if (!enabled || !affect || affect.valence === undefined) return [];

  const buffer = embedding?.buffer ?? embeddingProvider.vectorToBuffer(
    embedding?.vector ?? await embeddingProvider.embed(content)
  );

  const matches = db.prepare(`
    SELECT e.*, (1.0 - v.distance) AS similarity
    FROM vec_episodes v
    JOIN episodes e ON e.id = v.id
    WHERE v.embedding MATCH ?
      AND k = ?
      AND e.id != ?
      AND e.superseded_by IS NULL
  `).all(buffer, k, episodeId) as Array<{ id: string; content: string; affect: string; similarity: number; created_at: string }>;

  const resonances: ResonanceResult[] = [];
  for (const match of matches) {
    if (match.similarity < threshold) continue;
    let priorAffect: Partial<Affect>;
    try { priorAffect = JSON.parse(match.affect || '{}'); } catch { continue; }
    if (priorAffect.valence === undefined) continue;

    const emotionalSimilarity = affectSimilarity(affect, priorAffect);
    if (emotionalSimilarity < affectThreshold) continue;

    resonances.push({
      priorEpisodeId: match.id,
      priorContent: match.content,
      priorAffect,
      semanticSimilarity: match.similarity,
      emotionalSimilarity,
      timeDeltaDays: Math.floor((Date.now() - new Date(match.created_at).getTime()) / 86400000),
      priorCreatedAt: match.created_at,
    });
  }

  return resonances;
}
