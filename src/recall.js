import { computeConfidence, DEFAULT_HALF_LIVES } from './confidence.js';
import { cosineSimilarity, daysBetween, safeJsonParse } from './utils.js';

function hasVec0Tables(db) {
  return !!db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type='table' AND name='vec_episodes'"
  ).get();
}

function computeEpisodicConfidence(ep, now) {
  const ageDays = daysBetween(ep.created_at, now);
  return computeConfidence({
    sourceType: ep.source,
    supportingCount: 1,
    contradictingCount: 0,
    ageDays,
    halfLifeDays: DEFAULT_HALF_LIVES.episodic,
    retrievalCount: 0,
    daysSinceRetrieval: ageDays,
  });
}

function computeSemanticConfidence(sem, now) {
  const ageDays = daysBetween(sem.created_at, now);
  const daysSinceRetrieval = sem.last_reinforced_at
    ? daysBetween(sem.last_reinforced_at, now)
    : ageDays;
  return computeConfidence({
    sourceType: 'tool-result',
    supportingCount: sem.supporting_count || 0,
    contradictingCount: sem.contradicting_count || 0,
    ageDays,
    halfLifeDays: DEFAULT_HALF_LIVES.semantic,
    retrievalCount: sem.retrieval_count || 0,
    daysSinceRetrieval,
  });
}

function computeProceduralConfidence(proc, now) {
  const ageDays = daysBetween(proc.created_at, now);
  const daysSinceRetrieval = proc.last_reinforced_at
    ? daysBetween(proc.last_reinforced_at, now)
    : ageDays;
  return computeConfidence({
    sourceType: 'tool-result',
    supportingCount: proc.success_count || 0,
    contradictingCount: proc.failure_count || 0,
    ageDays,
    halfLifeDays: DEFAULT_HALF_LIVES.procedural,
    retrievalCount: proc.retrieval_count || 0,
    daysSinceRetrieval,
  });
}

function buildEpisodicEntry(ep, confidence, score, includeProvenance) {
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
  return entry;
}

function buildSemanticEntry(sem, confidence, score, includeProvenance) {
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
  return entry;
}

function buildProceduralEntry(proc, confidence, score, includeProvenance) {
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
  return entry;
}

// --- KNN path: uses sqlite-vec vec0 virtual tables ---

function knnEpisodic(db, queryBuffer, candidateK, now, minConfidence, includeProvenance) {
  const rows = db.prepare(`
    SELECT e.*, (1.0 - v.distance) AS similarity
    FROM vec_episodes v
    JOIN episodes e ON e.id = v.id
    WHERE v.embedding MATCH ?
      AND k = ?
      AND e.superseded_by IS NULL
  `).all(queryBuffer, candidateK);

  const results = [];
  for (const row of rows) {
    const confidence = computeEpisodicConfidence(row, now);
    if (confidence < minConfidence) continue;
    const score = row.similarity * confidence;
    results.push(buildEpisodicEntry(row, confidence, score, includeProvenance));
  }
  return results;
}

function knnSemantic(db, queryBuffer, candidateK, now, minConfidence, includeProvenance, includeDormant) {
  let stateFilter;
  if (includeDormant) {
    stateFilter = "AND (v.state = 'active' OR v.state = 'context_dependent' OR v.state = 'dormant')";
  } else {
    stateFilter = "AND (v.state = 'active' OR v.state = 'context_dependent')";
  }

  const rows = db.prepare(`
    SELECT s.*, (1.0 - v.distance) AS similarity
    FROM vec_semantics v
    JOIN semantics s ON s.id = v.id
    WHERE v.embedding MATCH ?
      AND k = ?
      ${stateFilter}
  `).all(queryBuffer, candidateK);

  const results = [];
  const matchedIds = [];
  for (const row of rows) {
    const confidence = computeSemanticConfidence(row, now);
    if (confidence < minConfidence) continue;
    const score = row.similarity * confidence;
    matchedIds.push(row.id);
    results.push(buildSemanticEntry(row, confidence, score, includeProvenance));
  }
  return { results, matchedIds };
}

function knnProcedural(db, queryBuffer, candidateK, now, minConfidence, includeProvenance, includeDormant) {
  let stateFilter;
  if (includeDormant) {
    stateFilter = "AND (v.state = 'active' OR v.state = 'context_dependent' OR v.state = 'dormant')";
  } else {
    stateFilter = "AND (v.state = 'active' OR v.state = 'context_dependent')";
  }

  const rows = db.prepare(`
    SELECT p.*, (1.0 - v.distance) AS similarity
    FROM vec_procedures v
    JOIN procedures p ON p.id = v.id
    WHERE v.embedding MATCH ?
      AND k = ?
      ${stateFilter}
  `).all(queryBuffer, candidateK);

  const results = [];
  const matchedIds = [];
  for (const row of rows) {
    const confidence = computeProceduralConfidence(row, now);
    if (confidence < minConfidence) continue;
    const score = row.similarity * confidence;
    matchedIds.push(row.id);
    results.push(buildProceduralEntry(row, confidence, score, includeProvenance));
  }
  return { results, matchedIds };
}

// --- Brute-force fallback: no vec0 tables ---

