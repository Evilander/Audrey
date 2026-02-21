export function suggestConsolidationParams(db) {
  const runs = db.prepare(`
    SELECT min_cluster_size, similarity_threshold, clusters_found, principles_extracted, episodes_evaluated
    FROM consolidation_metrics
    ORDER BY created_at DESC
    LIMIT 20
  `).all();

  if (runs.length === 0) {
    return {
      minClusterSize: 3,
      similarityThreshold: 0.85,
      confidence: 'no_data',
    };
  }

  const paramScores = new Map();
  for (const run of runs) {
    if (run.episodes_evaluated === 0) continue;
    const key = `${run.min_cluster_size}:${run.similarity_threshold}`;
    if (!paramScores.has(key)) {
      paramScores.set(key, {
        minClusterSize: run.min_cluster_size,
        similarityThreshold: run.similarity_threshold,
        yields: [],
      });
    }
    paramScores.get(key).yields.push(run.principles_extracted / run.episodes_evaluated);
  }

  let bestKey = null;
  let bestAvgYield = -1;
  for (const [key, data] of paramScores) {
    const avg = data.yields.reduce((a, b) => a + b, 0) / data.yields.length;
    if (avg > bestAvgYield) {
      bestAvgYield = avg;
      bestKey = key;
    }
  }

  if (!bestKey) {
    return { minClusterSize: 3, similarityThreshold: 0.85, confidence: 'no_data' };
  }

  const best = paramScores.get(bestKey);
  const confidence = runs.length >= 5 ? 'high' : runs.length >= 2 ? 'medium' : 'low';

  return {
    minClusterSize: best.minClusterSize,
    similarityThreshold: best.similarityThreshold,
    confidence,
  };
}
