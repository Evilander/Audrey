import { computeConfidence, DEFAULT_HALF_LIVES } from './confidence.js';
import { cosineSimilarity, daysBetween, safeJsonParse } from './utils.js';

export async function recall(db, embeddingProvider, query, options = {}) {
  const {
    minConfidence = 0,
    types,
    limit = 10,
    includeProvenance = false,
    includeDormant = false,
  } = options;

  const queryVector = await embeddingProvider.embed(query);
  const queryBuffer = embeddingProvider.vectorToBuffer(queryVector);
  const results = [];
  const searchTypes = types || ['episodic', 'semantic', 'procedural'];
  const now = new Date();

  // --- Episodic memories ---
  if (searchTypes.includes('episodic')) {
    const episodes = db.prepare(
      'SELECT * FROM episodes WHERE superseded_by IS NULL AND embedding IS NOT NULL'
    ).all();

    for (const ep of episodes) {
      const similarity = cosineSimilarity(queryBuffer, ep.embedding, embeddingProvider);
      const ageDays = daysBetween(ep.created_at, now);

      const confidence = computeConfidence({
        sourceType: ep.source,
        supportingCount: 1,
        contradictingCount: 0,
        ageDays,
        halfLifeDays: DEFAULT_HALF_LIVES.episodic,
        retrievalCount: 0,
        daysSinceRetrieval: ageDays,
      });

      const score = similarity * confidence;
      if (confidence < minConfidence) continue;

      const entry = {
        id: ep.id,
        content: ep.content,
        type: 'episodic',
        confidence,
        score,
        source: ep.source,
        createdAt: ep.created_at,
      };

      if (includeProvenance) {
        entry.provenance = {
          source: ep.source,
          sourceReliability: ep.source_reliability,
          createdAt: ep.created_at,
          supersedes: ep.supersedes || null,
        };
      }

      results.push(entry);
    }
  }

  // --- Semantic memories ---
  if (searchTypes.includes('semantic')) {
    let stateFilter;
    if (includeDormant) {
      stateFilter = "state IN ('active', 'context_dependent', 'dormant')";
    } else {
      stateFilter = "state IN ('active', 'context_dependent')";
    }

    const semantics = db.prepare(
      `SELECT * FROM semantics WHERE ${stateFilter} AND embedding IS NOT NULL`
    ).all();

    const matchedIds = [];

    for (const sem of semantics) {
      const similarity = cosineSimilarity(queryBuffer, sem.embedding, embeddingProvider);
      const ageDays = daysBetween(sem.created_at, now);
      const daysSinceRetrieval = sem.last_reinforced_at
        ? daysBetween(sem.last_reinforced_at, now)
        : ageDays;

      const confidence = computeConfidence({
        sourceType: 'tool-result', // semantic memories are consolidated from episodes
        supportingCount: sem.supporting_count || 0,
        contradictingCount: sem.contradicting_count || 0,
        ageDays,
        halfLifeDays: DEFAULT_HALF_LIVES.semantic,
        retrievalCount: sem.retrieval_count || 0,
        daysSinceRetrieval,
      });

      const score = similarity * confidence;
      if (confidence < minConfidence) continue;

      matchedIds.push(sem.id);

      const entry = {
        id: sem.id,
        content: sem.content,
        type: 'semantic',
        confidence,
        score,
        source: 'consolidation',
        state: sem.state,
        createdAt: sem.created_at,
      };

      if (includeProvenance) {
        entry.provenance = {
          evidenceEpisodeIds: safeJsonParse(sem.evidence_episode_ids, []),
          evidenceCount: sem.evidence_count || 0,
          supportingCount: sem.supporting_count || 0,
          contradictingCount: sem.contradicting_count || 0,
          consolidationCheckpoint: sem.consolidation_checkpoint || null,
        };
      }

      results.push(entry);
    }

    // Retrieval reinforcement: increment retrieval_count for matched semantics
    if (matchedIds.length > 0) {
      const updateStmt = db.prepare(
        'UPDATE semantics SET retrieval_count = retrieval_count + 1, last_reinforced_at = ? WHERE id = ?'
      );
      const nowISO = now.toISOString();
      for (const id of matchedIds) {
        updateStmt.run(nowISO, id);
      }
    }
  }

  // --- Procedural memories ---
  if (searchTypes.includes('procedural')) {
    let stateFilter;
    if (includeDormant) {
      stateFilter = "state IN ('active', 'context_dependent', 'dormant')";
    } else {
      stateFilter = "state IN ('active', 'context_dependent')";
    }

    const procedures = db.prepare(
      `SELECT * FROM procedures WHERE ${stateFilter} AND embedding IS NOT NULL`
    ).all();

    const matchedIds = [];

    for (const proc of procedures) {
      const similarity = cosineSimilarity(queryBuffer, proc.embedding, embeddingProvider);
      const ageDays = daysBetween(proc.created_at, now);
      const daysSinceRetrieval = proc.last_reinforced_at
        ? daysBetween(proc.last_reinforced_at, now)
        : ageDays;

      const totalTrials = (proc.success_count || 0) + (proc.failure_count || 0);
      const supportingCount = proc.success_count || 0;
      const contradictingCount = proc.failure_count || 0;

      const confidence = computeConfidence({
        sourceType: 'tool-result',
        supportingCount,
        contradictingCount,
        ageDays,
        halfLifeDays: DEFAULT_HALF_LIVES.procedural,
        retrievalCount: proc.retrieval_count || 0,
        daysSinceRetrieval,
      });

      const score = similarity * confidence;
      if (confidence < minConfidence) continue;

      matchedIds.push(proc.id);

      const entry = {
        id: proc.id,
        content: proc.content,
        type: 'procedural',
        confidence,
        score,
        source: 'consolidation',
        state: proc.state,
        createdAt: proc.created_at,
      };

      if (includeProvenance) {
        entry.provenance = {
          evidenceEpisodeIds: safeJsonParse(proc.evidence_episode_ids, []),
          successCount: proc.success_count || 0,
          failureCount: proc.failure_count || 0,
          triggerConditions: proc.trigger_conditions || null,
        };
      }

      results.push(entry);
    }

    // Retrieval reinforcement for procedures
    if (matchedIds.length > 0) {
      const updateStmt = db.prepare(
        'UPDATE procedures SET retrieval_count = retrieval_count + 1, last_reinforced_at = ? WHERE id = ?'
      );
      const nowISO = now.toISOString();
      for (const id of matchedIds) {
        updateStmt.run(nowISO, id);
      }
    }
  }

  // Sort by score descending, take top N
  results.sort((a, b) => b.score - a.score);
  return results.slice(0, limit);
}
