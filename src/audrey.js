import { EventEmitter } from 'node:events';
import { createDatabase, closeDatabase } from './db.js';
import { createEmbeddingProvider } from './embedding.js';
import { createLLMProvider } from './llm.js';
import { encodeEpisode } from './encode.js';
import { recall as recallFn, recallStream as recallStreamFn } from './recall.js';
import { validateMemory } from './validate.js';
import { runConsolidation } from './consolidate.js';
import { applyDecay } from './decay.js';
import { rollbackConsolidation, getConsolidationHistory } from './rollback.js';
import { forgetMemory, forgetByQuery as forgetByQueryFn, purgeMemories } from './forget.js';
import { introspect as introspectFn } from './introspect.js';
import { buildContextResolutionPrompt, buildReflectionPrompt } from './prompts.js';
import { exportMemories } from './export.js';
import { importMemories } from './import.js';
import { suggestConsolidationParams as suggestParamsFn } from './adaptive.js';
import { reembedAll } from './migrate.js';
import { applyInterference } from './interference.js';
import { detectResonance } from './affect.js';

/**
 * @typedef {'direct-observation' | 'told-by-user' | 'tool-result' | 'inference' | 'model-generated'} SourceType
 * @typedef {'episodic' | 'semantic' | 'procedural'} MemoryType
 *
 * @typedef {Object} EncodeParams
 * @property {string} content
 * @property {SourceType} source
 * @property {number} [salience]
 * @property {{ trigger?: string, consequence?: string }} [causal]
 * @property {string[]} [tags]
 * @property {string} [supersedes]
 * @property {Record<string, string>} [context]
 * @property {{ valence?: number, arousal?: number, label?: string }} [affect]
 *
 * @typedef {Object} RecallOptions
 * @property {number} [minConfidence]
 * @property {MemoryType[]} [types]
 * @property {number} [limit]
 * @property {boolean} [includeProvenance]
 * @property {boolean} [includeDormant]
 * @property {string[]} [tags]
 * @property {string[]} [sources]
 * @property {string} [after]
 * @property {string} [before]
 * @property {Record<string, string>} [context]
 * @property {{ valence?: number, arousal?: number }} [mood]
 *
 * @typedef {Object} RecallResult
 * @property {string} id
 * @property {string} content
 * @property {MemoryType} type
 * @property {number} confidence
 * @property {number} score
 * @property {string} source
 * @property {string} createdAt
 *
 * @typedef {Object} ConsolidationResult
 * @property {string} runId
 * @property {number} episodesEvaluated
 * @property {number} clustersFound
 * @property {number} principlesExtracted
 * @property {string} status
 *
 * @typedef {Object} IntrospectResult
 * @property {number} episodic
 * @property {number} semantic
 * @property {number} procedural
 * @property {number} causalLinks
 * @property {number} dormant
 * @property {{ open: number, resolved: number, context_dependent: number, reopened: number }} contradictions
 * @property {string | null} lastConsolidation
 * @property {number} totalConsolidationRuns
 *
 * @typedef {Object} TruthResolution
 * @property {'a_wins' | 'b_wins' | 'context_dependent'} resolution
 * @property {Object} [conditions]
 * @property {string} explanation
 *
 * @typedef {Object} AudreyConfig
 * @property {string} [dataDir]
 * @property {string} [agent]
 * @property {{ provider: 'mock' | 'openai', dimensions?: number, apiKey?: string }} [embedding]
 * @property {{ provider: 'mock' | 'anthropic' | 'openai', apiKey?: string, model?: string }} [llm]
 * @property {{ minEpisodes?: number }} [consolidation]
 * @property {{ dormantThreshold?: number }} [decay]
 */

