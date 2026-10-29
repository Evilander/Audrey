import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChatGPTLLMProvider, readChatGPTCompletion } from '../dist/src/chatgpt-llm.js';
import {
  resolveLLMProvider,
  buildAudreyMcpEnv,
  buildAutopilotRuntimeArgs,
} from '../dist/mcp-server/config.js';

afterEach(() => vi.restoreAllMocks());

function stream(events, split = false) {
  const data = events.map(event => `data: ${JSON.stringify(event)}\r\n\r\n`).join('');
  const bytes = new TextEncoder().encode(data);
  return new Response(
    new ReadableStream({
      start(controller) {
        if (split) for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
        else controller.enqueue(bytes);
        controller.close();
      },
    }),
    { headers: { 'Content-Type': 'text/event-stream' } },
  );
}

describe('ChatGPT subscription provider', () => {
  it('requires explicit selection and forwards only subscription-safe parameters', async () => {
    expect(resolveLLMProvider({ OPENAI_API_KEY: 'ambient' })).toBeNull();
    expect(resolveLLMProvider({ AUDREY_LLM_PROVIDER: 'chatgpt' })).toMatchObject({
      provider: 'chatgpt',
      model: 'gpt-6.1-sol',
      reasoningEffort: 'medium',
    });
    const provider = new ChatGPTLLMProvider();
    vi.spyOn(provider.auth, 'accessToken').mockResolvedValue('oauth-secret');
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(Response.json({ models: [{ slug: 'gpt-6.1-sol' }] }))
      .mockResolvedValueOnce(
        stream(
          [
            { type: 'response.output_text.delta', delta: '{"ok":true}' },
            { type: 'response.completed', response: { status: 'completed' } },
          ],
          true,
        ),
      );
    expect(
      await provider.json(
        [
          { role: 'system', content: 'Organize history.' },
          { role: 'user', content: 'History.' },
        ],
        { maxTokens: 10 },
      ),
    ).toEqual({ ok: true });
    const [url, options] = fetchMock.mock.calls[1];
    expect(url).toBe('https://api.openai.com/v1/responses');
    expect(JSON.parse(options.body)).toEqual({
      model: 'gpt-6.1-sol',
      reasoning: { effort: 'medium' },
      input: [
        { role: 'developer', content: 'Organize history.' },
        { role: 'user', content: 'History.' },
      ],
      stream: true,
      store: false,
    });
  });

  it('persists provider settings in MCP and hook configuration without credentials', () => {
    const env = {
      AUDREY_LLM_PROVIDER: 'chatgpt',
      AUDREY_LLM_MODEL: 'gpt-6.1-sol',
      AUDREY_LLM_REASONING_EFFORT: 'medium',
      AUDREY_CHATGPT_ACCOUNT: 'account',
      AUDREY_CHATGPT_AUTH_DIR: 'C:/Users/local/auth',
      OPENAI_API_KEY: 'secret',
    };
    const config = buildAudreyMcpEnv(env);
    expect(config).toMatchObject({
      AUDREY_LLM_PROVIDER: 'chatgpt',
      AUDREY_CHATGPT_ACCOUNT: 'account',
    });
    expect(JSON.stringify(config)).not.toContain('secret');
    expect(buildAutopilotRuntimeArgs(env)).toEqual(
      expect.arrayContaining([
        '--llm-provider',
        'chatgpt',
        '--llm-model',
        'gpt-6.1-sol',
        '--llm-reasoning-effort',
        'medium',
        '--chatgpt-auth-dir',
        'C:/Users/local/auth',
        '--chatgpt-account',
        'account',
      ]),
    );
  });

  it('does not use API billing or substitute a model absent from the account catalog', async () => {
    const provider = new ChatGPTLLMProvider();
    vi.spyOn(provider.auth, 'accessToken').mockResolvedValue('oauth-secret');
    const mock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(Response.json({ models: [{ slug: 'another' }] }));
    await expect(provider.complete([{ role: 'user', content: 'test' }])).rejects.toThrow(
      'unavailable',
    );
    expect(mock).toHaveBeenCalledTimes(1);
  });

  it('refuses partial output when a usage error arrives after streaming begins', async () => {
    await expect(
      readChatGPTCompletion(
        stream([
          { type: 'response.output_text.delta', delta: 'partial' },
          {
            type: 'response.failed',
            response: { error: { code: 'subscription_sharing_usage_limit_exceeded' } },
          },
        ]),
      ),
    ).rejects.toThrow('subscription_sharing_usage_limit_exceeded');
  });

  it.each([
    [],
    [{ type: 'response.output_text.delta', delta: 'partial' }],
    [{ type: 'response.incomplete' }],
  ])('refuses non-completed streams %#', async (...events) => {
    await expect(readChatGPTCompletion(stream(events.flat()))).rejects.toThrow();
  });

  it('does not repeat untrusted error text or tokens in diagnostics', async () => {
    await expect(
      readChatGPTCompletion(
        Response.json(
          { error: { code: 'secret token=abc', message: 'Bearer abc' } },
          { status: 401 },
        ),
      ),
    ).rejects.toThrow('request_failed');
  });

  it('rejects a completed event with an incomplete response status', async () => {
    await expect(
      readChatGPTCompletion(
        stream([
          { type: 'response.output_text.delta', delta: 'partial' },
          { type: 'response.completed', response: { status: 'incomplete' } },
        ]),
      ),
    ).rejects.toThrow('invalid completion status');
  });

  it('includes token renewal in the provider deadline', async () => {
    const provider = new ChatGPTLLMProvider({ timeout: 30 });
    vi.spyOn(provider.auth, 'accessToken').mockImplementation(
      (_account, signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('Cancelled token renewal')), {
            once: true,
          });
        }),
    );
    const mock = vi.spyOn(globalThis, 'fetch');
    await expect(provider.complete([{ role: 'user', content: 'test' }])).rejects.toThrow(
      'Cancelled token renewal',
    );
    expect(mock).not.toHaveBeenCalled();
  });
});
