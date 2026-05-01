import Database from 'better-sqlite3';
import { z } from 'zod';
import type { EmbeddingProvider } from './types.js';
import { insertFTSEpisode, insertFTSSemantic, insertFTSProcedure } from './fts.js';
import { sourceReliability } from './confidence.js';

export const MAX_IMPORT_CONTENT_LENGTH = 50_000;
export const MAX_IMPORT_ROWS_PER_SECTION = 25_000;
export const MAX_IMPORT_TOTAL_CONTENT_BYTES = 25_000_000;

const sourceSchema = z.enum([
  'direct-observation',
  'told-by-user',
  'tool-result',
  'inference',
  'model-generated',
]);

const memoryStateSchema = z.enum([
  'active',
  'disputed',
  'superseded',
  'context_dependent',
  'dormant',
  'rolled_back',
]);

const idSchema = z.string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/, 'id must use stable memory-id characters');
const optionalIdSchema = idSchema.nullable().optional();
const contentSchema = z.string().min(1).max(MAX_IMPORT_CONTENT_LENGTH);
const optionalTextSchema = z.string().max(MAX_IMPORT_CONTENT_LENGTH).nullable().optional();
const isoLikeStringSchema = z.string().min(1).max(64);
const countSchema = z.number().int().nonnegative();
const scoreSchema = z.number().finite().min(0).max(1);
const jsonObjectSchema = z.record(z.string(), z.unknown());
const stringArraySchema = z.array(z.string().max(512)).max(1000);

const exportedEpisodeSchema = z.object({
  id: idSchema,
  content: contentSchema,
  source: sourceSchema,
  agent: z.string().min(1).max(128).optional(),
  source_reliability: scoreSchema.optional(),
  salience: scoreSchema.optional(),
  context: jsonObjectSchema.nullable().optional(),
  affect: jsonObjectSchema.nullable().optional(),
  tags: stringArraySchema.nullable().optional(),
  causal_trigger: optionalTextSchema,
  causal_consequence: optionalTextSchema,
  created_at: isoLikeStringSchema,
  embedding_model: optionalTextSchema,
  embedding_version: optionalTextSchema,
  supersedes: optionalIdSchema,
  superseded_by: optionalIdSchema,
  consolidated: z.union([z.literal(0), z.literal(1)]).optional(),
  private: z.union([z.literal(0), z.literal(1)]).optional(),
});

const exportedSemanticSchema = z.object({
  id: idSchema,
  content: contentSchema,
  agent: z.string().min(1).max(128).optional(),
  state: memoryStateSchema,
  conditions: optionalTextSchema,
  evidence_episode_ids: stringArraySchema.optional(),
  evidence_count: countSchema.optional(),
  supporting_count: countSchema.optional(),
  contradicting_count: countSchema.optional(),
  source_type_diversity: countSchema.optional(),
  consolidation_checkpoint: optionalTextSchema,
  embedding_model: optionalTextSchema,
  embedding_version: optionalTextSchema,
  consolidation_model: optionalTextSchema,
  consolidation_prompt_hash: optionalTextSchema,
  created_at: isoLikeStringSchema,
  last_reinforced_at: optionalTextSchema,
  retrieval_count: countSchema.optional(),
  challenge_count: countSchema.optional(),
  interference_count: countSchema.optional(),
  salience: scoreSchema.optional(),
});

const exportedProcedureSchema = z.object({
  id: idSchema,
  content: contentSchema,
  agent: z.string().min(1).max(128).optional(),
  state: memoryStateSchema,
  trigger_conditions: optionalTextSchema,
  evidence_episode_ids: stringArraySchema.optional(),
  success_count: countSchema.optional(),
  failure_count: countSchema.optional(),
  embedding_model: optionalTextSchema,
  embedding_version: optionalTextSchema,
  created_at: isoLikeStringSchema,
  last_reinforced_at: optionalTextSchema,
  retrieval_count: countSchema.optional(),
  interference_count: countSchema.optional(),
  salience: scoreSchema.optional(),
});

const exportedCausalLinkSchema = z.object({
  id: idSchema,
  cause_id: idSchema,
  effect_id: idSchema,
  link_type: z.enum(['causal', 'correlational', 'temporal']).optional(),
  mechanism: optionalTextSchema,
  confidence: scoreSchema.nullable().optional(),
  evidence_count: countSchema.optional(),
  created_at: isoLikeStringSchema,
});