export class Audrey extends EventEmitter {
  /** @param {AudreyConfig} [config] */
  constructor({
    dataDir = './audrey-data',
    agent = 'default',
    embedding = { provider: 'mock', dimensions: 64 },
    llm,
    confidence = {},
    consolidation = {},
    decay = {},
    interference = {},
    context = {},
    affect = {},
    autoReflect = false,
  } = {}) {
    super();

    const dormantThreshold = decay.dormantThreshold ?? 0.1;
    if (dormantThreshold < 0 || dormantThreshold > 1) {
      throw new Error(`dormantThreshold must be between 0 and 1, got: ${dormantThreshold}`);
    }

    const minEpisodes = consolidation.minEpisodes ?? 3;
    if (!Number.isInteger(minEpisodes) || minEpisodes < 1) {
      throw new Error(`minEpisodes must be a positive integer, got: ${minEpisodes}`);
    }

    this.agent = agent;
    this.dataDir = dataDir;
    this.embeddingProvider = createEmbeddingProvider(embedding);
    const { db, migrated } = createDatabase(dataDir, { dimensions: this.embeddingProvider.dimensions });
    this.db = db;
    this._migrationPending = migrated;
    this._pending = new Set();
    this.llmProvider = llm ? createLLMProvider(llm) : null;
    this.confidenceConfig = {
      weights: confidence.weights,
      halfLives: confidence.halfLives,
      sourceReliability: confidence.sourceReliability,
      interferenceWeight: interference.weight ?? 0.1,
      contextWeight: context.weight ?? 0.3,
      affectWeight: affect.weight ?? 0.2,
    };
    this.consolidationConfig = {
      minEpisodes: consolidation.minEpisodes ?? 3,
    };
    this.decayConfig = { dormantThreshold: decay.dormantThreshold ?? 0.1 };
    this._autoConsolidateTimer = null;
    this._closed = false;
    this.interferenceConfig = {
      enabled: interference.enabled ?? true,
      k: interference.k ?? 5,
      threshold: interference.threshold ?? 0.6,
      weight: interference.weight ?? 0.1,
    };
    this.contextConfig = {
      enabled: context.enabled ?? true,
      weight: context.weight ?? 0.3,
    };
    this.affectConfig = {
      enabled: affect.enabled ?? true,
      weight: affect.weight ?? 0.2,
      arousalWeight: affect.arousalWeight ?? 0.3,
      resonance: {
        enabled: affect.resonance?.enabled ?? true,
        k: affect.resonance?.k ?? 5,
        threshold: affect.resonance?.threshold ?? 0.5,
        affectThreshold: affect.resonance?.affectThreshold ?? 0.6,
      },
    };
    this.autoReflect = autoReflect;
  }

  async _ensureMigrated() {
    if (!this._migrationPending) return;
    const counts = await reembedAll(this.db, this.embeddingProvider);
    this._migrationPending = false;
    this.emit('migration', counts);
  }

  _trackAsync(promise) {
    this._pending.add(promise);
    promise.finally(() => this._pending.delete(promise));
  }

  _emitValidation(id, params) {
    const p = validateMemory(this.db, this.embeddingProvider, { id, ...params }, {
      llmProvider: this.llmProvider,
    })
      .then(validation => {
        if (validation.action === 'reinforced') {
          this.emit('reinforcement', {
            episodeId: id,
            targetId: validation.semanticId,
            similarity: validation.similarity,
          });
        } else if (validation.action === 'contradiction') {
          this.emit('contradiction', {
            episodeId: id,
            contradictionId: validation.contradictionId,
            semanticId: validation.semanticId,
            similarity: validation.similarity,
            resolution: validation.resolution,
          });
        }
      })
      .catch(err => { if (!this._closed) this.emit('error', err); });
    this._trackAsync(p);
  }

  /**
   * @param {EncodeParams} params
   * @returns {Promise<string>}
   */
  async encode(params) {
    await this._ensureMigrated();
    const encodeParams = { agent: this.agent, ...params, arousalWeight: this.affectConfig.arousalWeight };
    const id = await encodeEpisode(this.db, this.embeddingProvider, encodeParams);
    this.emit('encode', { id, ...params });
    if (this.interferenceConfig.enabled) {
      const p = applyInterference(this.db, this.embeddingProvider, id, params, this.interferenceConfig)
        .then(affected => {
          if (affected.length > 0) {
            this.emit('interference', { episodeId: id, affected });
          }
        })
        .catch(err => { if (!this._closed) this.emit('error', err); });
      this._trackAsync(p);
    }
    if (this.affectConfig.enabled && this.affectConfig.resonance.enabled && params.affect?.valence !== undefined) {
      const p = detectResonance(this.db, this.embeddingProvider, id, params, this.affectConfig.resonance)
        .then(echoes => {
          if (echoes.length > 0) {
            this.emit('resonance', { episodeId: id, affect: params.affect, echoes });
          }
        })
        .catch(err => { if (!this._closed) this.emit('error', err); });
      this._trackAsync(p);
    }
    this._emitValidation(id, params);
    return id;
  }


  async reflect(turns) {
    if (!this.llmProvider) return { encoded: 0, memories: [], skipped: 'no llm provider' };

    const prompt = buildReflectionPrompt(turns);
    let raw;
    try {
      raw = await this.llmProvider.chat(prompt);
    } catch (err) {
      this.emit('error', err);
      return { encoded: 0, memories: [], skipped: 'llm error' };
    }

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { encoded: 0, memories: [], skipped: 'invalid llm response' };
    }

