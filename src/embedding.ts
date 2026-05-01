import { createHash } from 'node:crypto';
import type { EmbeddingConfig, EmbeddingProvider } from './types.js';
import { describeHttpError, requireApiKey } from './utils.js';

export class MockEmbeddingProvider implements EmbeddingProvider {
  dimensions: number;
  modelName: string;
  modelVersion: string;

  constructor({ dimensions = 64 }: Partial<EmbeddingConfig> = {}) {
    this.dimensions = dimensions ?? 64;
    this.modelName = 'mock-embedding';
    this.modelVersion = '1.0.0';
  }

  async embed(text: string): Promise<number[]> {
    const hash = createHash('sha256').update(text).digest();
    const vector = new Array<number>(this.dimensions);
    for (let i = 0; i < this.dimensions; i++) {
      vector[i] = (hash[i % hash.length]! / 255) * 2 - 1;
    }
    const magnitude = Math.sqrt(vector.reduce((sum, v) => sum + v! * v!, 0));
    return vector.map(v => v! / magnitude);
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    return Promise.all(texts.map(t => this.embed(t)));
  }

  vectorToBuffer(vector: number[]): Buffer {
    return Buffer.from(new Float32Array(vector).buffer);
  }

  bufferToVector(buffer: Buffer): number[] {
    return Array.from(new Float32Array(buffer.buffer, buffer.byteOffset, buffer.byteLength / 4));
  }
}

export class OpenAIEmbeddingProvider implements EmbeddingProvider {
  apiKey: string | undefined;
  model: string;
  dimensions: number;
  timeout: number;
  modelName: string;
  modelVersion: string;

  constructor({ apiKey, model = 'text-embedding-3-small', dimensions = 1536, timeout = 30000 }: Partial<EmbeddingConfig> = {}) {
    this.apiKey = apiKey || process.env.OPENAI_API_KEY;
    this.model = model ?? 'text-embedding-3-small';
    this.dimensions = dimensions ?? 1536;
    this.timeout = timeout ?? 30000;
    this.modelName = this.model;
    this.modelVersion = 'latest';
  }

  async embed(text: string): Promise<number[]> {
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
      const data = await response.json() as { data?: { embedding: number[] }[] };
      const first = data.data?.[0]?.embedding;
      if (!first) throw new Error('OpenAI embedding response contained no embeddings');
      return first;
    } finally {
      clearTimeout(timer);
    }
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
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
      const data = await response.json() as { data?: { embedding?: number[] }[] };
      if (!Array.isArray(data.data) || data.data.length === 0) {
        throw new Error('OpenAI embedBatch response contained no embeddings');
      }
      const out: number[][] = [];
      for (let i = 0; i < data.data.length; i++) {
        const emb = data.data[i]?.embedding;
        if (!Array.isArray(emb)) {
          throw new Error(`OpenAI embedBatch response missing embedding at index ${i}`);
        }
        out.push(emb);
      }
      return out;
    } finally {
      clearTimeout(timer);
    }
  }

  vectorToBuffer(vector: number[]): Buffer {
    return Buffer.from(new Float32Array(vector).buffer);
  }

  bufferToVector(buffer: Buffer): number[] {
    return Array.from(new Float32Array(buffer.buffer, buffer.byteOffset, buffer.byteLength / 4));
  }
}

export class LocalEmbeddingProvider implements EmbeddingProvider {
  model: string;
  dimensions: number;
  modelName: string;
  modelVersion: string;
  device: string;
  batchSize: number;
  pipelineFactory: ((task: string, model: string, options?: Record<string, unknown>) => Promise<unknown>) | null;
  _pipeline: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  _readyPromise: Promise<void> | null;
  _actualDevice: string | null;

  constructor({ model = 'Xenova/all-MiniLM-L6-v2', device = 'gpu', batchSize = 64, pipelineFactory = null }: Partial<EmbeddingConfig> = {}) {
    this.model = model ?? 'Xenova/all-MiniLM-L6-v2';
    this.dimensions = 384;
    this.modelName = this.model;
    this.modelVersion = '1.0.0';
    this.device = device ?? 'gpu';
    this.batchSize = batchSize ?? 64;
    this.pipelineFactory = pipelineFactory ?? null;
    this._pipeline = null;
    this._readyPromise = null;
    this._actualDevice = null;
  }

