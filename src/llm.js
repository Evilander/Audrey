const PROMPT_TYPE_KEYS = [
  'principleExtraction',
  'contradictionDetection',
  'causalArticulation',
  'contextResolution',
];

export class MockLLMProvider {
  constructor({ responses = {} } = {}) {
    this.responses = responses;
    this.modelName = 'mock-llm';
    this.modelVersion = '1.0.0';
  }

  _matchPromptType(messages) {
    const systemMsg = messages.find(m => m.role === 'system')?.content || '';
    for (const key of PROMPT_TYPE_KEYS) {
      if (systemMsg.includes(key)) return key;
    }
    return null;
  }

  async complete(messages) {
    const promptType = this._matchPromptType(messages);
    const cannedResponse = promptType ? this.responses[promptType] : undefined;
    return { content: cannedResponse !== undefined ? JSON.stringify(cannedResponse) : '{}' };
  }

  async json(messages) {
    const promptType = this._matchPromptType(messages);
    const cannedResponse = promptType ? this.responses[promptType] : undefined;
    return cannedResponse !== undefined ? cannedResponse : {};
  }
}

export class AnthropicLLMProvider {
  constructor({ apiKey, model = 'claude-sonnet-4-6', maxTokens = 1024 } = {}) {
    this.apiKey = apiKey || process.env.ANTHROPIC_API_KEY;
    this.model = model;
    this.maxTokens = maxTokens;
    this.modelName = model;
    this.modelVersion = 'latest';
  }

  async complete(messages, options = {}) {
    const systemMsg = messages.find(m => m.role === 'system')?.content;
    const nonSystemMsgs = messages.filter(m => m.role !== 'system');

    const body = {
      model: this.model,
      max_tokens: options.maxTokens || this.maxTokens,
      messages: nonSystemMsgs,
    };
    if (systemMsg) body.system = systemMsg;

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      throw new Error(`Anthropic API error: ${response.status}`);
    }

    const data = await response.json();
    const text = data.content?.[0]?.text || '';
    return { content: text };
  }

  async json(messages, options = {}) {
    const result = await this.complete(messages, options);
    return JSON.parse(result.content);
  }
}

export class OpenAILLMProvider {
  constructor({ apiKey, model = 'gpt-4o', maxTokens = 1024 } = {}) {
    this.apiKey = apiKey || process.env.OPENAI_API_KEY;
    this.model = model;
    this.maxTokens = maxTokens;
    this.modelName = model;
    this.modelVersion = 'latest';
  }

  async complete(messages, options = {}) {
    const body = {
      model: this.model,
      max_tokens: options.maxTokens || this.maxTokens,
      messages,
    };

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      throw new Error(`OpenAI API error: ${response.status}`);
    }

    const data = await response.json();
    const text = data.choices?.[0]?.message?.content || '';
    return { content: text };
  }

  async json(messages, options = {}) {
    const result = await this.complete(messages, options);
    return JSON.parse(result.content);
  }
}

export function createLLMProvider(config) {
  switch (config.provider) {
    case 'mock':
      return new MockLLMProvider(config);
    case 'anthropic':
      return new AnthropicLLMProvider(config);
    case 'openai':
      return new OpenAILLMProvider(config);
    default:
      throw new Error(`Unknown LLM provider: ${config.provider}. Valid: mock, anthropic, openai`);
  }
}
