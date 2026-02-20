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
import { introspect as introspectFn } from './introspect.js';
import { buildContextResolutionPrompt } from './prompts.js';

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
 *
 * @typedef {Object} RecallOptions
 * @property {number} [minConfidence]
 * @property {MemoryType[]} [types]
 * @property {number} [limit]
 * @property {boolean} [includeProvenance]
 * @property {boolean} [includeDormant]
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
    consolidation = {},
    decay = {},
  } = {}) {
    super();
    this.agent = agent;
    this.dataDir = dataDir;
    this.embeddingProvider = createEmbeddingProvider(embedding);
    this.db = createDatabase(dataDir, { dimensions: this.embeddingProvider.dimensions });
    this.llmProvider = llm ? createLLMProvider(llm) : null;
    this.consolidationConfig = {
      minEpisodes: consolidation.minEpisodes || 3,
    };
    this.decayConfig = { dormantThreshold: decay.dormantThreshold || 0.1 };
  }

  _emitValidation(id, params) {
    validateMemory(this.db, this.embeddingProvider, { id, ...params }, {
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
      .catch(err => this.emit('error', err));
  }

  /**
   * @param {EncodeParams} params
   * @returns {Promise<string>}
   */
  async encode(params) {
    const id = await encodeEpisode(this.db, this.embeddingProvider, params);
    this.emit('encode', { id, ...params });
    this._emitValidation(id, params);
    return id;
  }

  /**
   * @param {EncodeParams[]} paramsList
   * @returns {Promise<string[]>}
   */
  async encodeBatch(paramsList) {
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
  recall(query, options = {}) {
    return recallFn(this.db, this.embeddingProvider, query, options);
  }

  /**
   * @param {string} query
   * @param {RecallOptions} [options]
   * @returns {AsyncGenerator<RecallResult>}
   */
  async *recallStream(query, options = {}) {
    yield* recallStreamFn(this.db, this.embeddingProvider, query, options);
  }

  /**
   * @param {{ minClusterSize?: number, similarityThreshold?: number, extractPrinciple?: Function, llmProvider?: import('./llm.js').LLMProvider }} [options]
   * @returns {Promise<ConsolidationResult>}
   */
  async consolidate(options = {}) {
    const result = await runConsolidation(this.db, this.embeddingProvider, {
      minClusterSize: options.minClusterSize || this.consolidationConfig.minEpisodes,
      similarityThreshold: options.similarityThreshold || 0.80,
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
      dormantThreshold: options.dormantThreshold || this.decayConfig.dormantThreshold,
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

  /** @returns {void} */
  close() {
    closeDatabase(this.db);
  }
}
