import { createHash } from 'node:crypto';
import { describeHttpError, requireApiKey } from './utils.js';

/**
 * @typedef {Object} EmbeddingProvider
 * @property {number} dimensions
 * @property {string} modelName
 * @property {string} modelVersion
 * @property {(text: string) => Promise<number[]>} embed
 * @property {(texts: string[]) => Promise<number[][]>} embedBatch
 * @property {(vector: number[]) => Buffer} vectorToBuffer
 * @property {(buffer: Buffer) => number[]} bufferToVector
 */

/** @implements {EmbeddingProvider} */
export class MockEmbeddingProvider {
  constructor({ dimensions = 64 } = {}) {
    this.dimensions = dimensions;
    this.modelName = 'mock-embedding';
    this.modelVersion = '1.0.0';
  }

  async embed(text) {
    const hash = createHash('sha256').update(text).digest();
    const vector = new Array(this.dimensions);
    for (let i = 0; i < this.dimensions; i++) {
      vector[i] = (hash[i % hash.length] / 255) * 2 - 1;
    }
    const magnitude = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0));
    return vector.map(v => v / magnitude);
  }

  async embedBatch(texts) {
    return Promise.all(texts.map(t => this.embed(t)));
  }

  vectorToBuffer(vector) {
    return Buffer.from(new Float32Array(vector).buffer);
  }

  bufferToVector(buffer) {
    return Array.from(new Float32Array(buffer.buffer, buffer.byteOffset, buffer.byteLength / 4));
  }
}

/** @implements {EmbeddingProvider} */
export class OpenAIEmbeddingProvider {
  constructor({ apiKey, model = 'text-embedding-3-small', dimensions = 1536, timeout = 30000 } = {}) {
    this.apiKey = apiKey || process.env.OPENAI_API_KEY;
    this.model = model;
    this.dimensions = dimensions;
    this.timeout = timeout;
    this.modelName = model;
    this.modelVersion = 'latest';
  }

  async embed(text) {
    requireApiKey(this.apiKey, 'OpenAI embedding', 'OPENAI_API_KEY');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout);
    try {
      const response = await fetch('https://api.openai.com/v1/embeddings', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ input: text, model: this.model, dimensions: this.dimensions }),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`OpenAI embedding failed: ${await describeHttpError(response)}`);
      const data = await response.json();
      return data.data[0].embedding;
    } finally {
      clearTimeout(timer);
    }
  }

  async embedBatch(texts) {
    requireApiKey(this.apiKey, 'OpenAI embedding', 'OPENAI_API_KEY');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout);
    try {
      const response = await fetch('https://api.openai.com/v1/embeddings', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ input: texts, model: this.model, dimensions: this.dimensions }),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`OpenAI embedding failed: ${await describeHttpError(response)}`);
      const data = await response.json();
      return data.data.map(d => d.embedding);
    } finally {
      clearTimeout(timer);
    }
  }

  vectorToBuffer(vector) {
    return Buffer.from(new Float32Array(vector).buffer);
  }

  bufferToVector(buffer) {
    return Array.from(new Float32Array(buffer.buffer, buffer.byteOffset, buffer.byteLength / 4));
  }
}

/** @implements {EmbeddingProvider} */
export class LocalEmbeddingProvider {
  constructor({ model = 'Xenova/all-MiniLM-L6-v2', device = 'gpu', batchSize = 64, pipelineFactory = null } = {}) {
    this.model = model;
    this.dimensions = 384;
    this.modelName = model;
    this.modelVersion = '1.0.0';
    this.device = device;
    this.batchSize = batchSize;
    this.pipelineFactory = pipelineFactory;
    this._pipeline = null;
    this._readyPromise = null;
    this._actualDevice = null;
  }

  ready() {
    if (!this._readyPromise) {
      this._readyPromise = (async () => {
        const pipeline = this.pipelineFactory || (await import('@huggingface/transformers')).pipeline;
        try {
          this._pipeline = await pipeline('feature-extraction', this.model, {
            dtype: 'fp32', device: this.device,
          });
          this._actualDevice = this.device;
        } catch {
          this._pipeline = await pipeline('feature-extraction', this.model, {
            dtype: 'fp32', device: 'cpu',
          });
          this._actualDevice = 'cpu';
        }
      })();
    }
    return this._readyPromise;
  }

  async embed(text) {
    await this.ready();
    const output = await this._pipeline(text, { pooling: 'mean', normalize: true });
    return Array.from(output.data);
  }

  async embedBatch(texts) {
    if (texts.length === 0) return [];
    await this.ready();
    const results = [];
    for (let i = 0; i < texts.length; i += this.batchSize) {
      const chunk = texts.slice(i, i + this.batchSize);
      const output = await this._pipeline(chunk, { pooling: 'mean', normalize: true });
      results.push(...output.tolist());
    }
    return results;
  }

  vectorToBuffer(vector) {
    return Buffer.from(new Float32Array(vector).buffer);
  }

  bufferToVector(buffer) {
    return Array.from(new Float32Array(buffer.buffer, buffer.byteOffset, buffer.byteLength / 4));
  }
}

/** @implements {EmbeddingProvider} */
export class GeminiEmbeddingProvider {
  constructor({ apiKey, model = 'gemini-embedding-001', timeout = 30000 } = {}) {
    this.apiKey = apiKey || process.env.GOOGLE_API_KEY;
    this.model = model;
    this.dimensions = 3072;
    this.timeout = timeout;
    this.modelName = model;
    this.modelVersion = 'latest';
  }

  async embed(text) {
    requireApiKey(this.apiKey, 'Gemini embedding', 'GOOGLE_API_KEY');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout);
    try {
      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:embedContent`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-goog-api-key': this.apiKey },
          body: JSON.stringify({ model: `models/${this.model}`, content: { parts: [{ text }] } }),
          signal: controller.signal,
        }
      );
      if (!response.ok) throw new Error(`Gemini embedding failed: ${await describeHttpError(response)}`);
      const data = await response.json();
      return data.embedding.values;
    } finally {
      clearTimeout(timer);
    }
  }

  async embedBatch(texts) {
    if (texts.length === 0) return [];
    requireApiKey(this.apiKey, 'Gemini embedding', 'GOOGLE_API_KEY');
    const results = [];
    for (let i = 0; i < texts.length; i += 100) {
      const chunk = texts.slice(i, i + 100);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeout);
      try {
        const response = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:batchEmbedContents`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-goog-api-key': this.apiKey },
            body: JSON.stringify({
              requests: chunk.map(text => ({
                model: `models/${this.model}`,
                content: { parts: [{ text }] },
              })),
            }),
            signal: controller.signal,
          }
        );
        if (!response.ok) throw new Error(`Gemini batch embedding failed: ${await describeHttpError(response)}`);
        const data = await response.json();
        results.push(...data.embeddings.map(e => e.values));
      } finally {
        clearTimeout(timer);
      }
    }
    return results;
  }

  vectorToBuffer(vector) {
    return Buffer.from(new Float32Array(vector).buffer);
  }

  bufferToVector(buffer) {
    return Array.from(new Float32Array(buffer.buffer, buffer.byteOffset, buffer.byteLength / 4));
  }
}

export function createEmbeddingProvider(config) {
  switch (config.provider) {
    case 'mock':
      return new MockEmbeddingProvider(config);
    case 'openai':
      return new OpenAIEmbeddingProvider(config);
    case 'local':
      return new LocalEmbeddingProvider(config);
    case 'gemini':
      return new GeminiEmbeddingProvider(config);
    default:
      throw new Error(`Unknown embedding provider: ${config.provider}. Valid: mock, openai, local, gemini`);
  }
}
