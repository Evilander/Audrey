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

export class Audrey extends EventEmitter {
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
      interval: consolidation.interval || '1h',
      minEpisodes: consolidation.minEpisodes || 3,
      confidenceTarget: consolidation.confidenceTarget || 2.0,
    };
    this.decayConfig = { dormantThreshold: decay.dormantThreshold || 0.1 };
    this._consolidationTimer = null;
  }

  async encode(params) {
    if (!params.content || typeof params.content !== 'string') {
      throw new Error('content must be a non-empty string');
    }
    const id = await encodeEpisode(this.db, this.embeddingProvider, params);
    this.emit('encode', { id, ...params });

    validateMemory(this.db, this.embeddingProvider, { id, ...params }, {
      llmProvider: this.llmProvider,
    })
      .then(result => {
        if (result.action === 'reinforced') {
          this.emit('reinforcement', {
            episodeId: id,
            targetId: result.semanticId,
            similarity: result.similarity,
          });
        } else if (result.action === 'contradiction') {
          this.emit('contradiction', {
            episodeId: id,
            contradictionId: result.contradictionId,
            semanticId: result.semanticId,
            similarity: result.similarity,
            resolution: result.resolution,
          });
        }
      })
      .catch(err => this.emit('error', err));

    return id;
  }

  async encodeBatch(paramsList) {
    for (const p of paramsList) {
      if (!p.content || typeof p.content !== 'string') {
        throw new Error('content must be a non-empty string');
      }
    }

    const ids = [];
    for (const params of paramsList) {
      const id = await encodeEpisode(this.db, this.embeddingProvider, params);
      ids.push(id);
      this.emit('encode', { id, ...params });
    }

    for (let i = 0; i < ids.length; i++) {
      validateMemory(this.db, this.embeddingProvider, { id: ids[i], ...paramsList[i] }, {
        llmProvider: this.llmProvider,
      })
        .then(result => {
          if (result.action === 'reinforced') {
            this.emit('reinforcement', { episodeId: ids[i], targetId: result.semanticId, similarity: result.similarity });
          } else if (result.action === 'contradiction') {
            this.emit('contradiction', { episodeId: ids[i], contradictionId: result.contradictionId, semanticId: result.semanticId, similarity: result.similarity, resolution: result.resolution });
          }
        })
        .catch(err => this.emit('error', err));
    }

    return ids;
  }

  async recall(query, options = {}) {
    return recallFn(this.db, this.embeddingProvider, query, options);
  }

  async *recallStream(query, options = {}) {
    yield* recallStreamFn(this.db, this.embeddingProvider, query, options);
  }

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

  decay(options = {}) {
    const result = applyDecay(this.db, {
      dormantThreshold: options.dormantThreshold || this.decayConfig.dormantThreshold,
    });
    this.emit('decay', result);
    return result;
  }

  rollback(runId) {
    const result = rollbackConsolidation(this.db, runId);
    this.emit('rollback', { runId, ...result });
    return result;
  }

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
      return row?.content || claimId;
    } else if (claimType === 'episodic') {
      const row = this.db.prepare('SELECT content FROM episodes WHERE id = ?').get(claimId);
      return row?.content || claimId;
    }
    return claimId;
  }

  consolidationHistory() {
    return getConsolidationHistory(this.db);
  }

  introspect() {
    return introspectFn(this.db);
  }

  close() {
    if (this._consolidationTimer) {
      clearInterval(this._consolidationTimer);
      this._consolidationTimer = null;
    }
    closeDatabase(this.db);
  }
}