  ready(): Promise<void> {
    if (!this._readyPromise) {
      this._readyPromise = (async () => {
        let pipeline: NonNullable<typeof this.pipelineFactory>;
        if (this.pipelineFactory) {
          pipeline = this.pipelineFactory;
        } else {
          const tx = await import('@huggingface/transformers');
          pipeline = tx.pipeline as unknown as NonNullable<typeof this.pipelineFactory>;
        }
        // Suppress per-session ONNX EP-assignment warnings. Per-session is the
        // safe scope: it doesn't mutate the transformers global env (which would
        // affect other consumers in the same process). AUDREY_ONNX_VERBOSE=1 opts out.
        const verbose = process.env.AUDREY_ONNX_VERBOSE === '1';
        const sessionOptions = verbose ? undefined : { logSeverityLevel: 3 };
        try {
          this._pipeline = await pipeline('feature-extraction', this.model, {
            dtype: 'fp32', device: this.device as 'gpu' | 'cpu',
            ...(sessionOptions ? { session_options: sessionOptions } : {}),
          } as Parameters<typeof pipeline>[2]);
          this._actualDevice = this.device;
        } catch {
          this._pipeline = await pipeline('feature-extraction', this.model, {
            dtype: 'fp32', device: 'cpu',
            ...(sessionOptions ? { session_options: sessionOptions } : {}),
          } as Parameters<typeof pipeline>[2]);
          this._actualDevice = 'cpu';
        }
      })();
    }
    return this._readyPromise;
  }

  async embed(text: string): Promise<number[]> {
    await this.ready();
    const output = await this._pipeline(text, { pooling: 'mean', normalize: true });
    return Array.from(output.data as Float32Array);
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    await this.ready();
    const results: number[][] = [];
    for (let i = 0; i < texts.length; i += this.batchSize) {
      const chunk = texts.slice(i, i + this.batchSize);
      const output = await this._pipeline(chunk, { pooling: 'mean', normalize: true });
      results.push(...(output.tolist() as number[][]));
    }
    return results;
  }

  vectorToBuffer(vector: number[]): Buffer {
    return Buffer.from(new Float32Array(vector).buffer);
  }

  bufferToVector(buffer: Buffer): number[] {
    return Array.from(new Float32Array(buffer.buffer, buffer.byteOffset, buffer.byteLength / 4));
  }
}

export class GeminiEmbeddingProvider implements EmbeddingProvider {
  apiKey: string | undefined;
  model: string;
  dimensions: number;
  timeout: number;
  modelName: string;
  modelVersion: string;

  constructor({ apiKey, model = 'gemini-embedding-001', timeout = 30000 }: Partial<EmbeddingConfig> = {}) {
    this.apiKey = apiKey || process.env.GOOGLE_API_KEY;
    this.model = model ?? 'gemini-embedding-001';
    this.dimensions = 3072;
    this.timeout = timeout ?? 30000;
    this.modelName = this.model;
    this.modelVersion = 'latest';
  }

  async embed(text: string): Promise<number[]> {
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
      const data = await response.json() as { embedding: { values: number[] } };
      return data.embedding.values;
    } finally {
      clearTimeout(timer);
    }
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    requireApiKey(this.apiKey, 'Gemini embedding', 'GOOGLE_API_KEY');
    const results: number[][] = [];
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
        const data = await response.json() as { embeddings: { values: number[] }[] };
        results.push(...data.embeddings.map(e => e.values));
      } finally {
        clearTimeout(timer);
      }
    }
    return results;
  }

  vectorToBuffer(vector: number[]): Buffer {
    return Buffer.from(new Float32Array(vector).buffer);
  }

  bufferToVector(buffer: Buffer): number[] {
    return Array.from(new Float32Array(buffer.buffer, buffer.byteOffset, buffer.byteLength / 4));
  }
}

export function createEmbeddingProvider(config: EmbeddingConfig): EmbeddingProvider {
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
      throw new Error(`Unknown embedding provider: ${(config as EmbeddingConfig).provider}. Valid: mock, openai, local, gemini`);
  }
}
