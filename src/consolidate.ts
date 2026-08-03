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
import { safeJsonParse } from './utils.js';

const DEFAULT_MERGE_SIMILARITY_THRESHOLD = 0.92;

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
      WHERE v.embedding MATCH ? AND k = ? AND v.agent = ? AND v.consolidated = 0 AND e.agent = ?
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

    const neighbors = (
      agent ? knnQuery.all(vecRow.embedding, k, agent, agent) : knnQuery.all(vecRow.embedding, k)
    ) as KnnRow[];
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
  _embeddingProvider: EmbeddingProvider,
  options: {
    similarityThreshold?: number;
    minClusterSize?: number;
    agent?: string;
    /** Restrict to episodes with private = 0. Mutually exclusive with onlyPrivate. */
    excludePrivate?: boolean;
    /** Restrict to episodes with private = 1. Mutually exclusive with excludePrivate. */
    onlyPrivate?: boolean;
  } = {},
): EpisodeRow[][] {
  const {
    similarityThreshold = 0.85,
    minClusterSize = 3,
    agent,
    excludePrivate = false,
    onlyPrivate = false,
  } = options;

  const privacyClause = onlyPrivate
    ? ' AND "private" = 1'
    : excludePrivate
      ? ' AND "private" = 0'
      : '';
  const episodeQuery = agent
    ? `SELECT * FROM episodes WHERE consolidated = 0 AND superseded_by IS NULL AND embedding IS NOT NULL AND agent = ?${privacyClause}`
    : `SELECT * FROM episodes WHERE consolidated = 0 AND superseded_by IS NULL AND embedding IS NOT NULL${privacyClause}`;
  const episodes = agent
    ? (db.prepare(episodeQuery).all(agent) as EpisodeRow[])
    : (db.prepare(episodeQuery).all() as EpisodeRow[]);

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

async function llmExtractPrinciple(
  llmProvider: LLMProvider,
  episodes: EpisodeRow[],
): Promise<ExtractedPrinciple> {
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
  /** null when this cluster never left the machine (local heuristic / private path). */
  consolidationModel: string | null;
}

async function buildPreparedCluster(
  embeddingProvider: EmbeddingProvider,
  cluster: EpisodeRow[],
  principle: ExtractedPrinciple,
  consolidationModel: string | null,
): Promise<PreparedCluster> {
  const vector = await embeddingProvider.embed(principle.content);
  return {
    principle,
    clusterIds: cluster.map(ep => ep.id),
    sourceTypeDiversity: new Set(cluster.map(ep => ep.source)).size,
    embeddingBuffer: embeddingProvider.vectorToBuffer(vector),
    memoryId: generateId(),
    createdAt: new Date().toISOString(),
    maxSalience: Math.max(...cluster.map(ep => ep.salience ?? 0.5)),
    consolidationModel,
  };
}

interface MergeMatch {
  id: string;
  similarity: number;
}

// Mirrors the vec_semantics/vec_procedures similarity lookup already used by
// src/interference.ts and src/validate.ts: a plain cosine-distance scan
// scoped to active/context_dependent memories for the same agent, rather
// than clusterViaKNN's vec0 MATCH plan (which is scoped to vec_episodes).
function findActiveSemanticMatch(
  db: Database.Database,
  agent: string,
  embeddingBuffer: Buffer,
): MergeMatch | null {
  const row = db
    .prepare(
      `
    SELECT s.id, (1.0 - vec_distance_cosine(v.embedding, ?)) AS similarity
    FROM vec_semantics v
    JOIN semantics s ON s.id = v.id
    WHERE v.agent = ?
      AND s.agent = ?
      AND (s.state = 'active' OR s.state = 'context_dependent')
    ORDER BY similarity DESC
    LIMIT 1
  `,
    )
    .get(embeddingBuffer, agent, agent) as MergeMatch | undefined;
  return row ?? null;
}

function findActiveProceduralMatch(
  db: Database.Database,
  agent: string,
  embeddingBuffer: Buffer,
): MergeMatch | null {
  const row = db
    .prepare(
      `
    SELECT p.id, (1.0 - vec_distance_cosine(v.embedding, ?)) AS similarity
    FROM vec_procedures v
    JOIN procedures p ON p.id = v.id
    WHERE v.agent = ?
      AND p.agent = ?
      AND (p.state = 'active' OR p.state = 'context_dependent')
    ORDER BY similarity DESC
    LIMIT 1
  `,
    )
    .get(embeddingBuffer, agent, agent) as MergeMatch | undefined;
  return row ?? null;
}

function unionEvidenceIds(
  existingRaw: string | null,
  newIds: string[],
): { ids: string[]; addedCount: number } {
  const ids = safeJsonParse<string[]>(existingRaw, []);
  const seen = new Set(ids);
  let addedCount = 0;
  for (const id of newIds) {
    if (!seen.has(id)) {
      ids.push(id);
      seen.add(id);
      addedCount++;
    }
  }
  return { ids, addedCount };
}

function sourceDiversityFor(db: Database.Database, evidenceIds: string[], agent: string): number {
  if (evidenceIds.length === 0) return 0;
  const placeholders = inClause(evidenceIds);
  const rows = db
    .prepare(`SELECT DISTINCT source FROM episodes WHERE id IN (${placeholders}) AND agent = ?`)
    .all(...evidenceIds, agent) as { source: string }[];
  return rows.length;
}

// Mirrors the bookkeeping src/validate.ts's reinforce() applies when a new
// episode matches an existing semantic, generalized to a whole cluster of
// new evidence ids landing at once.
function mergeIntoSemantic(
  db: Database.Database,
  semanticId: string,
  newEpisodeIds: string[],
  agent: string,
): void {
  const current = db
    .prepare('SELECT evidence_episode_ids FROM semantics WHERE id = ?')
    .get(semanticId) as { evidence_episode_ids: string | null } | undefined;
  const { ids, addedCount } = unionEvidenceIds(
    current?.evidence_episode_ids ?? null,
    newEpisodeIds,
  );
  const diversity = sourceDiversityFor(db, ids, agent);
  const now = new Date().toISOString();
  db.prepare(
    `
    UPDATE semantics SET
      supporting_count = supporting_count + ?,
      evidence_episode_ids = ?,
      evidence_count = ?,
      source_type_diversity = ?,
      last_reinforced_at = ?
    WHERE id = ?
  `,
  ).run(addedCount, JSON.stringify(ids), ids.length, diversity, now, semanticId);
}

function mergeIntoProcedural(
  db: Database.Database,
  proceduralId: string,
  newEpisodeIds: string[],
): void {
  const current = db
    .prepare('SELECT evidence_episode_ids FROM procedures WHERE id = ?')
    .get(proceduralId) as { evidence_episode_ids: string | null } | undefined;
  const { ids, addedCount } = unionEvidenceIds(
    current?.evidence_episode_ids ?? null,
    newEpisodeIds,
  );
  const now = new Date().toISOString();
  db.prepare(
    `
    UPDATE procedures SET
      success_count = success_count + ?,
      evidence_episode_ids = ?,
      last_reinforced_at = ?
    WHERE id = ?
  `,
  ).run(addedCount, JSON.stringify(ids), now, proceduralId);
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
    mergeSimilarityThreshold = DEFAULT_MERGE_SIMILARITY_THRESHOLD,
  } = options;

  const runId = generateId();
  const now = new Date().toISOString();

  db.prepare(
    `
    INSERT INTO consolidation_runs (
      id, started_at, status, input_episode_ids, output_memory_ids, consolidation_model, checkpoint_cursor
    )
    VALUES (?, ?, 'running', '[]', '[]', ?, ?)
  `,
  ).run(runId, now, llmProvider?.modelName || null, now);

  try {
    // Private memories must never be embedded into a prompt sent to a cloud
    // LLM. When an external llmProvider is configured, non-private episodes
    // cluster and extract normally (possibly via the LLM); private episodes
    // are clustered separately and always extracted through the local
    // heuristic (defaultExtractPrinciple), so they still consolidate instead
    // of sitting unconsolidated forever. With no llmProvider, everything is
    // already local, so private and non-private episodes cluster together
    // exactly as before.
    const restrictPrivateFromCloud = Boolean(llmProvider);
    const clusters = clusterEpisodes(db, embeddingProvider, {
      similarityThreshold,
      minClusterSize,
      agent,
      excludePrivate: restrictPrivateFromCloud,
    });
    const privateClusters = restrictPrivateFromCloud
      ? clusterEpisodes(db, embeddingProvider, {
          similarityThreshold,
          minClusterSize,
          agent,
          onlyPrivate: true,
        })
      : [];

    const episodesEvaluated = (
      agent
        ? (db
            .prepare(
              'SELECT COUNT(*) as count FROM episodes WHERE consolidated = 0 AND superseded_by IS NULL AND embedding IS NOT NULL AND agent = ?',
            )
            .get(agent) as CountRow)
        : (db
            .prepare(
              'SELECT COUNT(*) as count FROM episodes WHERE consolidated = 0 AND superseded_by IS NULL AND embedding IS NOT NULL',
            )
            .get() as CountRow)
    ).count;

    const allInputIds: string[] = [];
    const allOutputIds: string[] = [];
    let principlesExtracted = 0;
    let semanticsCreatedCount = 0;
    let proceduresCreatedCount = 0;
    let semanticsMergedCount = 0;
    let proceduresMergedCount = 0;
    const preparedClusters: PreparedCluster[] = [];
    const insertProcedure = db.prepare(`
      INSERT INTO procedures (
        id, content, agent, embedding, state, trigger_conditions,
        evidence_episode_ids, success_count, failure_count,
        embedding_model, embedding_version, created_at, salience
      ) VALUES (?, ?, ?, ?, 'active', ?, ?, 0, 0, ?, ?, ?, ?)
    `);
    const insertVecProcedure = db.prepare(
      'INSERT INTO vec_procedures(id, agent, embedding, state) VALUES (?, ?, ?, ?)',
    );
    const insertSemantic = db.prepare(`
      INSERT INTO semantics (
        id, content, agent, embedding, state, evidence_episode_ids,
        evidence_count, supporting_count, source_type_diversity,
        consolidation_checkpoint, embedding_model, embedding_version,
        consolidation_model, created_at, salience
      ) VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertVecSemantic = db.prepare(
      'INSERT INTO vec_semantics(id, agent, embedding, state) VALUES (?, ?, ?, ?)',
    );
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
      preparedClusters.push(
        await buildPreparedCluster(
          embeddingProvider,
          cluster,
          principle,
          llmProvider?.modelName || null,
        ),
      );
    }

    for (const cluster of privateClusters) {
      const principle = defaultExtractPrinciple(cluster);
      if (!principle || !principle.content) continue;
      preparedClusters.push(
        await buildPreparedCluster(embeddingProvider, cluster, principle, null),
      );
    }

    db.prepare('BEGIN IMMEDIATE').run();
    try {
      for (const prepared of preparedClusters) {
        const placeholders = inClause(prepared.clusterIds);
        const eligibleCount = (
          db
            .prepare(
              `
          SELECT COUNT(*) AS count
          FROM episodes
          WHERE id IN (${placeholders})
            AND consolidated = 0
            AND superseded_by IS NULL
        `,
            )
            .get(...prepared.clusterIds) as CountRow
        ).count;

        if (eligibleCount !== prepared.clusterIds.length) {
          continue;
        }

        const isProcedural = prepared.principle.type === 'procedural';
        const mergeMatch = isProcedural
          ? findActiveProceduralMatch(db, agent, prepared.embeddingBuffer)
          : findActiveSemanticMatch(db, agent, prepared.embeddingBuffer);
        const shouldMerge =
          mergeMatch !== null && mergeMatch.similarity >= mergeSimilarityThreshold;

        let outputId: string;
        if (shouldMerge && mergeMatch) {
          outputId = mergeMatch.id;
          if (isProcedural) {
            mergeIntoProcedural(db, mergeMatch.id, prepared.clusterIds);
            proceduresMergedCount++;
          } else {
            mergeIntoSemantic(db, mergeMatch.id, prepared.clusterIds, agent);
            semanticsMergedCount++;
          }
        } else {
          outputId = prepared.memoryId;
          if (isProcedural) {
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
            insertVecProcedure.run(prepared.memoryId, agent, prepared.embeddingBuffer, 'active');
            insertFTSProcedure(db, prepared.memoryId, prepared.principle.content);
            proceduresCreatedCount++;
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
              prepared.consolidationModel,
              prepared.createdAt,
              prepared.maxSalience,
            );
            insertVecSemantic.run(prepared.memoryId, agent, prepared.embeddingBuffer, 'active');
            insertFTSSemantic(db, prepared.memoryId, prepared.principle.content);
            semanticsCreatedCount++;
          }
        }

        db.prepare(`UPDATE episodes SET consolidated = 1 WHERE id IN (${placeholders})`).run(
          ...prepared.clusterIds,
        );
        db.prepare(`DELETE FROM vec_episodes WHERE id IN (${placeholders})`).run(
          ...prepared.clusterIds,
        );
        db.prepare(
          `
          INSERT INTO vec_episodes(id, agent, embedding, source, consolidated)
          SELECT id, agent, embedding, source, consolidated
          FROM episodes
          WHERE id IN (${placeholders}) AND embedding IS NOT NULL
        `,
        ).run(...prepared.clusterIds);

        allInputIds.push(...prepared.clusterIds);
        allOutputIds.push(outputId);
        principlesExtracted++;
      }

      const totalClustersFound = clusters.length + privateClusters.length;
      const completedAt = new Date().toISOString();
      updateRunCompleted.run(
        completedAt,
        JSON.stringify(allInputIds),
        JSON.stringify(allOutputIds),
        runId,
      );
      insertMetrics.run(
        generateId(),
        runId,
        minClusterSize,
        similarityThreshold,
        episodesEvaluated,
        totalClustersFound,
        principlesExtracted,
        completedAt,
      );
      db.prepare('COMMIT').run();

      return {
        runId,
        episodesEvaluated,
        clustersFound: totalClustersFound,
        principlesExtracted,
        semanticsCreated: semanticsCreatedCount,
        proceduresCreated: proceduresCreatedCount,
        semanticsMerged: semanticsMergedCount,
        proceduresMerged: proceduresMergedCount,
      };
    } catch (err) {
      if (db.inTransaction) {
        db.prepare('ROLLBACK').run();
      }
      throw err;
    }
  } catch (err) {
    const failedAt = new Date().toISOString();
    db.prepare(
      `
      UPDATE consolidation_runs
      SET status = 'failed', completed_at = ?
      WHERE id = ?
    `,
    ).run(failedAt, runId);
    throw err;
  }
}
