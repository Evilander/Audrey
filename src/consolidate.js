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
    INSERT INTO consolidation_runs (id, started_at, status, input_episode_ids, output_memory_ids, consolidation_model)
    VALUES (?, ?, 'running', '[]', '[]', ?)
  `).run(runId, now, llmProvider?.modelName || null);

  try {
    const clusters = clusterEpisodes(db, embeddingProvider, { similarityThreshold, minClusterSize });

    const episodesEvaluated = db.prepare(
      'SELECT COUNT(*) as count FROM episodes WHERE consolidated = 0 AND superseded_by IS NULL AND embedding IS NOT NULL'
    ).get().count;

    const clusterData = [];
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
      const sourceTypes = new Set(cluster.map(ep => ep.source));
      const vector = await embeddingProvider.embed(principle.content);
      const embeddingBuffer = embeddingProvider.vectorToBuffer(vector);

      clusterData.push({
        cluster,
        principle,
        clusterIds,
        sourceTypeDiversity: sourceTypes.size,
        embeddingBuffer,
        semanticId: generateId(),
        semanticNow: new Date().toISOString(),
      });
    }

    const allInputIds = [];
    const allOutputIds = [];
    let principlesExtracted = 0;

    const promoteAll = db.transaction(() => {
      for (const data of clusterData) {
        allInputIds.push(...data.clusterIds);

        db.prepare(`
          INSERT INTO semantics (
            id, content, embedding, state, evidence_episode_ids,
            evidence_count, supporting_count, source_type_diversity,
            consolidation_checkpoint, embedding_model, embedding_version,
            consolidation_model, created_at
          ) VALUES (?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          data.semanticId,
          data.principle.content,
          data.embeddingBuffer,
          JSON.stringify(data.clusterIds),
          data.cluster.length,
          data.cluster.length,
          data.sourceTypeDiversity,
          runId,
          embeddingProvider.modelName,
          embeddingProvider.modelVersion,
          llmProvider?.modelName || null,
          data.semanticNow,
        );

        db.prepare('INSERT INTO vec_semantics(id, embedding, state) VALUES (?, ?, ?)').run(
          data.semanticId, data.embeddingBuffer, 'active'
        );

        allOutputIds.push(data.semanticId);
        principlesExtracted++;

        const markStmt = db.prepare('UPDATE episodes SET consolidated = 1 WHERE id = ?');
        const markVecStmt = db.prepare('UPDATE vec_episodes SET consolidated = ? WHERE id = ?');
        for (const ep of data.cluster) {
          markStmt.run(ep.id);
          markVecStmt.run(BigInt(1), ep.id);
        }
      }

      const completedAt = new Date().toISOString();
      db.prepare(`
        UPDATE consolidation_runs
        SET status = 'completed',
            completed_at = ?,
            input_episode_ids = ?,
            output_memory_ids = ?
        WHERE id = ?
      `).run(completedAt, JSON.stringify(allInputIds), JSON.stringify(allOutputIds), runId);
    });

    promoteAll();

    return {
      runId,
      episodesEvaluated,
      clustersFound: clusters.length,
      principlesExtracted,
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