    const memories = parsed.memories ?? [];
    let encoded = 0;
    for (const mem of memories) {
      if (!mem.content || !mem.source) continue;
      try {
        await this.encode({
          content: mem.content,
          source: mem.source,
          salience: mem.salience,
          tags: mem.tags,
          private: mem.private ?? false,
          affect: mem.affect ?? undefined,
        });
        encoded++;
      } catch (err) {
        this.emit('error', err);
      }
    }

    return { encoded, memories };
  }

  /**
   * @param {EncodeParams[]} paramsList
   * @returns {Promise<string[]>}
   */
  async encodeBatch(paramsList) {
    await this._ensureMigrated();
    const ids = [];
    for (const params of paramsList) {
      const id = await encodeEpisode(this.db, this.embeddingProvider, params);
      ids.push(id);
      this.emit('encode', { id, ...params });
    }

    for (let i = 0; i < ids.length; i++) {
      this._emitValidation(ids[i], paramsList[i]);
    }

    return ids;
  }

  /**
   * @param {string} query
   * @param {RecallOptions} [options]
   * @returns {Promise<RecallResult[]>}
   */
  async recall(query, options = {}) {
    await this._ensureMigrated();
    return recallFn(this.db, this.embeddingProvider, query, {
      agent: this.agent,
      ...options,
      confidenceConfig: this._recallConfig(options),
    });
  }

  /**
   * @param {string} query
   * @param {RecallOptions} [options]
   * @returns {AsyncGenerator<RecallResult>}
   */
  async *recallStream(query, options = {}) {
    await this._ensureMigrated();
    yield* recallStreamFn(this.db, this.embeddingProvider, query, {
      agent: this.agent,
      ...options,
      confidenceConfig: this._recallConfig(options),
    });
  }

  _recallConfig(options) {
    let config = options.confidenceConfig ?? this.confidenceConfig;
    if (this.contextConfig.enabled && options.context) {
      config = { ...config, retrievalContext: options.context };
    }
    if (this.affectConfig.enabled && options.mood) {
      config = { ...config, retrievalMood: options.mood };
    }
    return config;
  }

  /**
   * @param {{ minClusterSize?: number, similarityThreshold?: number, extractPrinciple?: Function, llmProvider?: import('./llm.js').LLMProvider }} [options]
   * @returns {Promise<ConsolidationResult>}
   */
  async consolidate(options = {}) {
    await this._ensureMigrated();
    const result = await runConsolidation(this.db, this.embeddingProvider, {
      minClusterSize: options.minClusterSize ?? this.consolidationConfig.minEpisodes,
      similarityThreshold: options.similarityThreshold ?? 0.80,
      extractPrinciple: options.extractPrinciple,
      llmProvider: options.llmProvider || this.llmProvider,
    });
    const run = this.db.prepare('SELECT status FROM consolidation_runs WHERE id = ?').get(result.runId);
    const output = { ...result, status: run?.status || 'completed' };
    this.emit('consolidation', output);
    return output;
  }

  /**
   * @param {{ dormantThreshold?: number }} [options]
   * @returns {{ totalEvaluated: number, transitionedToDormant: number, timestamp: string }}
   */
  decay(options = {}) {
    const result = applyDecay(this.db, {
      dormantThreshold: options.dormantThreshold ?? this.decayConfig.dormantThreshold,
      halfLives: options.halfLives ?? this.confidenceConfig.halfLives,
    });
    this.emit('decay', result);
    return result;
  }

  /**
   * @param {string} runId
   * @returns {{ rolledBackMemories: number, restoredEpisodes: number }}
   */
  rollback(runId) {
    const result = rollbackConsolidation(this.db, runId);
    this.emit('rollback', { runId, ...result });
    return result;
  }

  /**
   * @param {string} contradictionId
   * @returns {Promise<TruthResolution>}
   */
  async resolveTruth(contradictionId) {
    if (!this.llmProvider) {
      throw new Error('resolveTruth requires an LLM provider');
    }

    const contradiction = this.db.prepare(
      'SELECT * FROM contradictions WHERE id = ?'
    ).get(contradictionId);
    if (!contradiction) throw new Error(`Contradiction not found: ${contradictionId}`);

    const claimA = this._loadClaimContent(contradiction.claim_a_id, contradiction.claim_a_type);
    const claimB = this._loadClaimContent(contradiction.claim_b_id, contradiction.claim_b_type);

    const messages = buildContextResolutionPrompt(claimA, claimB);
    const result = await this.llmProvider.json(messages);

    const now = new Date().toISOString();
    const newState = result.resolution === 'context_dependent' ? 'context_dependent' : 'resolved';
    this.db.prepare(`
      UPDATE contradictions SET state = ?, resolution = ?, resolved_at = ?
      WHERE id = ?
    `).run(newState, JSON.stringify(result), now, contradictionId);

    if (result.resolution === 'a_wins' && contradiction.claim_a_type === 'semantic') {
      this.db.prepare("UPDATE semantics SET state = 'active' WHERE id = ?").run(contradiction.claim_a_id);
    }
    if (result.resolution === 'b_wins' && contradiction.claim_b_type === 'semantic') {
      this.db.prepare("UPDATE semantics SET state = 'active' WHERE id = ?").run(contradiction.claim_b_id);
    }
    if (result.resolution === 'context_dependent') {
      if (contradiction.claim_a_type === 'semantic' && result.conditions) {
        this.db.prepare("UPDATE semantics SET state = 'context_dependent', conditions = ? WHERE id = ?")
          .run(JSON.stringify(result.conditions), contradiction.claim_a_id);
      }
    }

    return result;
  }

  _loadClaimContent(claimId, claimType) {
    if (claimType === 'semantic') {
      const row = this.db.prepare('SELECT content FROM semantics WHERE id = ?').get(claimId);
      if (!row) throw new Error(`Semantic memory not found: ${claimId}`);
      return row.content;
    } else if (claimType === 'episodic') {
      const row = this.db.prepare('SELECT content FROM episodes WHERE id = ?').get(claimId);
      if (!row) throw new Error(`Episode not found: ${claimId}`);
      return row.content;
    }
    throw new Error(`Unknown claim type: ${claimType}`);
  }

  /** @returns {Array<{ id: string, input_episode_ids: string, output_memory_ids: string, started_at: string, completed_at: string, status: string }>} */
  consolidationHistory() {
    return getConsolidationHistory(this.db);
  }

  /** @returns {IntrospectResult} */
  introspect() {
    return introspectFn(this.db);
  }

  memoryStatus() {
    const episodes = this.db.prepare('SELECT COUNT(*) as c FROM episodes').get().c;
    const semantics = this.db.prepare('SELECT COUNT(*) as c FROM semantics').get().c;
    const procedures = this.db.prepare('SELECT COUNT(*) as c FROM procedures').get().c;
    const searchableEpisodes = this.db.prepare('SELECT COUNT(*) as c FROM episodes WHERE embedding IS NOT NULL').get().c;
    const searchableSemantics = this.db.prepare('SELECT COUNT(*) as c FROM semantics WHERE embedding IS NOT NULL').get().c;
    const searchableProcedures = this.db.prepare('SELECT COUNT(*) as c FROM procedures WHERE embedding IS NOT NULL').get().c;

    let vecEpisodes = 0, vecSemantics = 0, vecProcedures = 0;
    try {
      vecEpisodes = this.db.prepare('SELECT COUNT(*) as c FROM vec_episodes').get().c;
      vecSemantics = this.db.prepare('SELECT COUNT(*) as c FROM vec_semantics').get().c;
      vecProcedures = this.db.prepare('SELECT COUNT(*) as c FROM vec_procedures').get().c;
    } catch {
      // vec tables may not exist if no dimensions configured
    }

    const dimsRow = this.db.prepare("SELECT value FROM audrey_config WHERE key = 'dimensions'").get();
    const dimensions = dimsRow ? parseInt(dimsRow.value, 10) : null;
    const versionRow = this.db.prepare("SELECT value FROM audrey_config WHERE key = 'schema_version'").get();
    const schemaVersion = versionRow ? parseInt(versionRow.value, 10) : 0;

    const device = this.embeddingProvider._actualDevice
      ?? this.embeddingProvider.device
      ?? null;

    const healthy = episodes === vecEpisodes
      && semantics === vecSemantics
      && procedures === vecProcedures;
    const reembedRecommended = searchableEpisodes !== vecEpisodes
      || searchableSemantics !== vecSemantics
      || searchableProcedures !== vecProcedures;

    return {
      episodes,
      vec_episodes: vecEpisodes,
      semantics,
      vec_semantics: vecSemantics,
      procedures,
      vec_procedures: vecProcedures,
      searchable_episodes: searchableEpisodes,
      searchable_semantics: searchableSemantics,
      searchable_procedures: searchableProcedures,
      dimensions,
      schema_version: schemaVersion,
      device,
      healthy,
      reembed_recommended: reembedRecommended,
    };
  }

  async greeting({ context, recentLimit = 10, principleLimit = 5, identityLimit = 5 } = {}) {
    const recent = this.db.prepare(
      'SELECT id, content, source, tags, salience, created_at FROM episodes WHERE "private" = 0 ORDER BY created_at DESC LIMIT ?'
    ).all(recentLimit);

    const principles = this.db.prepare(
      'SELECT id, content, salience, created_at FROM semantics WHERE state = ? ORDER BY salience DESC LIMIT ?'
    ).all('active', principleLimit);

    const identity = this.db.prepare(
      'SELECT id, content, tags, salience, created_at FROM episodes WHERE "private" = 1 ORDER BY created_at DESC LIMIT ?'
    ).all(identityLimit);

    const unresolved = this.db.prepare(
      "SELECT id, content, tags, salience, created_at FROM episodes WHERE tags LIKE '%unresolved%' AND salience > 0.3 ORDER BY created_at DESC LIMIT 10"
    ).all();

    const rawAffectRows = this.db.prepare(
      "SELECT affect FROM episodes WHERE affect IS NOT NULL AND affect != '{}' ORDER BY created_at DESC LIMIT 20"
    ).all();

    const affectParsed = rawAffectRows
      .map(r => { try { return JSON.parse(r.affect); } catch { return null; } })
      .filter(a => a && a.valence !== undefined);

    let mood;
    if (affectParsed.length === 0) {
      mood = { valence: 0, arousal: 0, samples: 0 };
    } else {
      const sumV = affectParsed.reduce((s, a) => s + a.valence, 0);
      const sumA = affectParsed.reduce((s, a) => s + (a.arousal ?? 0), 0);
      mood = {
        valence: sumV / affectParsed.length,
        arousal: sumA / affectParsed.length,
        samples: affectParsed.length,
      };
    }

    const result = { recent, principles, mood, unresolved, identity };

    if (context) {
      result.contextual = await this.recall(context, { limit: 5, includePrivate: true });
    }

    return result;
  }

  async dream(options = {}) {
    await this._ensureMigrated();

    const consolidation = await this.consolidate({
      minClusterSize: options.minClusterSize,
      similarityThreshold: options.similarityThreshold,
    });

    const decay = this.decay({
      dormantThreshold: options.dormantThreshold,
    });

    const stats = this.introspect();

    const result = {
      consolidation,
      decay,
      stats,
    };

    this.emit('dream', result);
    return result;
  }

  export() {
    return exportMemories(this.db);
  }

  async import(snapshot) {
    return importMemories(this.db, this.embeddingProvider, snapshot);
  }

  startAutoConsolidate(intervalMs, options = {}) {
    if (intervalMs < 1000) {
      throw new Error('Auto-consolidation interval must be at least 1000ms');
    }
    if (this._autoConsolidateTimer) {
      throw new Error('Auto-consolidation is already running');
    }
    this._autoConsolidateTimer = setInterval(() => {
      this.consolidate(options).catch(err => this.emit('error', err));
    }, intervalMs);
    if (typeof this._autoConsolidateTimer.unref === 'function') {
      this._autoConsolidateTimer.unref();
    }
  }

  stopAutoConsolidate() {
    if (this._autoConsolidateTimer) {
      clearInterval(this._autoConsolidateTimer);
      this._autoConsolidateTimer = null;
    }
  }

  suggestConsolidationParams() {
    return suggestParamsFn(this.db);
  }

  forget(id, options = {}) {
    const result = forgetMemory(this.db, id, options);
    this.emit('forget', result);
    return result;
  }

  markUsed(id) {
    const now = new Date().toISOString();
    const tables = ['episodes', 'semantics', 'procedures'];
    for (const table of tables) {
      const result = this.db.prepare(
        `UPDATE ${table} SET usage_count = usage_count + 1, last_used_at = ? WHERE id = ?`
      ).run(now, id);
      if (result.changes > 0) {
        this.emit('used', { id, table, usageCount: result.changes });
        return;
      }
    }
  }

  async forgetByQuery(query, options = {}) {
    await this._ensureMigrated();
    const result = await forgetByQueryFn(this.db, this.embeddingProvider, query, options);
    if (result) this.emit('forget', result);
    return result;
  }

  purge() {
    const result = purgeMemories(this.db);
    this.emit('purge', result);
    return result;
  }

  close() {
    if (this._closed) return;
    this._closed = true;
    this.stopAutoConsolidate();
    this._pending.clear();
    closeDatabase(this.db);
  }
}
