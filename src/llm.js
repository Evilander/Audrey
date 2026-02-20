/**
 * @typedef {Object} ChatMessage
 * @property {'system' | 'user' | 'assistant'} role
 * @property {string} content
 */

/**
 * @typedef {Object} LLMCompletionResult
 * @property {string} content
 */

/**
 * @typedef {Object} LLMCompletionOptions
 * @property {number} [maxTokens]
 */

/**
 * @typedef {Object} LLMProvider
 * @property {string} modelName
 * @property {string} modelVersion
 * @property {(messages: ChatMessage[], options?: LLMCompletionOptions) => Promise<LLMCompletionResult>} complete
 * @property {(messages: ChatMessage[], options?: LLMCompletionOptions) => Promise<Object>} json
 */

/**
 * @typedef {Object} MockLLMConfig
 * @property {'mock'} provider
 * @property {Record<string, Object>} [responses={}]
 */

/**
 * @typedef {Object} AnthropicLLMConfig
 * @property {'anthropic'} provider
 * @property {string} [apiKey]
 * @property {string} [model='claude-sonnet-4-6']
 * @property {number} [maxTokens=1024]
 */

/**
 * @typedef {Object} OpenAILLMConfig
 * @property {'openai'} provider
 * @property {string} [apiKey]
 * @property {string} [model='gpt-4o']
 * @property {number} [maxTokens=1024]
 */

const PROMPT_TYPE_KEYS = [
  'principleExtraction',
  'contradictionDetection',
  'causalArticulation',
  'contextResolution',
];

/** @implements {LLMProvider} */
export class MockLLMProvider {
  /** @param {Partial<MockLLMConfig>} [config={}] */
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

  /**
   * @param {ChatMessage[]} messages
   * @returns {Promise<LLMCompletionResult>}
   */
  async complete(messages) {
    const promptType = this._matchPromptType(messages);
    const cannedResponse = promptType ? this.responses[promptType] : undefined;
    return { content: cannedResponse !== undefined ? JSON.stringify(cannedResponse) : '{}' };
  }

  /**
   * @param {ChatMessage[]} messages
   * @returns {Promise<Object>}
   */
  async json(messages) {
    const promptType = this._matchPromptType(messages);
    const cannedResponse = promptType ? this.responses[promptType] : undefined;
    return cannedResponse !== undefined ? cannedResponse : {};
  }
}

/** @implements {LLMProvider} */
export class AnthropicLLMProvider {
  /** @param {Partial<AnthropicLLMConfig>} [config={}] */
  constructor({ apiKey, model = 'claude-sonnet-4-6', maxTokens = 1024 } = {}) {
    this.apiKey = apiKey || process.env.ANTHROPIC_API_KEY;
    this.model = model;
    this.maxTokens = maxTokens;
    this.modelName = model;
    this.modelVersion = 'latest';
  }

  /**
   * @param {ChatMessage[]} messages
   * @param {LLMCompletionOptions} [options={}]
   * @returns {Promise<LLMCompletionResult>}
   */
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

  /**
   * @param {ChatMessage[]} messages
   * @param {LLMCompletionOptions} [options={}]
   * @returns {Promise<Object>}
   */
  async json(messages, options = {}) {
    const result = await this.complete(messages, options);
    return JSON.parse(result.content);
  }
}

/** @implements {LLMProvider} */
export class OpenAILLMProvider {
  /** @param {Partial<OpenAILLMConfig>} [config={}] */
  constructor({ apiKey, model = 'gpt-4o', maxTokens = 1024 } = {}) {
    this.apiKey = apiKey || process.env.OPENAI_API_KEY;
    this.model = model;
    this.maxTokens = maxTokens;
    this.modelName = model;
    this.modelVersion = 'latest';
  }

  /**
   * @param {ChatMessage[]} messages
   * @param {LLMCompletionOptions} [options={}]
   * @returns {Promise<LLMCompletionResult>}
   */
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

  /**
   * @param {ChatMessage[]} messages
   * @param {LLMCompletionOptions} [options={}]
   * @returns {Promise<Object>}
   */
  async json(messages, options = {}) {
    const result = await this.complete(messages, options);
    return JSON.parse(result.content);
  }
}

/**
 * @param {MockLLMConfig | AnthropicLLMConfig | OpenAILLMConfig} config
 * @returns {MockLLMProvider | AnthropicLLMProvider | OpenAILLMProvider}
 */
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
