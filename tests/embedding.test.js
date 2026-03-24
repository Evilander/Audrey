import { describe, it, expect, vi, beforeAll } from 'vitest';
import { createEmbeddingProvider, MockEmbeddingProvider, OpenAIEmbeddingProvider, LocalEmbeddingProvider, GeminiEmbeddingProvider } from '../src/embedding.js';

const RUN_LOCAL_EMBEDDING_INTEGRATION = process.env.AUDREY_RUN_LOCAL_EMBEDDING_TESTS === '1';
const describeLocalEmbeddingIntegration = RUN_LOCAL_EMBEDDING_INTEGRATION ? describe : describe.skip;

function createFakeLocalPipelineFactory({ failDevices = [] } = {}) {
  const failed = new Set(failDevices);
  return vi.fn(async (_task, _model, { device }) => {
    if (failed.has(device)) {
      throw new Error(`device ${device} unavailable`);
    }

    return async input => {
      if (Array.isArray(input)) {
        return {
          tolist: () => input.map(() => Array(384).fill(device === 'cpu' ? 0.5 : 0.25)),
        };
      }

      return {
        data: Float32Array.from(Array(384).fill(device === 'cpu' ? 0.5 : 0.25)),
      };
    };
  });
}

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

  it('passes device to LocalEmbeddingProvider', () => {
    const provider = createEmbeddingProvider({ provider: 'local', device: 'cpu' });
    expect(provider.device).toBe('cpu');
  });
});

