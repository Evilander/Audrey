function jsonOrNull(value) {
  return value == null ? null : JSON.stringify(value);
}

function isDatabaseEmpty(db) {
  const tables = [
    'episodes',
    'semantics',
    'procedures',
    'causal_links',
    'contradictions',
    'consolidation_runs',
    'consolidation_metrics',
  ];

  return tables.every(table => db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get().c === 0);
}

const VALID_SOURCES = new Set(['direct-observation', 'told-by-user', 'tool-result', 'inference', 'model-generated']);

function validateSnapshot(snapshot) {
  const errors = [];
  for (let i = 0; i < (snapshot.episodes || []).length; i++) {
    const ep = snapshot.episodes[i];
    if (!ep.id) errors.push(`episodes[${i}]: missing id`);
    if (!ep.content) errors.push(`episodes[${i}]: missing content`);
    if (!ep.source || !VALID_SOURCES.has(ep.source)) errors.push(`episodes[${i}]: invalid source "${ep.source}"`);
  }
  for (let i = 0; i < (snapshot.semantics || []).length; i++) {
    const sem = snapshot.semantics[i];
    if (!sem.id) errors.push(`semantics[${i}]: missing id`);
    if (!sem.content) errors.push(`semantics[${i}]: missing content`);
  }
  for (let i = 0; i < (snapshot.procedures || []).length; i++) {
    const proc = snapshot.procedures[i];
    if (!proc.id) errors.push(`procedures[${i}]: missing id`);
    if (!proc.content) errors.push(`procedures[${i}]: missing content`);
  }
  return errors;
}

export async function importMemories(db, embeddingProvider, snapshot) {
  if (!isDatabaseEmpty(db)) {
    throw new Error('Cannot import into a database that is not empty');
  }

  const validationErrors = validateSnapshot(snapshot);
  if (validationErrors.length > 0) {
    throw new Error(`Invalid snapshot: ${validationErrors.join('; ')}`);
  }

  const episodes = snapshot.episodes || [];
  const semantics = snapshot.semantics || [];
  const procedures = snapshot.procedures || [];
  const causalLinks = snapshot.causalLinks || [];
  const contradictions = snapshot.contradictions || [];
  const consolidationRuns = snapshot.consolidationRuns || [];
  const consolidationMetrics = snapshot.consolidationMetrics || [];

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
    INSERT INTO episodes (id, content, embedding, source, source_reliability, salience, context, affect, tags,
      causal_trigger, causal_consequence, created_at, embedding_model, embedding_version,
      supersedes, superseded_by, consolidated, "private")
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertVecEpisode = db.prepare(
    'INSERT INTO vec_episodes(id, embedding, source, consolidated) VALUES (?, ?, ?, ?)'
  );

  const insertSemantic = db.prepare(`
    INSERT INTO semantics (id, content, embedding, state, conditions, evidence_episode_ids,
      evidence_count, supporting_count, contradicting_count, source_type_diversity,
      consolidation_checkpoint, embedding_model, embedding_version, consolidation_model,
      consolidation_prompt_hash, created_at, last_reinforced_at, retrieval_count, challenge_count,
      interference_count, salience)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertVecSemantic = db.prepare(
    'INSERT INTO vec_semantics(id, embedding, state) VALUES (?, ?, ?)'
  );

  const insertProcedure = db.prepare(`
    INSERT INTO procedures (id, content, embedding, state, trigger_conditions, evidence_episode_ids,
      success_count, failure_count, embedding_model, embedding_version, created_at, last_reinforced_at,
      retrieval_count, interference_count, salience)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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

  const upsertConfig = db.prepare(`
    INSERT INTO audrey_config (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `);

  const writeImport = db.transaction(() => {
    for (let i = 0; i < episodes.length; i++) {
      const ep = episodes[i];
      const embeddingBuffer = embeddingProvider.vectorToBuffer(episodeVectors[i]);
      insertEpisode.run(
        ep.id,
        ep.content,
        embeddingBuffer,
        ep.source,
        ep.source_reliability,
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
    }

    for (let i = 0; i < semantics.length; i++) {
      const sem = semantics[i];
      const embeddingBuffer = embeddingProvider.vectorToBuffer(semanticVectors[i]);
      insertSemantic.run(
        sem.id,
        sem.content,
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
    }

    for (let i = 0; i < procedures.length; i++) {
      const proc = procedures[i];
      const embeddingBuffer = embeddingProvider.vectorToBuffer(procedureVectors[i]);
      insertProcedure.run(
        proc.id,
        proc.content,
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

    for (const [key, value] of Object.entries(snapshot.config || {})) {
      if (key === 'dimensions') continue;
      upsertConfig.run(key, String(value));
    }
  });

  writeImport();
}
