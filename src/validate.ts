import Database from 'better-sqlite3';
import type { EmbeddingProvider, LLMProvider, SemanticRow } from './types.js';
import { generateId } from './ulid.js';
import { safeJsonParse } from './utils.js';
import { buildContradictionDetectionPrompt } from './prompts.js';

const REINFORCEMENT_THRESHOLD = 0.85;
const CONTRADICTION_THRESHOLD = 0.60;

interface SemanticWithSimilarity extends SemanticRow {
  similarity: number;
}

interface SourceRow {
  source: string;
}

interface ValidateResult {
  action: string;
  semanticId?: string;
  similarity?: number;
  contradictionId?: string;
  resolution?: string | null;
}

export async function validateMemory(
  db: Database.Database,
  embeddingProvider: EmbeddingProvider,
  episode: { id: string; content: string; source: string },
  options: {
    threshold?: number;
    contradictionThreshold?: number;
    llmProvider?: LLMProvider | null;
    embeddingVector?: number[];
    embeddingBuffer?: Buffer;
  } = {},
): Promise<ValidateResult> {
  const {
    threshold = REINFORCEMENT_THRESHOLD,
    contradictionThreshold = CONTRADICTION_THRESHOLD,
    llmProvider,
    embeddingVector,
    embeddingBuffer,
  } = options;

  const episodeBuffer = embeddingBuffer ?? embeddingProvider.vectorToBuffer(
    embeddingVector ?? await embeddingProvider.embed(episode.content)
  );

  const nearestSemantic = db.prepare(`
    SELECT s.*, (1.0 - v.distance) AS similarity
    FROM vec_semantics v
    JOIN semantics s ON s.id = v.id
    WHERE v.embedding MATCH ?
      AND k = 1
      AND (v.state = 'active' OR v.state = 'context_dependent')
  `).get(episodeBuffer) as SemanticWithSimilarity | undefined;

  let bestMatch: SemanticWithSimilarity | null = null;
  let bestSimilarity = 0;

  if (nearestSemantic) {
    bestMatch = nearestSemantic;
    bestSimilarity = nearestSemantic.similarity;
  }

  if (bestMatch && bestSimilarity >= threshold) {
    const matchId = bestMatch.id;
    const reinforce = db.transaction(() => {
      // Re-read evidence inside the transaction to avoid lost updates under concurrency.
      const current = db.prepare(
        'SELECT evidence_episode_ids FROM semantics WHERE id = ?',
      ).get(matchId) as { evidence_episode_ids: string | null } | undefined;
      const existing = safeJsonParse<string[]>(
        current?.evidence_episode_ids ?? null,
        [],
      );
      const wasAdded = !existing.includes(episode.id);
      if (wasAdded) {
        existing.push(episode.id);
      }
      const diversity = computeSourceDiversity(db, existing, episode);
      const now = new Date().toISOString();
      // supporting_count only increments when this is a new piece of evidence;
      // re-validating the same episode shouldn't keep inflating the count.
      db.prepare(`
        UPDATE semantics SET
          supporting_count = supporting_count + ?,
          evidence_episode_ids = ?,
          evidence_count = ?,
          source_type_diversity = ?,
          last_reinforced_at = ?
        WHERE id = ?
      `).run(
        wasAdded ? 1 : 0,
        JSON.stringify(existing),
        existing.length,
        diversity,
        now,
        matchId,
      );
    });
    reinforce();

    return {
      action: 'reinforced',
      semanticId: matchId,
      similarity: bestSimilarity,
    };
  }

  if (bestMatch && bestSimilarity >= contradictionThreshold && llmProvider) {
    const messages = buildContradictionDetectionPrompt(episode.content, bestMatch.content);
    const raw = await llmProvider.json(messages);
    if (!raw || typeof raw !== 'object') {
      throw new Error('Contradiction LLM response must be a JSON object');
    }
    const candidate = raw as Record<string, unknown>;
    if (typeof candidate.contradicts !== 'boolean') {
      throw new Error('Contradiction LLM response missing boolean "contradicts" field');
    }
    const verdict: {
      contradicts: boolean;
      resolution?: string;
      conditions?: Record<string, string>;
      explanation?: string;
    } = {
      contradicts: candidate.contradicts,
      resolution: typeof candidate.resolution === 'string' ? candidate.resolution : undefined,
      conditions:
        candidate.conditions &&
        typeof candidate.conditions === 'object' &&
        !Array.isArray(candidate.conditions) &&
        Object.values(candidate.conditions).every((v) => typeof v === 'string')
          ? (candidate.conditions as Record<string, string>)
          : undefined,
      explanation: typeof candidate.explanation === 'string' ? candidate.explanation : undefined,
    };

    if (verdict.contradicts) {
      const matchId = bestMatch.id;
      const resolution = verdict.resolution === 'context_dependent'
        ? { type: 'context_dependent', conditions: verdict.conditions, explanation: verdict.explanation }
        : verdict.resolution
          ? { type: verdict.resolution, explanation: verdict.explanation }
          : null;

      let contradictionId = '';
      const recordContradiction = db.transaction(() => {
        contradictionId = createContradiction(
          db,
          matchId,
          'semantic',
          episode.id,
          'episodic',
          resolution,
        );
        if (verdict.resolution === 'new_wins') {
          db.prepare("UPDATE semantics SET state = 'disputed' WHERE id = ?").run(matchId);
        } else if (verdict.resolution === 'context_dependent' && verdict.conditions) {
          db.prepare("UPDATE semantics SET state = 'context_dependent', conditions = ? WHERE id = ?")
            .run(JSON.stringify(verdict.conditions), matchId);
        }
      });
      recordContradiction();

      return {
        action: 'contradiction',
        contradictionId,
        semanticId: matchId,
        similarity: bestSimilarity,
        resolution: verdict.resolution || null,
      };
    }
  }

  return { action: 'none' };
}

function computeSourceDiversity(
  db: Database.Database,
  evidenceIds: string[],
  currentEpisode: { source: string },
): number {
  const sourceTypes = new Set<string>();
  sourceTypes.add(currentEpisode.source);

  if (evidenceIds.length > 0) {
    const placeholders = evidenceIds.map(() => '?').join(',');
    const rows = db.prepare(
      `SELECT DISTINCT source FROM episodes WHERE id IN (${placeholders})`
    ).all(...evidenceIds) as SourceRow[];
    for (const row of rows) {
      sourceTypes.add(row.source);
    }
  }

  return sourceTypes.size;
}

export function createContradiction(
  db: Database.Database,
  claimAId: string,
  claimAType: string,
  claimBId: string,
  claimBType: string,
  resolution: object | null,
): string {
  const id = generateId();
  const now = new Date().toISOString();

  const state = resolution ? 'resolved' : 'open';
  const resolvedAt = resolution ? now : null;
  const resolutionJson = resolution ? JSON.stringify(resolution) : null;

  db.prepare(`
    INSERT INTO contradictions (id, claim_a_id, claim_a_type, claim_b_id, claim_b_type,
      state, resolution, resolved_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, claimAId, claimAType, claimBId, claimBType, state, resolutionJson, resolvedAt, now);

  return id;
}

export function reopenContradiction(db: Database.Database, contradictionId: string, newEvidenceId: string): void {
  const now = new Date().toISOString();
  db.prepare(`
    UPDATE contradictions SET
      state = 'reopened',
      reopen_evidence_id = ?,
      reopened_at = ?
    WHERE id = ?
  `).run(newEvidenceId, now, contradictionId);
}
