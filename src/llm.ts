import type {
  ChatMessage,
  LLMCompletionOptions,
  LLMCompletionResult,
  LLMConfig,
  LLMProvider,
} from './types.js';
import { describeHttpError, requireApiKey } from './utils.js';

function extractJSON(text: string): string {
  const fenced = text.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
  return fenced ? fenced[1]!.trim() : text.trim();
}

const PROMPT_TYPE_KEYS = [
  'principleExtraction',
  'contradictionDetection',
  'causalArticulation',
  'contextResolution',
] as const;

export class MockLLMProvider implements LLMProvider {
  responses: Record<string, unknown>;
  modelName: string;
  modelVersion: string;

  constructor({ responses = {} }: Partial<LLMConfig> = {}) {
    this.responses = (responses ?? {}) as Record<string, unknown>;
    this.modelName = 'mock-llm';
    this.modelVersion = '1.0.0';
  }

  _matchPromptType(messages: ChatMessage[]): string | null {
    const systemMsg = messages.find(m => m.role === 'system')?.content || '';
    for (const key of PROMPT_TYPE_KEYS) {
      if (systemMsg.includes(key)) return key;
    }
    return null;
  }

  async complete(messages: ChatMessage[]): Promise<LLMCompletionResult> {
    const promptType = this._matchPromptType(messages);
    const cannedResponse = promptType ? this.responses[promptType] : undefined;
    return { content: cannedResponse !== undefined ? JSON.stringify(cannedResponse) : '{}' };
  }

  async json(messages: ChatMessage[]): Promise<unknown> {
    const promptType = this._matchPromptType(messages);
    const cannedResponse = promptType ? this.responses[promptType] : undefined;
    return cannedResponse !== undefined ? cannedResponse : {};
  }
}

export class AnthropicLLMProvider implements LLMProvider {
  apiKey: string | undefined;
  model: string;
  maxTokens: number;
  timeout: number;
  modelName: string;
  modelVersion: string;

  constructor({ apiKey, model = 'claude-sonnet-4-6', maxTokens = 1024, timeout = 30000 }: Partial<LLMConfig> & { timeout?: number } = {}) {
    this.apiKey = apiKey || process.env.ANTHROPIC_API_KEY;
    this.model = model ?? 'claude-sonnet-4-6';
    this.maxTokens = maxTokens ?? 1024;
    this.timeout = timeout ?? 30000;
    this.modelName = this.model;
    this.modelVersion = 'latest';
  }

  async complete(messages: ChatMessage[], options: LLMCompletionOptions = {}): Promise<LLMCompletionResult> {
    requireApiKey(this.apiKey, 'Anthropic LLM', 'ANTHROPIC_API_KEY');
    const systemMsg = messages.find(m => m.role === 'system')?.content;
    const nonSystemMsgs = messages.filter(m => m.role !== 'system');

    const body: Record<string, unknown> = {
      model: this.model,
      max_tokens: options.maxTokens || this.maxTokens,
      messages: nonSystemMsgs,
    };
    if (systemMsg) body.system = systemMsg;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout);
    try {
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': this.apiKey!,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`Anthropic API error: ${await describeHttpError(response)}`);
      }

      const data = await response.json() as { content?: { text?: string }[] };
      const text = data.content?.[0]?.text || '';
      return { content: text };
    } finally {
      clearTimeout(timer);
    }
  }

  async json(messages: ChatMessage[], options: LLMCompletionOptions = {}): Promise<unknown> {
    const result = await this.complete(messages, options);
    try {
      return JSON.parse(extractJSON(result.content));
    } catch {
      throw new Error(`Failed to parse LLM response as JSON: ${result.content.slice(0, 200)}`);
    }
  }
}

export class OpenAILLMProvider implements LLMProvider {
  apiKey: string | undefined;
  model: string;
  maxTokens: number;
  timeout: number;
  modelName: string;
  modelVersion: string;

  constructor({ apiKey, model = 'gpt-4o', maxTokens = 1024, timeout = 30000 }: Partial<LLMConfig> & { timeout?: number } = {}) {
    this.apiKey = apiKey || process.env.OPENAI_API_KEY;
    this.model = model ?? 'gpt-4o';
    this.maxTokens = maxTokens ?? 1024;
    this.timeout = timeout ?? 30000;
    this.modelName = this.model;
    this.modelVersion = 'latest';
  }

  async complete(messages: ChatMessage[], options: LLMCompletionOptions = {}): Promise<LLMCompletionResult> {
    requireApiKey(this.apiKey, 'OpenAI LLM', 'OPENAI_API_KEY');
    const body = {
      model: this.model,
      max_tokens: options.maxTokens || this.maxTokens,
      messages,
    };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout);
    try {
      const response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`OpenAI API error: ${await describeHttpError(response)}`);
      }

      const data = await response.json() as { choices?: { message?: { content?: string } }[] };
      const text = data.choices?.[0]?.message?.content || '';
      return { content: text };
    } finally {
      clearTimeout(timer);
    }
  }

  async json(messages: ChatMessage[], options: LLMCompletionOptions = {}): Promise<unknown> {
    const result = await this.complete(messages, options);
    try {
      return JSON.parse(extractJSON(result.content));
    } catch {
      throw new Error(`Failed to parse LLM response as JSON: ${result.content.slice(0, 200)}`);
    }
  }
}

export function createLLMProvider(config: LLMConfig): LLMProvider {
  switch (config.provider) {
    case 'mock':
      return new MockLLMProvider(config);
    case 'anthropic':
      return new AnthropicLLMProvider(config);
    case 'openai':
      return new OpenAILLMProvider(config);
    default:
      throw new Error(`Unknown LLM provider: ${(config as LLMConfig).provider}. Valid: mock, anthropic, openai`);
  }
}
