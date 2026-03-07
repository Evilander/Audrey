import { generateId } from './ulid.js';
import { buildPrincipleExtractionPrompt } from './prompts.js';

function clusterViaKNN(db, episodes, similarityThreshold, minClusterSize) {
  const n = episodes.length;
  const k = Math.min(50, n);
  const idToIndex = new Map(episodes.map((ep, i) => [ep.id, i]));

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

  const getEmbedding = db.prepare('SELECT embedding FROM vec_episodes WHERE id = ?');
  const knnQuery = db.prepare(`
    SELECT id, distance
    FROM vec_episodes
    WHERE embedding MATCH ? AND k = ? AND consolidated = 0
  `);

  for (let i = 0; i < n; i++) {
    const ep = episodes[i];
    const vecRow = getEmbedding.get(ep.id);
    if (!vecRow) continue;

    const neighbors = knnQuery.all(vecRow.embedding, k);
    for (const neighbor of neighbors) {
      if (neighbor.id === ep.id) continue;
      const j = idToIndex.get(neighbor.id);
      if (j === undefined) continue;
      const similarity = 1.0 - neighbor.distance;
      if (similarity >= similarityThreshold) {
        union(i, j);
      }
    }
  }

  const groups = new Map();
  for (let i = 0; i < n; i++) {
    const root = find(i);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(episodes[i]);
  }

  const clusters = [];
  for (const group of groups.values()) {
    if (group.length >= minClusterSize) {
      clusters.push(group);
    }
  }
  return clusters;
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {import('./embedding.js').EmbeddingProvider} embeddingProvider
 * @param {{ similarityThreshold?: number, minClusterSize?: number }} [options]
 * @returns {Array<Array<Object>>}
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

  return clusterViaKNN(db, episodes, similarityThreshold, minClusterSize);
}

function defaultExtractPrinciple(episodes) {
  const uniqueContents = [...new Set(episodes.map(e => e.content))];
  return {
    content: `Recurring pattern: ${uniqueContents.join('; ')}`,
    type: 'semantic',
  };
}

