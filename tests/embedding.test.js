import { describe, it, expect } from 'vitest';
import { createEmbeddingProvider, MockEmbeddingProvider } from '../src/embedding.js';

describe('MockEmbeddingProvider', () => {
  it('returns a fixed-dimension vector', async () => {
    const provider = new MockEmbeddingProvider({ dimensions: 8 });
    const embedding = await provider.embed('hello world');
    expect(embedding).toHaveLength(8);
    expect(embedding.every(n => typeof n === 'number')).toBe(true);
  });

  it('returns deterministic embeddings for same input', async () => {
    const provider = new MockEmbeddingProvider({ dimensions: 8 });
    const a = await provider.embed('hello world');
    const b = await provider.embed('hello world');
    expect(a).toEqual(b);
  });

  it('returns different embeddings for different input', async () => {
    const provider = new MockEmbeddingProvider({ dimensions: 8 });
    const a = await provider.embed('hello');
    const b = await provider.embed('goodbye');
    expect(a).not.toEqual(b);
  });

  it('exposes model name and version', () => {
    const provider = new MockEmbeddingProvider({ dimensions: 8 });
    expect(provider.modelName).toBe('mock-embedding');
    expect(provider.modelVersion).toBe('1.0.0');
  });

  it('converts vector to buffer and back', async () => {
    const provider = new MockEmbeddingProvider({ dimensions: 8 });
    const vector = await provider.embed('test');
    const buffer = provider.vectorToBuffer(vector);
    expect(Buffer.isBuffer(buffer)).toBe(true);
    const recovered = provider.bufferToVector(buffer);
    expect(recovered).toHaveLength(8);
    for (let i = 0; i < vector.length; i++) {
      expect(recovered[i]).toBeCloseTo(vector[i], 5);
    }
  });

  it('produces unit-normalized vectors', async () => {
    const provider = new MockEmbeddingProvider({ dimensions: 64 });
    const v = await provider.embed('test string');
    const magnitude = Math.sqrt(v.reduce((sum, x) => sum + x * x, 0));
    expect(magnitude).toBeCloseTo(1.0, 3);
  });
});

describe('createEmbeddingProvider', () => {
  it('creates mock provider', () => {
    const provider = createEmbeddingProvider({ provider: 'mock', dimensions: 8 });
    expect(provider.modelName).toBe('mock-embedding');
  });

  it('throws for unknown provider', () => {
    expect(() => createEmbeddingProvider({ provider: 'unknown' })).toThrow();
  });
});
