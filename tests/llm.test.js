import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  MockLLMProvider,
  AnthropicLLMProvider,
  OpenAILLMProvider,
  createLLMProvider,
} from '../src/llm.js';

describe('MockLLMProvider', () => {
  it('returns canned response from responses map', async () => {
    const llm = new MockLLMProvider({
      responses: {
        principleExtraction: { content: 'Test principle', type: 'semantic' },
      },
    });
    const result = await llm.json([
      { role: 'system', content: 'You are performing principleExtraction.' },
      { role: 'user', content: 'Extract a principle from these episodes.' },
    ]);
    expect(result).toEqual({ content: 'Test principle', type: 'semantic' });
  });

  it('returns default response when no matching key', async () => {
    const llm = new MockLLMProvider({ responses: {} });
    const result = await llm.json([
      { role: 'system', content: 'Unknown task type.' },
      { role: 'user', content: 'Do something.' },
    ]);
    expect(result).toEqual({});
  });

  it('complete() returns string content', async () => {
    const llm = new MockLLMProvider({
      responses: { principleExtraction: { content: 'A principle' } },
    });
    const result = await llm.complete([
      { role: 'system', content: 'principleExtraction task.' },
      { role: 'user', content: 'Extract.' },
    ]);
    expect(result).toEqual({ content: '{"content":"A principle"}' });
  });

  it('exposes model metadata', () => {
    const llm = new MockLLMProvider({});
    expect(llm.modelName).toBe('mock-llm');
    expect(llm.modelVersion).toBe('1.0.0');
  });
});

describe('AnthropicLLMProvider', () => {
  it('calls the Anthropic Messages API', async () => {
    const mockResponse = {
      content: [{ type: 'text', text: '{"result": true}' }],
    };
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockResponse),
    });

    const llm = new AnthropicLLMProvider({
      apiKey: 'test-key',
      model: 'claude-sonnet-4-6',
    });
    const result = await llm.json([
      { role: 'system', content: 'Test system.' },
      { role: 'user', content: 'Test user.' },
    ]);

    expect(result).toEqual({ result: true });
    expect(global.fetch).toHaveBeenCalledWith(
      'https://api.anthropic.com/v1/messages',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'x-api-key': 'test-key',
          'anthropic-version': '2023-06-01',
        }),
      }),
    );
  });

  it('throws on API error', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      text: () => Promise.resolve('Unauthorized'),
    });

    const llm = new AnthropicLLMProvider({ apiKey: 'bad-key' });
    await expect(
      llm.complete([{ role: 'user', content: 'test' }]),
    ).rejects.toThrow('Anthropic API error: 401');
  });
});

describe('OpenAILLMProvider', () => {
  it('calls the OpenAI Chat Completions API', async () => {
    const mockResponse = {
      choices: [{ message: { content: '{"result": true}' } }],
    };
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockResponse),
    });

    const llm = new OpenAILLMProvider({
      apiKey: 'test-key',
      model: 'gpt-4o',
    });
    const result = await llm.json([
      { role: 'system', content: 'Test.' },
      { role: 'user', content: 'Test.' },
    ]);

    expect(result).toEqual({ result: true });
    expect(global.fetch).toHaveBeenCalledWith(
      'https://api.openai.com/v1/chat/completions',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('throws on API error', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
      text: () => Promise.resolve('Rate limited'),
    });

    const llm = new OpenAILLMProvider({ apiKey: 'key' });
    await expect(
      llm.complete([{ role: 'user', content: 'test' }]),
    ).rejects.toThrow('OpenAI API error: 429');
  });
});

describe('createLLMProvider', () => {
  it('creates MockLLMProvider', () => {
    const llm = createLLMProvider({ provider: 'mock' });
    expect(llm).toBeInstanceOf(MockLLMProvider);
  });

  it('creates AnthropicLLMProvider', () => {
    const llm = createLLMProvider({ provider: 'anthropic', apiKey: 'k' });
    expect(llm).toBeInstanceOf(AnthropicLLMProvider);
  });

  it('creates OpenAILLMProvider', () => {
    const llm = createLLMProvider({ provider: 'openai', apiKey: 'k' });
    expect(llm).toBeInstanceOf(OpenAILLMProvider);
  });

  it('throws on unknown provider', () => {
    expect(() => createLLMProvider({ provider: 'gemini' })).toThrow('Unknown LLM provider');
  });
});
