import { EventEmitter } from 'node:events';
import { createDatabase, closeDatabase } from './db.js';
import { createEmbeddingProvider } from './embedding.js';
import { encodeEpisode } from './encode.js';
import { recall as recallFn } from './recall.js';
import { validateMemory } from './validate.js';
import { runConsolidation } from './consolidate.js';
import { applyDecay } from './decay.js';
import { rollbackConsolidation, getConsolidationHistory } from './rollback.js';
import { introspect as introspectFn } from './introspect.js';

export class Audrey extends EventEmitter {
  constructor({
    dataDir = './audrey-data',
    agent = 'default',
    embedding = { provider: 'mock', dimensions: 64 },
    consolidation = {},
    decay = {},
  } = {}) {
    super();
    this.agent = agent;
    this.dataDir = dataDir;
    this.db = createDatabase(dataDir);
    this.embeddingProvider = createEmbeddingProvider(embedding);
    this.consolidationConfig = {
      interval: consolidation.interval || '1h',
      minEpisodes: consolidation.minEpisodes || 3,
      confidenceTarget: consolidation.confidenceTarget || 2.0,
      llm: consolidation.llm || null,
    };
    this.decayConfig = { dormantThreshold: decay.dormantThreshold || 0.1 };
    this._consolidationTimer = null;
  }

  async encode(params) {
    const id = await encodeEpisode(this.db, this.embeddingProvider, params);
    this.emit('encode', { id, ...params });
    // Async validation (non-blocking)
    validateMemory(this.db, this.embeddingProvider, { id, ...params }).then(result => {
      if (result.action === 'reinforced') {
        this.emit('reinforcement', {
          episodeId: id,
          targetId: result.targetId || result.semanticId,
          similarity: result.similarity,
        });
      }
    }).catch(() => {});
    return id;
  }

  async recall(query, options = {}) {
    return recallFn(this.db, this.embeddingProvider, query, options);
  }

  async consolidate(options = {}) {
    const result = await runConsolidation(this.db, this.embeddingProvider, {
      minClusterSize: options.minClusterSize || this.consolidationConfig.minEpisodes,
      similarityThreshold: options.similarityThreshold || 0.80,
      extractPrinciple: options.extractPrinciple,
    });
    // Fetch the run status from the DB for a complete result
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