const exportedContradictionSchema = z.object({
  id: idSchema,
  claim_a_id: idSchema,
  claim_a_type: z.string().min(1).max(64),
  claim_b_id: idSchema,
  claim_b_type: z.string().min(1).max(64),
  state: z.enum(['open', 'resolved', 'context_dependent', 'reopened']),
  resolution: optionalTextSchema,
  resolved_at: optionalTextSchema,
  reopened_at: optionalTextSchema,
  reopen_evidence_id: optionalIdSchema,
  created_at: isoLikeStringSchema,
});

const exportedConsolidationRunSchema = z.object({
  id: idSchema,
  checkpoint_cursor: optionalTextSchema,
  input_episode_ids: stringArraySchema.optional(),
  output_memory_ids: stringArraySchema.optional(),
  confidence_deltas: jsonObjectSchema.nullable().optional(),
  consolidation_model: optionalTextSchema,
  consolidation_prompt_hash: optionalTextSchema,
  started_at: optionalTextSchema,
  completed_at: optionalTextSchema,
  status: z.enum(['running', 'completed', 'failed', 'rolled_back']),
});

const exportedConsolidationMetricSchema = z.object({
  id: idSchema,
  run_id: idSchema,
  min_cluster_size: countSchema,
  similarity_threshold: scoreSchema,
  episodes_evaluated: countSchema,
  clusters_found: countSchema,
  principles_extracted: countSchema,
  created_at: isoLikeStringSchema,
});

const exportedMemoryEventSchema = z.object({
  id: idSchema,
  session_id: optionalTextSchema,
  event_type: z.string().min(1).max(128),
  source: z.string().min(1).max(256),
  actor_agent: optionalTextSchema,
  tool_name: optionalTextSchema,
  input_hash: optionalTextSchema,
  output_hash: optionalTextSchema,
  outcome: z.enum(['succeeded', 'failed', 'blocked', 'skipped', 'unknown']).nullable().optional(),
  error_summary: optionalTextSchema,
  cwd: optionalTextSchema,
  file_fingerprints: optionalTextSchema,
  redaction_state: z.enum(['unreviewed', 'redacted', 'clean', 'quarantined']).nullable().optional(),
  metadata: optionalTextSchema,
  created_at: isoLikeStringSchema,
});

export const importSnapshotSchema = z.object({
  version: z.string().min(1).max(64),
  exportedAt: isoLikeStringSchema.optional(),
  episodes: z.array(exportedEpisodeSchema).max(MAX_IMPORT_ROWS_PER_SECTION),
  semantics: z.array(exportedSemanticSchema).max(MAX_IMPORT_ROWS_PER_SECTION).optional(),
  procedures: z.array(exportedProcedureSchema).max(MAX_IMPORT_ROWS_PER_SECTION).optional(),
  causalLinks: z.array(exportedCausalLinkSchema).max(MAX_IMPORT_ROWS_PER_SECTION).optional(),
  contradictions: z.array(exportedContradictionSchema).max(MAX_IMPORT_ROWS_PER_SECTION).optional(),
  consolidationRuns: z.array(exportedConsolidationRunSchema).max(MAX_IMPORT_ROWS_PER_SECTION).optional(),
  consolidationMetrics: z.array(exportedConsolidationMetricSchema).max(MAX_IMPORT_ROWS_PER_SECTION).optional(),
  memoryEvents: z.array(exportedMemoryEventSchema).max(MAX_IMPORT_ROWS_PER_SECTION).optional(),
  config: z.record(z.string(), z.string()).optional(),
});

type ImportSnapshot = z.infer<typeof importSnapshotSchema>;

interface CountRow {
  c: number;
}

function jsonOrNull(value: unknown): string | null {
  return value == null ? null : JSON.stringify(value);
}

function isDatabaseEmpty(db: Database.Database): boolean {
  const tables = [
    'episodes',
    'semantics',
    'procedures',
    'causal_links',
    'contradictions',
    'consolidation_runs',
    'consolidation_metrics',
    'memory_events',
  ];

  return tables.every(table => (db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as CountRow).c === 0);
}

function validateSnapshotBudget(snapshot: ImportSnapshot): void {
  const totalBytes = [
    ...snapshot.episodes.map(ep => ep.content.length),
    ...(snapshot.semantics || []).map(sem => sem.content.length),
    ...(snapshot.procedures || []).map(proc => proc.content.length),
  ].reduce((sum, n) => sum + n, 0);
  if (totalBytes > MAX_IMPORT_TOTAL_CONTENT_BYTES) {
    throw new Error(`snapshot content exceeds import budget of ${MAX_IMPORT_TOTAL_CONTENT_BYTES} bytes`);
  }
}

