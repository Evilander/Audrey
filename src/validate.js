import { generateId } from './ulid.js';
import { cosineSimilarity, safeJsonParse } from './utils.js';

const REINFORCEMENT_THRESHOLD = 0.85;

/**
 * Validate a new episodic memory against existing semantic memories.
 * If similarity >= threshold, reinforce the matching semantic memory.
 * Returns { action: 'reinforced' | 'contradiction' | 'none', semanticId?, similarity? }
 */
export async function validateMemory(db, embeddingProvider, episode, options = {}) {
  const { threshold = REINFORCEMENT_THRESHOLD } = options;

  const episodeVector = await embeddingProvider.embed(episode.content);
  const episodeBuffer = embeddingProvider.vectorToBuffer(episodeVector);

  // Scan all active semantic memories for similarity
  const semantics = db.prepare(
    "SELECT * FROM semantics WHERE state IN ('active', 'context_dependent') AND embedding IS NOT NULL"
  ).all();

  let bestMatch = null;
  let bestSimilarity = 0;

  for (const sem of semantics) {
    const similarity = cosineSimilarity(episodeBuffer, sem.embedding, embeddingProvider);
    if (similarity > bestSimilarity) {
      bestSimilarity = similarity;
      bestMatch = sem;
    }
  }

  if (bestMatch && bestSimilarity >= threshold) {
    // Reinforce: increment supporting_count, add episode id to evidence list
    const evidenceIds = safeJsonParse(bestMatch.evidence_episode_ids, []);
    if (!evidenceIds.includes(episode.id)) {
      evidenceIds.push(episode.id);
    }

    // Compute source_type_diversity: count distinct source types across all evidence episodes
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

  return { action: 'none' };
}

/**
 * Count distinct source types across evidence episodes.
 * Looks up episodes in the DB plus the incoming episode's source.
 */
function computeSourceDiversity(db, evidenceIds, currentEpisode) {
  const sourceTypes = new Set();

  // Add the current episode's source type
  sourceTypes.add(currentEpisode.source);

  // Look up existing episodes' source types
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
 * Create a contradiction record between two claims.
 * If resolution is provided, the contradiction is immediately resolved.
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
 * Reopen a previously resolved contradiction with new evidence.
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
