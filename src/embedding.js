import { createHash } from 'node:crypto';

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

  vectorToBuffer(vector) {
    return Buffer.from(new Float32Array(vector).buffer);
  }

  bufferToVector(buffer) {
    return Array.from(new Float32Array(buffer.buffer, buffer.byteOffset, buffer.byteLength / 4));
  }
}

export class OpenAIEmbeddingProvider {
  constructor({ apiKey, model = 'text-embedding-3-small', dimensions = 1536 } = {}) {
    this.apiKey = apiKey || process.env.OPENAI_API_KEY;
    this.model = model;
    this.dimensions = dimensions;
    this.modelName = model;
    this.modelVersion = 'latest';
  }

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
    default:
      throw new Error(`Unknown embedding provider: ${config.provider}. Valid: mock, openai`);
  }
}