export async function importMemories(db: Database.Database, embeddingProvider: EmbeddingProvider, rawSnapshot: unknown): Promise<void> {
  if (!isDatabaseEmpty(db)) {
    throw new Error('Cannot import into a database that is not empty');
  }

  const snapshot: ImportSnapshot = importSnapshotSchema.parse(rawSnapshot);
  validateSnapshotBudget(snapshot);
  const episodes = snapshot.episodes;
  const semantics = snapshot.semantics || [];
  const procedures = snapshot.procedures || [];
  const causalLinks = snapshot.causalLinks || [];
  const contradictions = snapshot.contradictions || [];
  const consolidationRuns = snapshot.consolidationRuns || [];
  const consolidationMetrics = snapshot.consolidationMetrics || [];
  const memoryEvents = snapshot.memoryEvents || [];

  const episodeVectors = episodes.length > 0
    ? await embeddingProvider.embedBatch(episodes.map(ep => ep.content))
    : [];
  const semanticVectors = semantics.length > 0
    ? await embeddingProvider.embedBatch(semantics.map(sem => sem.content))
    : [];
  const procedureVectors = procedures.length > 0
    ? await embeddingProvider.embedBatch(procedures.map(proc => proc.content))
    : [];

  const insertEpisode = db.prepare(`
    INSERT INTO episodes (id, content, embedding, source, agent, source_reliability, salience, context, affect, tags,
      causal_trigger, causal_consequence, created_at, embedding_model, embedding_version,
      supersedes, superseded_by, consolidated, "private")
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertVecEpisode = db.prepare(
    'INSERT INTO vec_episodes(id, embedding, source, consolidated) VALUES (?, ?, ?, ?)'
  );

  const insertSemantic = db.prepare(`
    INSERT INTO semantics (id, content, agent, embedding, state, conditions, evidence_episode_ids,
      evidence_count, supporting_count, contradicting_count, source_type_diversity,
      consolidation_checkpoint, embedding_model, embedding_version, consolidation_model,
      consolidation_prompt_hash, created_at, last_reinforced_at, retrieval_count, challenge_count,
      interference_count, salience)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertVecSemantic = db.prepare(
    'INSERT INTO vec_semantics(id, embedding, state) VALUES (?, ?, ?)'
  );

  const insertProcedure = db.prepare(`
    INSERT INTO procedures (id, content, agent, embedding, state, trigger_conditions, evidence_episode_ids,
      success_count, failure_count, embedding_model, embedding_version, created_at, last_reinforced_at,
      retrieval_count, interference_count, salience)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertVecProcedure = db.prepare(
    'INSERT INTO vec_procedures(id, embedding, state) VALUES (?, ?, ?)'
  );

  const insertCausalLink = db.prepare(`
    INSERT INTO causal_links (id, cause_id, effect_id, link_type, mechanism, confidence, evidence_count, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertContradiction = db.prepare(`
    INSERT INTO contradictions (id, claim_a_id, claim_a_type, claim_b_id, claim_b_type,
      state, resolution, resolved_at, reopened_at, reopen_evidence_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertConsolidationRun = db.prepare(`
    INSERT INTO consolidation_runs (id, checkpoint_cursor, input_episode_ids, output_memory_ids,
      confidence_deltas, consolidation_model, consolidation_prompt_hash, started_at, completed_at, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertConsolidationMetric = db.prepare(`
    INSERT INTO consolidation_metrics (id, run_id, min_cluster_size, similarity_threshold,
      episodes_evaluated, clusters_found, principles_extracted, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertMemoryEvent = db.prepare(`
    INSERT INTO memory_events (
      id, session_id, event_type, source, actor_agent, tool_name,
      input_hash, output_hash, outcome, error_summary, cwd, file_fingerprints,
      redaction_state, metadata, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const upsertConfig = db.prepare(`
    INSERT INTO audrey_config (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `);

  const writeImport = db.transaction(() => {
    for (let i = 0; i < episodes.length; i++) {
      const ep = episodes[i]!;
      const embeddingBuffer = embeddingProvider.vectorToBuffer(episodeVectors[i]!);
      insertEpisode.run(
        ep.id,
        ep.content,
        embeddingBuffer,
        ep.source,
        ep.agent ?? 'default',
        ep.source_reliability ?? sourceReliability(ep.source),
        ep.salience ?? 0.5,
        jsonOrNull(ep.context ?? {}),
        jsonOrNull(ep.affect ?? {}),
        jsonOrNull(ep.tags),
        ep.causal_trigger ?? null,
        ep.causal_consequence ?? null,
        ep.created_at,
        embeddingProvider.modelName,
        embeddingProvider.modelVersion,
        ep.supersedes ?? null,
        ep.superseded_by ?? null,
        ep.consolidated ?? 0,
        ep.private ?? 0,
      );
      insertVecEpisode.run(ep.id, embeddingBuffer, ep.source, BigInt(ep.consolidated ?? 0));
      insertFTSEpisode(db, ep.id, ep.content, ep.tags ?? null);
    }

    for (let i = 0; i < semantics.length; i++) {
      const sem = semantics[i]!;
      const embeddingBuffer = embeddingProvider.vectorToBuffer(semanticVectors[i]!);
      insertSemantic.run(
        sem.id,
        sem.content,
        sem.agent ?? 'default',
        embeddingBuffer,
        sem.state,
        sem.conditions ?? null,
        jsonOrNull(sem.evidence_episode_ids || []),
        sem.evidence_count ?? 0,
        sem.supporting_count ?? 0,
        sem.contradicting_count ?? 0,
        sem.source_type_diversity ?? 0,
        sem.consolidation_checkpoint ?? null,
        embeddingProvider.modelName,
        embeddingProvider.modelVersion,
        sem.consolidation_model ?? null,
        sem.consolidation_prompt_hash ?? null,
        sem.created_at,
        sem.last_reinforced_at ?? null,
        sem.retrieval_count ?? 0,
        sem.challenge_count ?? 0,
        sem.interference_count ?? 0,
        sem.salience ?? 0.5,
      );
      insertVecSemantic.run(sem.id, embeddingBuffer, sem.state);
      insertFTSSemantic(db, sem.id, sem.content);
    }

    for (let i = 0; i < procedures.length; i++) {
      const proc = procedures[i]!;
      const embeddingBuffer = embeddingProvider.vectorToBuffer(procedureVectors[i]!);
      insertProcedure.run(
        proc.id,
        proc.content,
        proc.agent ?? 'default',
        embeddingBuffer,
        proc.state,
        proc.trigger_conditions ?? null,
        jsonOrNull(proc.evidence_episode_ids || []),
        proc.success_count ?? 0,
        proc.failure_count ?? 0,
        embeddingProvider.modelName,
        embeddingProvider.modelVersion,
        proc.created_at,
        proc.last_reinforced_at ?? null,
        proc.retrieval_count ?? 0,
        proc.interference_count ?? 0,
        proc.salience ?? 0.5,
      );
      insertVecProcedure.run(proc.id, embeddingBuffer, proc.state);
      insertFTSProcedure(db, proc.id, proc.content);
    }

    for (const link of causalLinks) {
      insertCausalLink.run(
        link.id,
        link.cause_id,
        link.effect_id,
        link.link_type ?? 'causal',
        link.mechanism ?? null,
        link.confidence ?? null,
        link.evidence_count ?? 1,
        link.created_at,
      );
    }

    for (const contradiction of contradictions) {
      insertContradiction.run(
        contradiction.id,
        contradiction.claim_a_id,
        contradiction.claim_a_type,
        contradiction.claim_b_id,
        contradiction.claim_b_type,
        contradiction.state,
        contradiction.resolution ?? null,
        contradiction.resolved_at ?? null,
        contradiction.reopened_at ?? null,
        contradiction.reopen_evidence_id ?? null,
        contradiction.created_at,
      );
    }

    for (const run of consolidationRuns) {
      insertConsolidationRun.run(
        run.id,
        run.checkpoint_cursor ?? null,
        jsonOrNull(run.input_episode_ids || []),
        jsonOrNull(run.output_memory_ids || []),
        jsonOrNull(run.confidence_deltas),
        run.consolidation_model ?? null,
        run.consolidation_prompt_hash ?? null,
        run.started_at ?? null,
        run.completed_at ?? null,
        run.status,
      );
    }

    for (const metric of consolidationMetrics) {
      insertConsolidationMetric.run(
        metric.id,
        metric.run_id,
        metric.min_cluster_size,
        metric.similarity_threshold,
        metric.episodes_evaluated,
        metric.clusters_found,
        metric.principles_extracted,
        metric.created_at,
      );
    }

    for (const event of memoryEvents) {
      insertMemoryEvent.run(
        event.id,
        event.session_id ?? null,
        event.event_type,
        event.source,
        event.actor_agent ?? null,
        event.tool_name ?? null,
        event.input_hash ?? null,
        event.output_hash ?? null,
        event.outcome ?? null,
        event.error_summary ?? null,
        event.cwd ?? null,
        event.file_fingerprints ?? null,
        event.redaction_state ?? 'unreviewed',
        event.metadata ?? null,
        event.created_at,
      );
    }

    for (const [key, value] of Object.entries((snapshot.config || {}) as Record<string, unknown>)) {
      if (key !== 'schema_version') continue;
      upsertConfig.run(key, String(value));
    }
  });

  writeImport();
}