async function llmExtractPrinciple(llmProvider, episodes) {
  const messages = buildPrincipleExtractionPrompt(episodes);
  return llmProvider.json(messages);
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {import('./embedding.js').EmbeddingProvider} embeddingProvider
 * @param {{ similarityThreshold?: number, minClusterSize?: number, extractPrinciple?: function, llmProvider?: Object }} [options]
 * @returns {Promise<{ runId: string, episodesEvaluated: number, clustersFound: number, principlesExtracted: number }>}
 */
export async function runConsolidation(db, embeddingProvider, options = {}) {
  const {
    similarityThreshold = 0.85,
    minClusterSize = 3,
    extractPrinciple,
    llmProvider,
  } = options;

  const runId = generateId();
  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO consolidation_runs (
      id, started_at, status, input_episode_ids, output_memory_ids, consolidation_model, checkpoint_cursor
    )
    VALUES (?, ?, 'running', '[]', '[]', ?, ?)
  `).run(runId, now, llmProvider?.modelName || null, now);

  try {
    const clusters = clusterEpisodes(db, embeddingProvider, { similarityThreshold, minClusterSize });

    const episodesEvaluated = db.prepare(
      'SELECT COUNT(*) as count FROM episodes WHERE consolidated = 0 AND superseded_by IS NULL AND embedding IS NOT NULL'
    ).get().count;

    const allInputIds = [];
    const allOutputIds = [];
    let principlesExtracted = 0;
    let proceduresExtracted = 0;
    const insertProcedure = db.prepare(`
      INSERT INTO procedures (
        id, content, embedding, state, trigger_conditions,
        evidence_episode_ids, success_count, failure_count,
        embedding_model, embedding_version, created_at, salience
      ) VALUES (?, ?, ?, 'active', ?, ?, 0, 0, ?, ?, ?, ?)
    `);
    const insertVecProcedure = db.prepare('INSERT INTO vec_procedures(id, embedding, state) VALUES (?, ?, ?)');
    const insertSemantic = db.prepare(`
      INSERT INTO semantics (
        id, content, embedding, state, evidence_episode_ids,
        evidence_count, supporting_count, source_type_diversity,
        consolidation_checkpoint, embedding_model, embedding_version,
        consolidation_model, created_at, salience
      ) VALUES (?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertVecSemantic = db.prepare('INSERT INTO vec_semantics(id, embedding, state) VALUES (?, ?, ?)');
    const markEpisode = db.prepare('UPDATE episodes SET consolidated = 1 WHERE id = ?');
    const markVecEpisode = db.prepare('UPDATE vec_episodes SET consolidated = ? WHERE id = ?');
    const updateRunCompleted = db.prepare(`
      UPDATE consolidation_runs
      SET status = 'completed',
          completed_at = ?,
          input_episode_ids = ?,
          output_memory_ids = ?
      WHERE id = ?
    `);
    const insertMetrics = db.prepare(`
      INSERT INTO consolidation_metrics (id, run_id, min_cluster_size, similarity_threshold,
        episodes_evaluated, clusters_found, principles_extracted, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    db.exec('BEGIN IMMEDIATE');
    try {
      for (const cluster of clusters) {
        let principle;
        if (extractPrinciple) {
          principle = extractPrinciple(cluster);
        } else if (llmProvider) {
          principle = await llmExtractPrinciple(llmProvider, cluster);
        } else {
          principle = defaultExtractPrinciple(cluster);
        }

        if (!principle || !principle.content) continue;

        const clusterIds = cluster.map(ep => ep.id);
        const sourceTypeDiversity = new Set(cluster.map(ep => ep.source)).size;
        const vector = await embeddingProvider.embed(principle.content);
        const embeddingBuffer = embeddingProvider.vectorToBuffer(vector);
        const memoryId = generateId();
        const createdAt = new Date().toISOString();
        const maxSalience = Math.max(...cluster.map(ep => ep.salience ?? 0.5));

        allInputIds.push(...clusterIds);

        if (principle.type === 'procedural') {
          insertProcedure.run(
            memoryId,
            principle.content,
            embeddingBuffer,
            principle.conditions ? JSON.stringify(principle.conditions) : null,
            JSON.stringify(clusterIds),
            embeddingProvider.modelName,
            embeddingProvider.modelVersion,
            createdAt,
            maxSalience,
          );
          insertVecProcedure.run(memoryId, embeddingBuffer, 'active');
          proceduresExtracted++;
        } else {
          insertSemantic.run(
            memoryId,
            principle.content,
            embeddingBuffer,
            JSON.stringify(clusterIds),
            cluster.length,
            cluster.length,
            sourceTypeDiversity,
            runId,
            embeddingProvider.modelName,
            embeddingProvider.modelVersion,
            llmProvider?.modelName || null,
            createdAt,
            maxSalience,
          );
          insertVecSemantic.run(memoryId, embeddingBuffer, 'active');
        }

        allOutputIds.push(memoryId);
        principlesExtracted++;

        for (const ep of cluster) {
          markEpisode.run(ep.id);
          markVecEpisode.run(BigInt(1), ep.id);
        }
      }

      const completedAt = new Date().toISOString();
      updateRunCompleted.run(completedAt, JSON.stringify(allInputIds), JSON.stringify(allOutputIds), runId);
      insertMetrics.run(
        generateId(), runId, minClusterSize, similarityThreshold,
        episodesEvaluated, clusters.length, principlesExtracted, completedAt,
      );
      db.exec('COMMIT');
    } catch (err) {
      if (db.inTransaction) {
        db.exec('ROLLBACK');
      }
      throw err;
    }

    return {
      runId,
      episodesEvaluated,
      clustersFound: clusters.length,
      principlesExtracted,
      semanticsCreated: principlesExtracted - proceduresExtracted,
      proceduresCreated: proceduresExtracted,
    };
  } catch (err) {
    const failedAt = new Date().toISOString();
    db.prepare(`
      UPDATE consolidation_runs
      SET status = 'failed', completed_at = ?
      WHERE id = ?
    `).run(failedAt, runId);
    throw err;
  }
}
