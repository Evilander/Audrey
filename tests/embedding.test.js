import { describe, it, expect, vi } from 'vitest';
import { createEmbeddingProvider, MockEmbeddingProvider, OpenAIEmbeddingProvider } from '../src/embedding.js';

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

  describe('embedBatch', () => {
    it('embeds multiple texts and returns array of vectors', async () => {
      const provider = new MockEmbeddingProvider({ dimensions: 8 });
      const results = await provider.embedBatch(['hello', 'world', 'foo']);
      expect(results).toHaveLength(3);
      for (const vec of results) {
        expect(vec).toHaveLength(8);
        expect(vec.every(n => typeof n === 'number')).toBe(true);
      }
    });

    it('returns same results as individual embed() calls', async () => {
      const provider = new MockEmbeddingProvider({ dimensions: 8 });
      const texts = ['alpha', 'beta', 'gamma'];
      const batch = await provider.embedBatch(texts);
      const individual = await Promise.all(texts.map(t => provider.embed(t)));
      expect(batch).toEqual(individual);
    });
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

describe('OpenAIEmbeddingProvider.embedBatch', () => {
  it('sends batch request and returns array of embeddings', async () => {
    const mockEmbeddings = [
      [0.1, 0.2, 0.3],
      [0.4, 0.5, 0.6],
    ];
    const originalFetch = global.fetch;
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: mockEmbeddings.map((embedding, i) => ({ embedding, index: i })),
      }),
    });

    const provider = new OpenAIEmbeddingProvider({ apiKey: 'test-key', dimensions: 3 });
    const results = await provider.embedBatch(['hello', 'world']);

    expect(results).toEqual(mockEmbeddings);
    expect(global.fetch).toHaveBeenCalledOnce();

    const callArgs = global.fetch.mock.calls[0];
    expect(callArgs[0]).toBe('https://api.openai.com/v1/embeddings');
    const body = JSON.parse(callArgs[1].body);
    expect(body.input).toEqual(['hello', 'world']);
    expect(body.model).toBe('text-embedding-3-small');

    global.fetch = originalFetch;
  });

  it('throws on non-ok response', async () => {
    const originalFetch = global.fetch;
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 429 });

    const provider = new OpenAIEmbeddingProvider({ apiKey: 'test-key' });
    await expect(provider.embedBatch(['hello'])).rejects.toThrow('OpenAI embedding failed: 429');

    global.fetch = originalFetch;
  });
});
