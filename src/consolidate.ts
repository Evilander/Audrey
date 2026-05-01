import Database from 'better-sqlite3';
import type {
  ConsolidationOptions,
  ConsolidationResult,
  EmbeddingProvider,
  EpisodeRow,
  ExtractedPrinciple,
  LLMProvider,
} from './types.js';
import { generateId } from './ulid.js';
import { insertFTSSemantic, insertFTSProcedure } from './fts.js';
import { buildPrincipleExtractionPrompt } from './prompts.js';

interface VecEmbeddingRow {
  embedding: Buffer;
}

interface KnnRow {
  id: string;
  distance: number;
}

interface CountRow {
  count: number;
}

function clusterViaKNN(
  db: Database.Database,
  episodes: EpisodeRow[],
  similarityThreshold: number,
  minClusterSize: number,
  agent?: string,
): EpisodeRow[][] {
  const n = episodes.length;
  const k = Math.min(50, n);
  const idToIndex = new Map<string, number>(episodes.map((ep, i) => [ep.id, i]));

  const parent = new Array<number>(n);
  for (let i = 0; i < n; i++) parent[i] = i;

  function find(x: number): number {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]!]!;
      x = parent[x]!;
    }
    return x;
  }

  function union(a: number, b: number): void {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  }

  const getEmbedding = db.prepare('SELECT embedding FROM vec_episodes WHERE id = ?');
  const knnQuery = agent
    ? db.prepare(`
      SELECT v.id, v.distance
      FROM vec_episodes v
      JOIN episodes e ON e.id = v.id
      WHERE v.embedding MATCH ? AND k = ? AND v.consolidated = 0 AND e.agent = ?
    `)
    : db.prepare(`
      SELECT id, distance
      FROM vec_episodes
      WHERE embedding MATCH ? AND k = ? AND consolidated = 0
    `);

  for (let i = 0; i < n; i++) {
    const ep = episodes[i]!;
    const vecRow = getEmbedding.get(ep.id) as VecEmbeddingRow | undefined;
    if (!vecRow) continue;

    const neighbors = (agent
      ? knnQuery.all(vecRow.embedding, k, agent)
      : knnQuery.all(vecRow.embedding, k)) as KnnRow[];
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

  const groups = new Map<number, EpisodeRow[]>();
  for (let i = 0; i < n; i++) {
    const root = find(i);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root)!.push(episodes[i]!);
  }

  const clusters: EpisodeRow[][] = [];
  for (const group of groups.values()) {
    if (group.length >= minClusterSize) {
      clusters.push(group);
    }
  }
  return clusters;
}

export function clusterEpisodes(
  db: Database.Database,
  embeddingProvider: EmbeddingProvider,
  options: { similarityThreshold?: number; minClusterSize?: number; agent?: string } = {},
): EpisodeRow[][] {
  const {
    similarityThreshold = 0.85,
    minClusterSize = 3,
    agent,
  } = options;

  const episodeQuery = agent
    ? 'SELECT * FROM episodes WHERE consolidated = 0 AND superseded_by IS NULL AND embedding IS NOT NULL AND agent = ?'
    : 'SELECT * FROM episodes WHERE consolidated = 0 AND superseded_by IS NULL AND embedding IS NOT NULL';
  const episodes = agent
    ? db.prepare(episodeQuery).all(agent) as EpisodeRow[]
    : db.prepare(episodeQuery).all() as EpisodeRow[];

  if (episodes.length === 0) return [];

  return clusterViaKNN(db, episodes, similarityThreshold, minClusterSize, agent);
}

function defaultExtractPrinciple(episodes: EpisodeRow[]): ExtractedPrinciple {
  const uniqueContents = [...new Set(episodes.map(e => e.content))];
  return {
    content: `Recurring pattern: ${uniqueContents.join('; ')}`,
    type: 'semantic',
  };
}

async function llmExtractPrinciple(llmProvider: LLMProvider, episodes: EpisodeRow[]): Promise<ExtractedPrinciple> {
  const messages = buildPrincipleExtractionPrompt(episodes);
  return llmProvider.json(messages) as Promise<ExtractedPrinciple>;
}

function inClause(ids: string[]): string {
  return ids.map(() => '?').join(',');
}

interface PreparedCluster {
  principle: ExtractedPrinciple;
  clusterIds: string[];
  sourceTypeDiversity: number;
  embeddingBuffer: Buffer;
  memoryId: string;
  createdAt: string;
  maxSalience: number;
}