function bruteEpisodic(db, queryBuffer, embeddingProvider, now, minConfidence, includeProvenance) {
  const episodes = db.prepare(
    'SELECT * FROM episodes WHERE superseded_by IS NULL AND embedding IS NOT NULL'
  ).all();

  const results = [];
  for (const ep of episodes) {
    const similarity = cosineSimilarity(queryBuffer, ep.embedding, embeddingProvider);
    const confidence = computeEpisodicConfidence(ep, now);
    if (confidence < minConfidence) continue;
    const score = similarity * confidence;
    results.push(buildEpisodicEntry(ep, confidence, score, includeProvenance));
  }
  return results;
}

function bruteSemantic(db, queryBuffer, embeddingProvider, now, minConfidence, includeProvenance, includeDormant) {
  let stateFilter;
  if (includeDormant) {
    stateFilter = "state IN ('active', 'context_dependent', 'dormant')";
  } else {
    stateFilter = "state IN ('active', 'context_dependent')";
  }

  const semantics = db.prepare(
    `SELECT * FROM semantics WHERE ${stateFilter} AND embedding IS NOT NULL`
  ).all();

  const results = [];
  const matchedIds = [];
  for (const sem of semantics) {
    const similarity = cosineSimilarity(queryBuffer, sem.embedding, embeddingProvider);
    const confidence = computeSemanticConfidence(sem, now);
    if (confidence < minConfidence) continue;
    const score = similarity * confidence;
    matchedIds.push(sem.id);
    results.push(buildSemanticEntry(sem, confidence, score, includeProvenance));
  }
  return { results, matchedIds };
}

function bruteProcedural(db, queryBuffer, embeddingProvider, now, minConfidence, includeProvenance, includeDormant) {
  let stateFilter;
  if (includeDormant) {
    stateFilter = "state IN ('active', 'context_dependent', 'dormant')";
  } else {
    stateFilter = "state IN ('active', 'context_dependent')";
  }

  const procedures = db.prepare(
    `SELECT * FROM procedures WHERE ${stateFilter} AND embedding IS NOT NULL`
  ).all();

  const results = [];
  const matchedIds = [];
  for (const proc of procedures) {
    const similarity = cosineSimilarity(queryBuffer, proc.embedding, embeddingProvider);
    const confidence = computeProceduralConfidence(proc, now);
    if (confidence < minConfidence) continue;
    const score = similarity * confidence;
    matchedIds.push(proc.id);
    results.push(buildProceduralEntry(proc, confidence, score, includeProvenance));
  }
  return { results, matchedIds };
}

export async function* recallStream(db, embeddingProvider, query, options = {}) {
  const {
    minConfidence = 0,
    types,
    limit = 10,
    includeProvenance = false,
    includeDormant = false,
  } = options;

  const queryVector = await embeddingProvider.embed(query);
  const queryBuffer = embeddingProvider.vectorToBuffer(queryVector);
  const searchTypes = types || ['episodic', 'semantic', 'procedural'];
  const now = new Date();
  const useKnn = hasVec0Tables(db);
  const candidateK = limit * 3;

  const allResults = [];

  // --- Episodic ---
  if (searchTypes.includes('episodic')) {
    const episodic = useKnn
      ? knnEpisodic(db, queryBuffer, candidateK, now, minConfidence, includeProvenance)
      : bruteEpisodic(db, queryBuffer, embeddingProvider, now, minConfidence, includeProvenance);
    allResults.push(...episodic);
  }

  // --- Semantic ---
  if (searchTypes.includes('semantic')) {
    const { results: semResults, matchedIds: semIds } = useKnn
      ? knnSemantic(db, queryBuffer, candidateK, now, minConfidence, includeProvenance, includeDormant)
      : bruteSemantic(db, queryBuffer, embeddingProvider, now, minConfidence, includeProvenance, includeDormant);
    allResults.push(...semResults);

    // Retrieval reinforcement
    if (semIds.length > 0) {
      const updateStmt = db.prepare(
        'UPDATE semantics SET retrieval_count = retrieval_count + 1, last_reinforced_at = ? WHERE id = ?'
      );
      const nowISO = now.toISOString();
      for (const id of semIds) {
        updateStmt.run(nowISO, id);
      }
    }
  }

  // --- Procedural ---
  if (searchTypes.includes('procedural')) {
    const { results: procResults, matchedIds: procIds } = useKnn
      ? knnProcedural(db, queryBuffer, candidateK, now, minConfidence, includeProvenance, includeDormant)
      : bruteProcedural(db, queryBuffer, embeddingProvider, now, minConfidence, includeProvenance, includeDormant);
    allResults.push(...procResults);

    // Retrieval reinforcement
    if (procIds.length > 0) {
      const updateStmt = db.prepare(
        'UPDATE procedures SET retrieval_count = retrieval_count + 1, last_reinforced_at = ? WHERE id = ?'
      );
      const nowISO = now.toISOString();
      for (const id of procIds) {
        updateStmt.run(nowISO, id);
      }
    }
  }

  // Sort by score descending, yield top N
  allResults.sort((a, b) => b.score - a.score);
  const top = allResults.slice(0, limit);
  for (const entry of top) {
    yield entry;
  }
}

export async function recall(db, embeddingProvider, query, options = {}) {
  const results = [];
  for await (const entry of recallStream(db, embeddingProvider, query, options)) {
    results.push(entry);
  }
  return results;
}
