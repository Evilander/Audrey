import Database from 'better-sqlite3';

interface MetricRow {
  min_cluster_size: number;
  similarity_threshold: number;
  clusters_found: number;
  principles_extracted: number;
  episodes_evaluated: number;
}

interface ParamScore {
  minClusterSize: number;
  similarityThreshold: number;
  yields: number[];
}

export function suggestConsolidationParams(db: Database.Database): {
  minClusterSize: number;
  similarityThreshold: number;
  confidence: string;
} {
  const runs = db.prepare(`
    SELECT min_cluster_size, similarity_threshold, clusters_found, principles_extracted, episodes_evaluated
    FROM consolidation_metrics
    ORDER BY created_at DESC
    LIMIT 20
  `).all() as MetricRow[];

  if (runs.length === 0) {
    return {
      minClusterSize: 3,
      similarityThreshold: 0.85,
      confidence: 'no_data',
    };
  }

  const paramScores = new Map<string, ParamScore>();
  let validRuns = 0;
  for (const run of runs) {
    if (run.episodes_evaluated === 0) continue;
    validRuns++;
    const key = `${run.min_cluster_size}:${run.similarity_threshold}`;
    if (!paramScores.has(key)) {
      paramScores.set(key, {
        minClusterSize: run.min_cluster_size,
        similarityThreshold: run.similarity_threshold,
        yields: [],
      });
    }
    paramScores.get(key)!.yields.push(run.principles_extracted / run.episodes_evaluated);
  }

  let bestKey: string | null = null;
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

  const best = paramScores.get(bestKey)!;
  const confidence = validRuns >= 5 ? 'high' : validRuns >= 2 ? 'medium' : 'low';

  return {
    minClusterSize: best.minClusterSize,
    similarityThreshold: best.similarityThreshold,
    confidence,
  };
}