export async function runConsolidation(
  db: Database.Database,
  embeddingProvider: EmbeddingProvider,
  options: ConsolidationOptions = {},
): Promise<ConsolidationResult> {
  const {
    similarityThreshold = 0.85,
    minClusterSize = 3,
    agent = 'default',
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
    const clusters = clusterEpisodes(db, embeddingProvider, { similarityThreshold, minClusterSize, agent });

    const episodesEvaluated = (agent
      ? db.prepare(
        'SELECT COUNT(*) as count FROM episodes WHERE consolidated = 0 AND superseded_by IS NULL AND embedding IS NOT NULL AND agent = ?'
      ).get(agent) as CountRow
      : db.prepare(
        'SELECT COUNT(*) as count FROM episodes WHERE consolidated = 0 AND superseded_by IS NULL AND embedding IS NOT NULL'
      ).get() as CountRow).count;

    const allInputIds: string[] = [];
    const allOutputIds: string[] = [];
    let principlesExtracted = 0;
    let proceduresExtracted = 0;
    const preparedClusters: PreparedCluster[] = [];
    const insertProcedure = db.prepare(`
      INSERT INTO procedures (
        id, content, agent, embedding, state, trigger_conditions,
        evidence_episode_ids, success_count, failure_count,
        embedding_model, embedding_version, created_at, salience
      ) VALUES (?, ?, ?, ?, 'active', ?, ?, 0, 0, ?, ?, ?, ?)
    `);
    const insertVecProcedure = db.prepare('INSERT INTO vec_procedures(id, embedding, state) VALUES (?, ?, ?)');
    const insertSemantic = db.prepare(`
      INSERT INTO semantics (
        id, content, agent, embedding, state, evidence_episode_ids,
        evidence_count, supporting_count, source_type_diversity,
        consolidation_checkpoint, embedding_model, embedding_version,
        consolidation_model, created_at, salience
      ) VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertVecSemantic = db.prepare('INSERT INTO vec_semantics(id, embedding, state) VALUES (?, ?, ?)');
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

    for (const cluster of clusters) {
      let principle: ExtractedPrinciple;
      if (extractPrinciple) {
        principle = await extractPrinciple(cluster);
      } else if (llmProvider) {
        principle = await llmExtractPrinciple(llmProvider, cluster);
      } else {
        principle = defaultExtractPrinciple(cluster);
      }

      if (!principle || !principle.content) continue;

      const vector = await embeddingProvider.embed(principle.content);
      const clusterIds = cluster.map(ep => ep.id);
      preparedClusters.push({
        principle,
        clusterIds,
        sourceTypeDiversity: new Set(cluster.map(ep => ep.source)).size,
        embeddingBuffer: embeddingProvider.vectorToBuffer(vector),
        memoryId: generateId(),
        createdAt: new Date().toISOString(),
        maxSalience: Math.max(...cluster.map(ep => ep.salience ?? 0.5)),
      });
    }

    db.prepare('BEGIN IMMEDIATE').run();
    try {
      for (const prepared of preparedClusters) {
        const placeholders = inClause(prepared.clusterIds);
        const eligibleCount = (db.prepare(`
          SELECT COUNT(*) AS count
          FROM episodes
          WHERE id IN (${placeholders})
            AND consolidated = 0
            AND superseded_by IS NULL
        `).get(...prepared.clusterIds) as CountRow).count;

        if (eligibleCount !== prepared.clusterIds.length) {
          continue;
        }

        if (prepared.principle.type === 'procedural') {
          insertProcedure.run(
            prepared.memoryId,
            prepared.principle.content,
            agent,
            prepared.embeddingBuffer,
            prepared.principle.conditions ? JSON.stringify(prepared.principle.conditions) : null,
            JSON.stringify(prepared.clusterIds),
            embeddingProvider.modelName,
            embeddingProvider.modelVersion,
            prepared.createdAt,
            prepared.maxSalience,
          );
          insertVecProcedure.run(prepared.memoryId, prepared.embeddingBuffer, 'active');
          insertFTSProcedure(db, prepared.memoryId, prepared.principle.content);
          proceduresExtracted++;
        } else {
          insertSemantic.run(
            prepared.memoryId,
            prepared.principle.content,
            agent,
            prepared.embeddingBuffer,
            JSON.stringify(prepared.clusterIds),
            prepared.clusterIds.length,
            prepared.clusterIds.length,
            prepared.sourceTypeDiversity,
            runId,
            embeddingProvider.modelName,
            embeddingProvider.modelVersion,
            llmProvider?.modelName || null,
            prepared.createdAt,
            prepared.maxSalience,
          );
          insertVecSemantic.run(prepared.memoryId, prepared.embeddingBuffer, 'active');
          insertFTSSemantic(db, prepared.memoryId, prepared.principle.content);
        }

        db.prepare(`UPDATE episodes SET consolidated = 1 WHERE id IN (${placeholders})`).run(...prepared.clusterIds);
        db.prepare(`UPDATE vec_episodes SET consolidated = ? WHERE id IN (${placeholders})`).run(
          BigInt(1),
          ...prepared.clusterIds,
        );

        allInputIds.push(...prepared.clusterIds);
        allOutputIds.push(prepared.memoryId);
        principlesExtracted++;
      }

      const completedAt = new Date().toISOString();
      updateRunCompleted.run(completedAt, JSON.stringify(allInputIds), JSON.stringify(allOutputIds), runId);
      insertMetrics.run(
        generateId(), runId, minClusterSize, similarityThreshold,
        episodesEvaluated, clusters.length, principlesExtracted, completedAt,
      );
      db.prepare('COMMIT').run();
    } catch (err) {
      if (db.inTransaction) {
        db.prepare('ROLLBACK').run();
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
