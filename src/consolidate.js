import { generateId } from './ulid.js';

/**
 * Compute cosine similarity between two embedding buffers.
 */
function cosineSimilarity(bufA, bufB, provider) {
  const a = provider.bufferToVector(bufA);
  const b = provider.bufferToVector(bufB);
  let dot = 0, magA = 0, magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  const mag = Math.sqrt(magA) * Math.sqrt(magB);
  return mag === 0 ? 0 : dot / mag;
}

/**
 * Fetch unconsolidated, non-superseded episodes and cluster them by
 * embedding similarity using single-linkage clustering.
 *
 * Returns an array of clusters, where each cluster is an array of
 * episode row objects. Only clusters meeting minClusterSize are returned.
 */
export function clusterEpisodes(db, embeddingProvider, options = {}) {
  const {
    similarityThreshold = 0.85,
    minClusterSize = 3,
  } = options;

  const episodes = db.prepare(
    'SELECT * FROM episodes WHERE consolidated = 0 AND superseded_by IS NULL AND embedding IS NOT NULL'
  ).all();

  if (episodes.length === 0) return [];

  // Build adjacency: which episodes are similar enough to cluster together
  const n = episodes.length;
  const parent = new Array(n);
  for (let i = 0; i < n; i++) parent[i] = i;

  function find(x) {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  }

  function union(a, b) {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  }

  // Compare all pairs and union those above threshold
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const sim = cosineSimilarity(episodes[i].embedding, episodes[j].embedding, embeddingProvider);
      if (sim >= similarityThreshold) {
        union(i, j);
      }
    }
  }

  // Group by root
  const groups = new Map();
  for (let i = 0; i < n; i++) {
    const root = find(i);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(episodes[i]);
  }

  // Filter by minimum cluster size
  const clusters = [];
  for (const group of groups.values()) {
    if (group.length >= minClusterSize) {
      clusters.push(group);
    }
  }

  return clusters;
}

/**
 * Default principle extractor — summarizes the cluster content.
 * In production this would call an LLM; here it concatenates unique contents.
 */
function defaultExtractPrinciple(episodes) {
  const uniqueContents = [...new Set(episodes.map(e => e.content))];
  return {
    content: `Recurring pattern: ${uniqueContents.join('; ')}`,
    type: 'semantic',
  };
}

/**
 * Orchestrate the full consolidation pipeline:
 *   1. Create a consolidation_run record
 *   2. Cluster unconsolidated episodes
 *   3. For each cluster, extract a principle
 *   4. Promote principles to semantic memory
 *   5. Mark source episodes as consolidated
 *   6. Update the run record with results
 *
 * Returns { runId, episodesEvaluated, clustersFound, principlesExtracted }
 */
export async function runConsolidation(db, embeddingProvider, options = {}) {
  const {
    similarityThreshold = 0.85,
    minClusterSize = 3,
    extractPrinciple = defaultExtractPrinciple,
  } = options;

  const runId = generateId();
  const now = new Date().toISOString();

  // Create run record
  db.prepare(`
    INSERT INTO consolidation_runs (id, started_at, status, input_episode_ids, output_memory_ids)
    VALUES (?, ?, 'running', '[]', '[]')
  `).run(runId, now);

  try {
    // Cluster
    const clusters = clusterEpisodes(db, embeddingProvider, { similarityThreshold, minClusterSize });

    const allInputIds = [];
    const allOutputIds = [];
    let principlesExtracted = 0;

    // Count total unconsolidated episodes evaluated
    const episodesEvaluated = db.prepare(
      'SELECT COUNT(*) as count FROM episodes WHERE consolidated = 0 AND superseded_by IS NULL AND embedding IS NOT NULL'
    ).get().count;

    for (const cluster of clusters) {
      // Extract principle via callback
      const principle = extractPrinciple(cluster);
      if (!principle || !principle.content) continue;

      const clusterIds = cluster.map(ep => ep.id);
      allInputIds.push(...clusterIds);

      // Compute source type diversity: number of distinct source types in cluster
      const sourceTypes = new Set(cluster.map(ep => ep.source));
      const sourceTypeDiversity = sourceTypes.size;

      // Embed the principle content
      const vector = await embeddingProvider.embed(principle.content);
      const embeddingBuffer = embeddingProvider.vectorToBuffer(vector);

      // Create semantic memory
      const semanticId = generateId();
      const semanticNow = new Date().toISOString();

      db.prepare(`
        INSERT INTO semantics (
          id, content, embedding, state, evidence_episode_ids,
          evidence_count, supporting_count, source_type_diversity,
          consolidation_checkpoint, embedding_model, embedding_version,
          created_at
        ) VALUES (?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        semanticId,
        principle.content,
        embeddingBuffer,
        JSON.stringify(clusterIds),
        cluster.length,
        cluster.length,
        sourceTypeDiversity,
        runId,
        embeddingProvider.modelName,
        embeddingProvider.modelVersion,
        semanticNow,
      );

      allOutputIds.push(semanticId);
      principlesExtracted++;

      // Mark source episodes as consolidated
      const markStmt = db.prepare('UPDATE episodes SET consolidated = 1 WHERE id = ?');
      for (const ep of cluster) {
        markStmt.run(ep.id);
      }
    }

    // If no clusters were found but there were episodes, still mark nothing —
    // episodes only get marked consolidated when they're actually part of a cluster.
    // However, for idempotent single-episode runs with low thresholds, we need to
    // mark single episodes that formed clusters too.

    // Update run record
    const completedAt = new Date().toISOString();
    db.prepare(`
      UPDATE consolidation_runs
      SET status = 'completed',
          completed_at = ?,
          input_episode_ids = ?,
          output_memory_ids = ?
      WHERE id = ?
    `).run(completedAt, JSON.stringify(allInputIds), JSON.stringify(allOutputIds), runId);

    return {
      runId,
      episodesEvaluated,
      clustersFound: clusters.length,
      principlesExtracted,
    };
  } catch (err) {
    // Mark run as failed on error
    const failedAt = new Date().toISOString();
    db.prepare(`
      UPDATE consolidation_runs
      SET status = 'failed', completed_at = ?
      WHERE id = ?
    `).run(failedAt, runId);
    throw err;
  }
}
