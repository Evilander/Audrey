import { createHash } from 'node:crypto';

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

/**
 * @typedef {Object} MockEmbeddingConfig
 * @property {'mock'} provider
 * @property {number} [dimensions=64]
 */

/**
 * @typedef {Object} OpenAIEmbeddingConfig
 * @property {'openai'} provider
 * @property {string} [apiKey]
 * @property {string} [model='text-embedding-3-small']
 * @property {number} [dimensions=1536]
 */

/** @implements {EmbeddingProvider} */
export class MockEmbeddingProvider {
  /** @param {Partial<MockEmbeddingConfig>} [config={}] */
  constructor({ dimensions = 64 } = {}) {
    this.dimensions = dimensions;
    this.modelName = 'mock-embedding';
    this.modelVersion = '1.0.0';
  }

  /**
   * @param {string} text
   * @returns {Promise<number[]>}
   */
  async embed(text) {
    const hash = createHash('sha256').update(text).digest();
    const vector = new Array(this.dimensions);
    for (let i = 0; i < this.dimensions; i++) {
      vector[i] = (hash[i % hash.length] / 255) * 2 - 1;
    }
    const magnitude = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0));
    return vector.map(v => v / magnitude);
  }

  /**
   * @param {string[]} texts
   * @returns {Promise<number[][]>}
   */
  async embedBatch(texts) {
    return Promise.all(texts.map(t => this.embed(t)));
  }

  /**
   * @param {number[]} vector
   * @returns {Buffer}
   */
  vectorToBuffer(vector) {
    return Buffer.from(new Float32Array(vector).buffer);
  }

  /**
   * @param {Buffer} buffer
   * @returns {number[]}
   */
  bufferToVector(buffer) {
    return Array.from(new Float32Array(buffer.buffer, buffer.byteOffset, buffer.byteLength / 4));
  }
}

/** @implements {EmbeddingProvider} */
export class OpenAIEmbeddingProvider {
  /** @param {Partial<OpenAIEmbeddingConfig>} [config={}] */
  constructor({ apiKey, model = 'text-embedding-3-small', dimensions = 1536 } = {}) {
    this.apiKey = apiKey || process.env.OPENAI_API_KEY;
    this.model = model;
    this.dimensions = dimensions;
    this.modelName = model;
    this.modelVersion = 'latest';
  }

  /**
   * @param {string} text
   * @returns {Promise<number[]>}
   */
  async embed(text) {
    const response = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ input: text, model: this.model, dimensions: this.dimensions }),
    });
    if (!response.ok) throw new Error(`OpenAI embedding failed: ${response.status}`);
    const data = await response.json();
    return data.data[0].embedding;
  }

  /**
   * @param {string[]} texts
   * @returns {Promise<number[][]>}
   */
  async embedBatch(texts) {
    const response = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ input: texts, model: this.model, dimensions: this.dimensions }),
    });
    if (!response.ok) throw new Error(`OpenAI embedding failed: ${response.status}`);
    const data = await response.json();
    return data.data.map(d => d.embedding);
  }

  /**
   * @param {number[]} vector
   * @returns {Buffer}
   */
  vectorToBuffer(vector) {
    return Buffer.from(new Float32Array(vector).buffer);
  }

  /**
   * @param {Buffer} buffer
   * @returns {number[]}
   */
  bufferToVector(buffer) {
    return Array.from(new Float32Array(buffer.buffer, buffer.byteOffset, buffer.byteLength / 4));
  }
}

/**
 * @param {MockEmbeddingConfig | OpenAIEmbeddingConfig} config
 * @returns {MockEmbeddingProvider | OpenAIEmbeddingProvider}
 */
export function createEmbeddingProvider(config) {
  switch (config.provider) {
    case 'mock':
      return new MockEmbeddingProvider(config);
    case 'openai':
      return new OpenAIEmbeddingProvider(config);
    default:
      throw new Error(`Unknown embedding provider: ${config.provider}. Valid: mock, openai`);
  }
}
