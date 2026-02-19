import { generateId } from './ulid.js';
import { cosineSimilarity, safeJsonParse } from './utils.js';
import { buildContradictionDetectionPrompt } from './prompts.js';

const REINFORCEMENT_THRESHOLD = 0.85;
const CONTRADICTION_THRESHOLD = 0.60;

export async function validateMemory(db, embeddingProvider, episode, options = {}) {
  const {
    threshold = REINFORCEMENT_THRESHOLD,
    contradictionThreshold = CONTRADICTION_THRESHOLD,
    llmProvider,
  } = options;

  const episodeVector = await embeddingProvider.embed(episode.content);
  const episodeBuffer = embeddingProvider.vectorToBuffer(episodeVector);

  const hasVec = !!db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type='table' AND name='vec_semantics'"
  ).get();

  let bestMatch = null;
  let bestSimilarity = 0;

  if (hasVec) {
    // KNN k=1: find the single closest semantic memory
    const result = db.prepare(`
      SELECT s.*, (1.0 - v.distance) AS similarity
      FROM vec_semantics v
      JOIN semantics s ON s.id = v.id
      WHERE v.embedding MATCH ?
        AND k = 1
        AND (v.state = 'active' OR v.state = 'context_dependent')
    `).get(episodeBuffer);

    if (result) {
      bestMatch = result;
      bestSimilarity = result.similarity;
    }
  } else {
    // Fallback: original brute-force scan
    const semantics = db.prepare(
      "SELECT * FROM semantics WHERE state IN ('active', 'context_dependent') AND embedding IS NOT NULL"
    ).all();
    for (const sem of semantics) {
      const similarity = cosineSimilarity(episodeBuffer, sem.embedding, embeddingProvider);
      if (similarity > bestSimilarity) {
        bestSimilarity = similarity;
        bestMatch = sem;
      }
    }
  }

  // Zone 1: High similarity — reinforce
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

  // Zone 2: Middle similarity — check for contradiction via LLM
  if (bestMatch && bestSimilarity >= contradictionThreshold && llmProvider) {
    const messages = buildContradictionDetectionPrompt(episode.content, bestMatch.content);
    const llmResult = await llmProvider.json(messages);

    if (llmResult.contradicts) {
      const resolution = llmResult.resolution === 'context_dependent'
        ? { type: 'context_dependent', conditions: llmResult.conditions, explanation: llmResult.explanation }
        : llmResult.resolution
          ? { type: llmResult.resolution, explanation: llmResult.explanation }
          : null;

      const contradictionId = createContradiction(
        db,
        bestMatch.id,
        'semantic',
        episode.id,
        'episodic',
        resolution,
      );

      // Update semantic state if resolution provided
      if (llmResult.resolution === 'new_wins') {
        db.prepare("UPDATE semantics SET state = 'disputed' WHERE id = ?").run(bestMatch.id);
      } else if (llmResult.resolution === 'context_dependent' && llmResult.conditions) {
        db.prepare("UPDATE semantics SET state = 'context_dependent', conditions = ? WHERE id = ?")
          .run(JSON.stringify(llmResult.conditions), bestMatch.id);
      }

      return {
        action: 'contradiction',
        contradictionId,
        semanticId: bestMatch.id,
        similarity: bestSimilarity,
        resolution: llmResult.resolution || null,
      };
    }
  }

  // Zone 3: Low similarity or no match — no action
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