describe('OpenAIEmbeddingProvider timeout', () => {
  it('throws clearly when no API key is configured', async () => {
    const emb = new OpenAIEmbeddingProvider();
    emb.apiKey = '';
    await expect(emb.embed('test')).rejects.toThrow('OpenAI embedding requires OPENAI_API_KEY');
  });

  it('aborts fetch after timeout', async () => {
    global.fetch = vi.fn().mockImplementation((_url, opts) =>
      new Promise((resolve, reject) => {
        const onAbort = () => reject(new DOMException('The operation was aborted', 'AbortError'));
        if (opts?.signal?.aborted) return onAbort();
        opts?.signal?.addEventListener('abort', onAbort);
      }),
    );

    const emb = new OpenAIEmbeddingProvider({ apiKey: 'test-key', timeout: 50 });
    await expect(emb.embed('test')).rejects.toThrow();
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

describeLocalEmbeddingIntegration('LocalEmbeddingProvider', () => {
  let provider;

  beforeAll(async () => {
    provider = new LocalEmbeddingProvider();
    await provider.ready();
  }, 120_000);

  it('produces 384-dimensional vectors', async () => {
    const vec = await provider.embed('hello world');
    expect(vec).toHaveLength(384);
  });

  it('produces semantically similar vectors for similar text', async () => {
    const v1 = await provider.embed('the cat sat on the mat');
    const v2 = await provider.embed('a cat was sitting on a rug');
    const v3 = await provider.embed('the stock market crashed today');
    const dot = (a, b) => a.reduce((s, x, i) => s + x * b[i], 0);
    expect(dot(v1, v2)).toBeGreaterThan(dot(v1, v3));
  });

  it('vectorToBuffer / bufferToVector roundtrips', async () => {
    const vec = await provider.embed('test');
    const buf = provider.vectorToBuffer(vec);
    const back = provider.bufferToVector(buf);
    expect(back).toHaveLength(384);
    expect(Math.abs(back[0] - vec[0])).toBeLessThan(0.0001);
  });

  describe('embedBatch', () => {
    it('returns correct number of vectors', async () => {
      const results = await provider.embedBatch(['hello', 'world', 'test']);
      expect(results).toHaveLength(3);
      for (const vec of results) {
        expect(vec).toHaveLength(384);
      }
    });

    it('returns same results as individual embed calls', async () => {
      const texts = ['the cat sat', 'on the mat'];
      const batch = await provider.embedBatch(texts);
      const individual = [await provider.embed(texts[0]), await provider.embed(texts[1])];
      for (let i = 0; i < texts.length; i++) {
        for (let j = 0; j < 384; j++) {
          expect(batch[i][j]).toBeCloseTo(individual[i][j], 4);
        }
      }
    });

    it('handles empty array', async () => {
      const results = await provider.embedBatch([]);
      expect(results).toEqual([]);
    });
  });
});

describe('LocalEmbeddingProvider device config', () => {
  it('accepts device option in constructor', () => {
    const provider = new LocalEmbeddingProvider({ device: 'cpu' });
    expect(provider.device).toBe('cpu');
  });

  it('defaults device to gpu', () => {
    const provider = new LocalEmbeddingProvider();
    expect(provider.device).toBe('gpu');
  });

  it('exposes _actualDevice after ready()', async () => {
    const pipelineFactory = createFakeLocalPipelineFactory();
    const provider = new LocalEmbeddingProvider({ device: 'cpu', pipelineFactory });
    await provider.ready();
    expect(provider._actualDevice).toBe('cpu');
    expect(pipelineFactory).toHaveBeenCalledTimes(1);
  });

  it('falls back to cpu when requested device fails', async () => {
    const pipelineFactory = createFakeLocalPipelineFactory({ failDevices: ['cuda'] });
    const provider = new LocalEmbeddingProvider({ device: 'cuda', pipelineFactory });
    await provider.ready();
    expect(provider._actualDevice).toBe('cpu');
    const vec = await provider.embed('test');
    expect(vec).toHaveLength(384);
    expect(pipelineFactory).toHaveBeenCalledTimes(2);
  });

  it('reuses the same ready promise', async () => {
    const pipelineFactory = createFakeLocalPipelineFactory();
    const provider = new LocalEmbeddingProvider({ device: 'cpu', pipelineFactory });
    const first = provider.ready();
    const second = provider.ready();
    await Promise.all([first, second]);
    expect(first).toBe(second);
    expect(pipelineFactory).toHaveBeenCalledTimes(1);
  });

  it('accepts batchSize option', () => {
    const provider = new LocalEmbeddingProvider({ batchSize: 32 });
    expect(provider.batchSize).toBe(32);
  });

  it('defaults batchSize to 64', () => {
    const provider = new LocalEmbeddingProvider();
    expect(provider.batchSize).toBe(64);
  });
});

describe('GeminiEmbeddingProvider', () => {
  it('produces 768-dimensional vectors', async () => {
    if (!process.env.GOOGLE_API_KEY) {
      console.log('Skipping — no GOOGLE_API_KEY');
      return;
    }
    const provider = new GeminiEmbeddingProvider({ apiKey: process.env.GOOGLE_API_KEY });
    const vec = await provider.embed('hello world');
    expect(vec).toHaveLength(768);
  });

  it('throws clearly when no API key', async () => {
    const provider = new GeminiEmbeddingProvider({ apiKey: '' });
    await expect(provider.embed('test')).rejects.toThrow('Gemini');
  });

  describe('embedBatch', () => {
    it('calls batchEmbedContents endpoint', async () => {
      const mockValues = [[0.1, 0.2], [0.3, 0.4]];
      const originalFetch = global.fetch;
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          embeddings: mockValues.map(values => ({ values })),
        }),
      });

      const provider = new GeminiEmbeddingProvider({ apiKey: 'test-key' });
      const results = await provider.embedBatch(['hello', 'world']);

      expect(results).toEqual(mockValues);
      expect(global.fetch).toHaveBeenCalledOnce();
      const callArgs = global.fetch.mock.calls[0];
      expect(callArgs[0]).toContain('batchEmbedContents');
      const body = JSON.parse(callArgs[1].body);
      expect(body.requests).toHaveLength(2);

      global.fetch = originalFetch;
    });

    it('chunks at 100 texts per request', async () => {
      const originalFetch = global.fetch;
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          embeddings: Array(100).fill({ values: [0.1] }),
        }),
      });

      const provider = new GeminiEmbeddingProvider({ apiKey: 'test-key' });
      const texts = Array(150).fill('text');
      await provider.embedBatch(texts);

      expect(global.fetch).toHaveBeenCalledTimes(2);
      const body1 = JSON.parse(global.fetch.mock.calls[0][1].body);
      const body2 = JSON.parse(global.fetch.mock.calls[1][1].body);
      expect(body1.requests).toHaveLength(100);
      expect(body2.requests).toHaveLength(50);

      global.fetch = originalFetch;
    });

    it('throws on non-ok response', async () => {
      const originalFetch = global.fetch;
      global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 429 });

      const provider = new GeminiEmbeddingProvider({ apiKey: 'test-key' });
      await expect(provider.embedBatch(['hello'])).rejects.toThrow('Gemini');

      global.fetch = originalFetch;
    });

    it('handles empty array', async () => {
      const provider = new GeminiEmbeddingProvider({ apiKey: 'test-key' });
      const results = await provider.embedBatch([]);
      expect(results).toEqual([]);
    });
  });
});
