import { ChatGPTAuth } from './chatgpt-auth.js';
import { extractJSON, warnCloudEgressOnce } from './llm-shared.js';
import type {
  ChatMessage,
  LLMCompletionOptions,
  LLMCompletionResult,
  LLMConfig,
  LLMProvider,
} from './types.js';

const API = 'https://api.openai.com/v1';
const MAX_STREAM_BYTES = 16 * 1024 * 1024;

function inferenceError(code: unknown): Error {
  const safeCode =
    typeof code === 'string' && /^[a-zA-Z0-9_]+$/.test(code) ? code : 'request_failed';
  const guidance =
    safeCode === 'subscription_sharing_usage_limit_exceeded'
      ? 'Review ChatGPT plan usage at https://chatgpt.com/settings/usage.'
      : safeCode === 'subscription_sharing_user_not_eligible'
        ? 'ChatGPT plan usage is unavailable for this account or workspace.'
        : 'Check ChatGPT sign-in and account permissions.';
  return new Error(`ChatGPT subscription request failed (${safeCode}). ${guidance}`);
}

/** Consume through response.completed; partial output is never a successful completion. */
export async function readChatGPTCompletion(response: Response): Promise<string> {
  if (!response.ok) {
    const data = (await response.json().catch(() => ({}))) as { error?: { code?: string } };
    throw inferenceError(data.error?.code || `http_${response.status}`);
  }
  if (!response.body) throw new Error('ChatGPT subscription response has no event stream.');
  const reader = (response.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let pending = '';
  let text = '';
  let bytes = 0;
  let completed = false;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_STREAM_BYTES)
        throw new Error('ChatGPT subscription response exceeded the stream size limit.');
      pending += decoder.decode(value, { stream: true });
      // Normalize only once a complete line arrives, preserving split CRLF chunks.
      pending = pending.replace(/\r\n/g, '\n');
      let end: number;
      while ((end = pending.indexOf('\n\n')) >= 0) {
        const frame = pending.slice(0, end);
        pending = pending.slice(end + 2);
        const payload = frame
          .split('\n')
          .filter(line => line.startsWith('data:'))
          .map(line => line.slice(5).trimStart())
          .join('\n');
        if (!payload || payload === '[DONE]') continue;
        let event: {
          type?: string;
          delta?: string;
          error?: { code?: string };
          code?: string;
          response?: {
            error?: { code?: string };
            output?: Array<{ content?: Array<{ type?: string; text?: string }> }>;
          };
        };
        try {
          event = JSON.parse(payload) as typeof event;
        } catch {
          throw new Error('ChatGPT subscription returned a malformed event.');
        }
        if (event.type === 'response.output_text.delta') text += event.delta || '';
        if (event.type === 'error' || event.type === 'response.failed') {
          throw inferenceError(event.response?.error?.code || event.error?.code || event.code);
        }
        if (event.type === 'response.incomplete')
          throw new Error('ChatGPT subscription response was incomplete.');
        if (event.type === 'response.completed') {
          if ((event.response as { status?: string } | undefined)?.status !== 'completed') {
            throw new Error('ChatGPT subscription returned an invalid completion status.');
          }
          completed = true;
          if (!text)
            text =
              event.response?.output
                ?.flatMap(item => item.content || [])
                .filter(item => item.type === 'output_text')
                .map(item => item.text || '')
                .join('') || '';
          return text;
        }
      }
    }
    if (!completed)
      throw new Error('ChatGPT subscription stream ended without response.completed.');
    return text;
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

export class ChatGPTLLMProvider implements LLMProvider {
  readonly model: string;
  readonly modelName: string;
  readonly modelVersion = 'latest';
  readonly reasoningEffort: NonNullable<LLMConfig['reasoningEffort']>;
  readonly timeout: number;
  readonly auth: ChatGPTAuth;
  readonly account: string | undefined;
  private checkedToken: string | undefined;

  constructor(config: Partial<LLMConfig> = {}) {
    this.model = config.model || 'gpt-6.1-sol';
    this.modelName = this.model;
    this.reasoningEffort = config.reasoningEffort || 'medium';
    this.timeout = config.timeout ?? 120000;
    this.auth = new ChatGPTAuth({ directory: config.authDir });
    this.account = config.chatgptAccount;
  }

  async complete(
    messages: ChatMessage[],
    _options: LLMCompletionOptions = {},
  ): Promise<LLMCompletionResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout);
    try {
      const token = await this.auth.accessToken(this.account, controller.signal);
      if (this.checkedToken !== token) {
        const catalog = await fetch(`${API}/models`, {
          headers: { Authorization: `Bearer ${token}` },
          signal: controller.signal,
        });
        if (!catalog.ok) throw inferenceError(`http_${catalog.status}`);
        const data = (await catalog.json()) as { models?: Array<{ slug: string }> };
        if (!data.models?.some(model => model.slug === this.model)) {
          throw new Error(
            `Model ${this.model} is unavailable to the selected ChatGPT account. No substitute model was selected.`,
          );
        }
        this.checkedToken = token;
      }
      warnCloudEgressOnce(
        'chatgpt',
        'api.openai.com',
        '[audrey] Sending memory content to OpenAI (api.openai.com) using your ChatGPT plan.\n',
      );
      const body = {
        model: this.model,
        reasoning: { effort: this.reasoningEffort },
        input: messages.map(message => ({
          role: message.role === 'system' ? 'developer' : message.role,
          content: message.content,
        })),
        store: false,
        stream: true,
      };
      const response = await fetch(`${API}/responses`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      return { content: await readChatGPTCompletion(response) };
    } finally {
      clearTimeout(timer);
    }
  }

  async json(messages: ChatMessage[], options: LLMCompletionOptions = {}): Promise<unknown> {
    const { content } = await this.complete(messages, options);
    try {
      return JSON.parse(extractJSON(content));
    } catch {
      throw new Error('Failed to parse ChatGPT subscription response as JSON.');
    }
  }
}
