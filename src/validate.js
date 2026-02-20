import { generateId } from './ulid.js';
import { safeJsonParse } from './utils.js';
import { buildContradictionDetectionPrompt } from './prompts.js';

const REINFORCEMENT_THRESHOLD = 0.85;
const CONTRADICTION_THRESHOLD = 0.60;

/**
 * @param {import('better-sqlite3').Database} db
 * @param {import('./embedding.js').EmbeddingProvider} embeddingProvider
 * @param {{ id: string, content: string, source: string }} episode
 * @param {{ threshold?: number, contradictionThreshold?: number, llmProvider?: { json: (messages: any) => Promise<any> } }} [options]
 * @returns {Promise<{ action: string, semanticId?: string, similarity?: number, contradictionId?: string, resolution?: string }>}
 */
export async function validateMemory(db, embeddingProvider, episode, options = {}) {
  const {
    threshold = REINFORCEMENT_THRESHOLD,
    contradictionThreshold = CONTRADICTION_THRESHOLD,
    llmProvider,
  } = options;

  const episodeVector = await embeddingProvider.embed(episode.content);
  const episodeBuffer = embeddingProvider.vectorToBuffer(episodeVector);

  const nearestSemantic = db.prepare(`
    SELECT s.*, (1.0 - v.distance) AS similarity
    FROM vec_semantics v
    JOIN semantics s ON s.id = v.id
    WHERE v.embedding MATCH ?
      AND k = 1
      AND (v.state = 'active' OR v.state = 'context_dependent')
  `).get(episodeBuffer);

  let bestMatch = null;
  let bestSimilarity = 0;

  if (nearestSemantic) {
    bestMatch = nearestSemantic;
    bestSimilarity = nearestSemantic.similarity;
  }

  if (bestMatch && bestSimilarity >= threshold) {
    const evidenceIds = safeJsonParse(bestMatch.evidence_episode_ids, []);
    if (!evidenceIds.includes(episode.id)) {
      evidenceIds.push(episode.id);
    }

    const diversity = computeSourceDiversity(db, evidenceIds, episode);

    const now = new Date().toISOString();
    db.prepare(`
      UPDATE semantics SET
        supporting_count = supporting_count + 1,
        evidence_episode_ids = ?,
        evidence_count = ?,
        source_type_diversity = ?,
        last_reinforced_at = ?
      WHERE id = ?
    `).run(
      JSON.stringify(evidenceIds),
      evidenceIds.length,
      diversity,
      now,
      bestMatch.id,
    );

    return {
      action: 'reinforced',
      semanticId: bestMatch.id,
      similarity: bestSimilarity,
    };
  }

  if (bestMatch && bestSimilarity >= contradictionThreshold && llmProvider) {
    const messages = buildContradictionDetectionPrompt(episode.content, bestMatch.content);
    const verdict = await llmProvider.json(messages);

    if (verdict.contradicts) {
      const resolution = verdict.resolution === 'context_dependent'
        ? { type: 'context_dependent', conditions: verdict.conditions, explanation: verdict.explanation }
        : verdict.resolution
          ? { type: verdict.resolution, explanation: verdict.explanation }
          : null;

      const contradictionId = createContradiction(
        db,
        bestMatch.id,
        'semantic',
        episode.id,
        'episodic',
        resolution,
      );

      if (verdict.resolution === 'new_wins') {
        db.prepare("UPDATE semantics SET state = 'disputed' WHERE id = ?").run(bestMatch.id);
      } else if (verdict.resolution === 'context_dependent' && verdict.conditions) {
        db.prepare("UPDATE semantics SET state = 'context_dependent', conditions = ? WHERE id = ?")
          .run(JSON.stringify(verdict.conditions), bestMatch.id);
      }

      return {
        action: 'contradiction',
        contradictionId,
        semanticId: bestMatch.id,
        similarity: bestSimilarity,
        resolution: verdict.resolution || null,
      };
    }
  }

  return { action: 'none' };
}

function computeSourceDiversity(db, evidenceIds, currentEpisode) {
  const sourceTypes = new Set();
  sourceTypes.add(currentEpisode.source);

  if (evidenceIds.length > 0) {
    const placeholders = evidenceIds.map(() => '?').join(',');
    const rows = db.prepare(
      `SELECT DISTINCT source FROM episodes WHERE id IN (${placeholders})`
    ).all(...evidenceIds);
    for (const row of rows) {
      sourceTypes.add(row.source);
    }
  }

  return sourceTypes.size;
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} claimAId
 * @param {string} claimAType
 * @param {string} claimBId
 * @param {string} claimBType
 * @param {object|null} resolution
 * @returns {string}
 */
export function createContradiction(db, claimAId, claimAType, claimBId, claimBType, resolution) {
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

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} contradictionId
 * @param {string} newEvidenceId
 * @returns {void}
 */
export function reopenContradiction(db, contradictionId, newEvidenceId) {
  const now = new Date().toISOString();
  db.prepare(`
    UPDATE contradictions SET
      state = 'reopened',
      reopen_evidence_id = ?,
      reopened_at = ?
    WHERE id = ?
  `).run(newEvidenceId, now, contradictionId);
}
