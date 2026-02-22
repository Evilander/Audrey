export async function importMemories(db, embeddingProvider, snapshot) {
  const existingEpisodes = db.prepare('SELECT COUNT(*) as c FROM episodes').get().c;
  if (existingEpisodes > 0) {
    throw new Error('Cannot import into a database that is not empty');
  }

  const insertEpisode = db.prepare(`
    INSERT INTO episodes (id, content, source, source_reliability, salience, context, affect, tags,
      causal_trigger, causal_consequence, created_at, supersedes, superseded_by, consolidated)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertVecEpisode = db.prepare(
    'INSERT INTO vec_episodes(id, embedding, source, consolidated) VALUES (?, ?, ?, ?)'
  );

  const insertSemantic = db.prepare(`
    INSERT INTO semantics (id, content, state, conditions, evidence_episode_ids,
      evidence_count, supporting_count, contradicting_count, source_type_diversity,
      consolidation_checkpoint, created_at, last_reinforced_at, retrieval_count, challenge_count,
      interference_count, salience)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertVecSemantic = db.prepare(
    'INSERT INTO vec_semantics(id, embedding, state) VALUES (?, ?, ?)'
  );

  const insertProcedure = db.prepare(`
    INSERT INTO procedures (id, content, state, trigger_conditions, evidence_episode_ids,
      success_count, failure_count, created_at, last_reinforced_at, retrieval_count,
      interference_count, salience)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
    INSERT INTO consolidation_runs (id, input_episode_ids, output_memory_ids, started_at, completed_at, status)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  for (const ep of snapshot.episodes) {
    const tags = ep.tags ? JSON.stringify(ep.tags) : null;
    const context = ep.context ? JSON.stringify(ep.context) : '{}';
    const affect = ep.affect ? JSON.stringify(ep.affect) : '{}';
    insertEpisode.run(
      ep.id, ep.content, ep.source, ep.source_reliability, ep.salience ?? 0.5,
      context, affect, tags, ep.causal_trigger ?? null, ep.causal_consequence ?? null,
      ep.created_at, ep.supersedes ?? null, ep.superseded_by ?? null, ep.consolidated ?? 0,
    );

    const vector = await embeddingProvider.embed(ep.content);
    const buffer = embeddingProvider.vectorToBuffer(vector);
    insertVecEpisode.run(ep.id, buffer, ep.source, BigInt(ep.consolidated ?? 0));
  }

  for (const sem of (snapshot.semantics || [])) {
    insertSemantic.run(
      sem.id, sem.content, sem.state, sem.conditions ?? null,
      JSON.stringify(sem.evidence_episode_ids || []),
      sem.evidence_count ?? 0, sem.supporting_count ?? 0, sem.contradicting_count ?? 0,
      sem.source_type_diversity ?? 0, sem.consolidation_checkpoint ?? null,
      sem.created_at, sem.last_reinforced_at ?? null, sem.retrieval_count ?? 0, sem.challenge_count ?? 0,
      sem.interference_count ?? 0, sem.salience ?? 0.5,
    );

    const vector = await embeddingProvider.embed(sem.content);
    const buffer = embeddingProvider.vectorToBuffer(vector);
    insertVecSemantic.run(sem.id, buffer, sem.state);
  }

  for (const proc of (snapshot.procedures || [])) {
    insertProcedure.run(
      proc.id, proc.content, proc.state, proc.trigger_conditions ?? null,
      JSON.stringify(proc.evidence_episode_ids || []),
      proc.success_count ?? 0, proc.failure_count ?? 0,
      proc.created_at, proc.last_reinforced_at ?? null, proc.retrieval_count ?? 0,
      proc.interference_count ?? 0, proc.salience ?? 0.5,
    );

    const vector = await embeddingProvider.embed(proc.content);
    const buffer = embeddingProvider.vectorToBuffer(vector);
    insertVecProcedure.run(proc.id, buffer, proc.state);
  }

  for (const link of (snapshot.causalLinks || [])) {
    insertCausalLink.run(
      link.id, link.cause_id, link.effect_id, link.link_type ?? 'causal',
      link.mechanism ?? null, link.confidence ?? null, link.evidence_count ?? 1, link.created_at,
    );
  }

  for (const con of (snapshot.contradictions || [])) {
    insertContradiction.run(
      con.id, con.claim_a_id, con.claim_a_type, con.claim_b_id, con.claim_b_type,
      con.state, con.resolution ?? null, con.resolved_at ?? null,
      con.reopened_at ?? null, con.reopen_evidence_id ?? null, con.created_at,
    );
  }

  for (const run of (snapshot.consolidationRuns || [])) {
    insertConsolidationRun.run(
      run.id, JSON.stringify(run.input_episode_ids || []),
      JSON.stringify(run.output_memory_ids || []),
      run.started_at ?? null, run.completed_at ?? null, run.status,
    );
  }
}
