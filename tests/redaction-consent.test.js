import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { resolveLLMProvider } from '../mcp-server/config.js';
import { AnthropicLLMProvider, OpenAILLMProvider } from '../dist/src/llm.js';

describe('resolveLLMProvider', () => {
  it('never infers a cloud provider from an ambient API key when unset', () => {
    // Pre-fix, this returned { provider: 'anthropic', apiKey: 'sk-ant-test' }
    // purely because ANTHROPIC_API_KEY happened to be present.
    const result = resolveLLMProvider({ ANTHROPIC_API_KEY: 'sk-ant-test' });
    expect(result).toBeNull();
  });

  it('never infers a cloud provider from an ambient API key when explicitly set to auto', () => {
    const result = resolveLLMProvider({ OPENAI_API_KEY: 'sk-openai-test' }, 'auto');
    expect(result).toBeNull();
  });

  it('honors an explicit anthropic opt-in with its matching key present', () => {
    const result = resolveLLMProvider({ ANTHROPIC_API_KEY: 'sk-ant-test' }, 'anthropic');
    expect(result.provider).toBe('anthropic');
    expect(result.apiKey).toBe('sk-ant-test');
  });

  it('honors an explicit openai opt-in with its matching key present', () => {
    const result = resolveLLMProvider({ OPENAI_API_KEY: 'sk-openai-test' }, 'openai');
    expect(result.provider).toBe('openai');
    expect(result.apiKey).toBe('sk-openai-test');
  });

  it('fails clearly instead of silently downgrading when the named provider has no key', () => {
    expect(() => resolveLLMProvider({}, 'anthropic')).toThrow(/ANTHROPIC_API_KEY/);
    expect(() => resolveLLMProvider({}, 'openai')).toThrow(/OPENAI_API_KEY/);
  });

  it('does not require a key when the caller is only building a portable config', () => {
    const result = resolveLLMProvider({}, 'anthropic', { requireApiKey: false });
    expect(result.provider).toBe('anthropic');
    expect(result.apiKey).toBeUndefined();
  });

  it('never requires a key for the mock provider', () => {
    const result = resolveLLMProvider({}, 'mock');
    expect(result).toEqual({ provider: 'mock' });
  });
});

describe('cloud LLM egress notice', () => {
  let stderrSpy;

  beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
    delete global.fetch;
  });

  it('warns once on stderr before the first Anthropic completion, naming the provider and host', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ content: [{ type: 'text', text: '{}' }] }),
    });
    const llm = new AnthropicLLMProvider({ apiKey: 'test-key' });
    await llm.complete([{ role: 'user', content: 'hi' }]);
    await llm.complete([{ role: 'user', content: 'hi again' }]);

    const notices = stderrSpy.mock.calls
      .map(call => call[0])
      .filter(text => typeof text === 'string' && text.includes('anthropic'));
    expect(notices.length).toBe(1);
    expect(notices[0]).toContain('api.anthropic.com');
    expect(notices[0]).toMatch(/memory/i);
  });

  it('warns once on stderr before the first OpenAI completion, naming the provider and host', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ choices: [{ message: { content: '{}' } }] }),
    });
    const llm = new OpenAILLMProvider({ apiKey: 'test-key' });
    await llm.complete([{ role: 'user', content: 'hi' }]);
    await llm.complete([{ role: 'user', content: 'hi again' }]);

    const notices = stderrSpy.mock.calls
      .map(call => call[0])
      .filter(text => typeof text === 'string' && text.includes('openai'));
    expect(notices.length).toBe(1);
    expect(notices[0]).toContain('api.openai.com');
    expect(notices[0]).toMatch(/memory/i);
  });
});
