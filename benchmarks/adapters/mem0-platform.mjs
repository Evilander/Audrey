const DEFAULT_BASE_URL = 'https://api.mem0.ai';
const DEFAULT_POLL_TIMEOUT_MS = 60_000;
const DEFAULT_POLL_INTERVAL_MS = 1_000;
const BATCH_SIZE = 100;

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required for the Mem0 GuardBench adapter.`);
  }
  return value;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function actionText(action) {
  return [action.action, action.command, action.tool, action.cwd, ...(action.files ?? [])]
    .filter(Boolean)
    .join('\n');
}

function normalize(text) {
  return String(text || '').toLowerCase();
}

function tokenize(text) {
  return normalize(text)
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(token => token.length > 2);
}

function tokenOverlap(a, b) {
  const tokens = tokenize(a);
  if (tokens.length === 0) return 0;
  const other = new Set(tokenize(b));
  let matches = 0;
  for (const token of tokens) {
    if (other.has(token)) matches++;
  }
  return matches / tokens.length;
}

function memoryText(memory) {
  return String(memory?.memory ?? memory?.text ?? memory?.content ?? '');
}

function evidenceIds(memories) {
  return memories
    .map(memory => memory?.id ?? memory?.memory_id)
    .filter(Boolean);
}

function decisionFromMemories(memories, action, unsupportedFault = null) {
  if (unsupportedFault) {
    return {
      decision: 'warn',
      riskScore: 0.55,
      evidenceIds: evidenceIds(memories),
      recommendedActions: ['External adapter cannot inject storage faults into Mem0 Platform; verify memory health separately.'],
      summary: `Mem0 adapter cannot emulate fault injection: ${unsupportedFault}.`,
    };
  }

  const query = actionText(action);
  const texts = memories.map(memoryText);
  const joined = texts.join('\n').toLowerCase();
  if (/\b(must-follow|never|do not|high-risk|conflicting)\b/i.test(joined)) {
    const relevant = texts.some(text => tokenOverlap(query, text) >= 0.18);
    return {
      decision: relevant ? 'block' : 'warn',
      riskScore: relevant ? 0.85 : 0.55,
      evidenceIds: evidenceIds(memories),
      recommendedActions: ['Review retrieved Mem0 memory before acting.'],
      summary: relevant
        ? 'Mem0 retrieved policy-like memory with lexical overlap; adapter escalated from retrieval to a block.'
        : 'Mem0 retrieved policy-like memory without enough lexical overlap for a block.',
    };
  }

  if (memories.length > 0) {
    return {
      decision: 'warn',
      riskScore: 0.35,
      evidenceIds: evidenceIds(memories),
      recommendedActions: ['Treat retrieved Mem0 memories as advisory context.'],
      summary: 'Mem0 retrieved related memory, but no policy-like control evidence was found.',
    };
  }

  return {
    decision: 'allow',
    riskScore: 0,
    evidenceIds: [],
    recommendedActions: [],
    summary: 'Mem0 returned no relevant memories for this action.',
  };
}

class Mem0PlatformClient {
  constructor({
    apiKey = requireEnv('MEM0_API_KEY'),
    baseUrl = process.env.MEM0_BASE_URL ?? DEFAULT_BASE_URL,
    pollTimeoutMs = Number(process.env.MEM0_EVENT_TIMEOUT_MS ?? DEFAULT_POLL_TIMEOUT_MS),
    pollIntervalMs = Number(process.env.MEM0_EVENT_POLL_INTERVAL_MS ?? DEFAULT_POLL_INTERVAL_MS),
    fetchImpl = globalThis.fetch,
  } = {}) {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.pollTimeoutMs = pollTimeoutMs;
    this.pollIntervalMs = pollIntervalMs;
    this.fetch = fetchImpl;
  }

  async request(path, options = {}) {
    const response = await this.fetch(`${this.baseUrl}${path}`, {
      ...options,
      headers: {
        Authorization: `Token ${this.apiKey}`,
        'Content-Type': 'application/json',
        ...(options.headers ?? {}),
      },
    });

    if (!response.ok && response.status !== 204) {
      const body = await response.text();
      throw new Error(`Mem0 ${options.method ?? 'GET'} ${path} failed ${response.status}: ${body.slice(0, 500)}`);
    }

    if (response.status === 204) return null;
    const text = await response.text();
    return text ? JSON.parse(text) : null;
  }

  async addMessages({ userId, messages, metadata }) {
    if (messages.length === 0) return;
    const response = await this.request('/v3/memories/add/', {
      method: 'POST',
      body: JSON.stringify({
        user_id: userId,
        messages,
        metadata,
        infer: false,
      }),
    });
    if (response?.event_id) {
      await this.waitForEvent(response.event_id);
    }
  }

  async waitForEvent(eventId) {
    const started = Date.now();
    while (Date.now() - started < this.pollTimeoutMs) {
      const event = await this.request(`/v1/event/${eventId}/`);
      if (event?.status === 'SUCCEEDED') return event;
      if (event?.status === 'FAILED') {
        throw new Error(`Mem0 event ${eventId} failed: ${JSON.stringify(event).slice(0, 500)}`);
      }
      await sleep(this.pollIntervalMs);
    }
    throw new Error(`Timed out waiting for Mem0 event ${eventId}.`);
  }

  async search({ userId, query }) {
    const response = await this.request('/v2/memories/search', {
      method: 'POST',
      body: JSON.stringify({
        query,
        version: 'v2',
        filters: { user_id: userId },
      }),
    });
    return Array.isArray(response) ? response : response?.results ?? [];
  }

  async deleteUser(userId) {
    await this.request(`/v2/entities/user/${encodeURIComponent(userId)}/`, {
      method: 'DELETE',
    });
  }
}

function memoryMessagesFromScenario(scenario) {
  const messages = [];
  for (const memory of scenario.seed.seededMemories ?? []) {
    messages.push({ role: 'user', content: memory.content });
  }
  for (const event of scenario.seed.seededToolEvents ?? []) {
    const seededSecret = event.errorSummaryPattern && scenario.privateSeed?.seededSecrets?.[0]
      ? `${'x'.repeat(1990)} ${scenario.privateSeed.seededSecrets[0]}`
      : '';
    messages.push({
      role: 'user',
      content: [
        `Tool event: ${event.tool ?? 'tool'}`,
        event.action ? `Action: ${event.action}` : '',
        event.outcome ? `Outcome: ${event.outcome}` : '',
        event.errorSummary ? `Error: ${event.errorSummary}` : '',
        event.errorSummaryPattern ? `Error pattern: ${event.errorSummaryPattern}` : '',
        seededSecret ? `Error: ${seededSecret}` : '',
        event.output ? `Output: ${event.output}` : '',
      ].filter(Boolean).join('\n'),
    });
  }
  if (scenario.seed.seededNoise?.count) {
    for (let i = 0; i < scenario.seed.seededNoise.count; i++) {
      messages.push({
        role: 'user',
        content: `Irrelevant background memory ${i}: UI color preference, lunch note, or unrelated calendar detail.`,
      });
    }
  }
  return messages;
}

async function addInBatches(client, { userId, scenario, messages }) {
  for (let i = 0; i < messages.length; i += BATCH_SIZE) {
    await client.addMessages({
      userId,
      messages: messages.slice(i, i + BATCH_SIZE),
      metadata: {
        benchmark: 'guardbench',
        scenario_id: scenario.id,
        adapter: 'mem0-platform',
      },
    });
  }
}

function userIdForScenario(scenario) {
  const prefix = process.env.MEM0_GUARDBENCH_USER_PREFIX ?? 'audrey-guardbench';
  const runId = process.env.MEM0_GUARDBENCH_RUN_ID ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `${prefix}-${runId}-${scenario.id}`.toLowerCase();
}

export function createGuardBenchAdapter(options = {}) {
  return {
    name: 'Mem0 Platform',
    description: 'Mem0 Platform REST adapter using V3 add, V2 search, event polling, and entity cleanup.',
    async setup({ scenario }) {
      const client = new Mem0PlatformClient(options);
      const userId = userIdForScenario(scenario);
      const messages = memoryMessagesFromScenario(scenario);
      await addInBatches(client, { userId, scenario, messages });
      return { client, userId };
    },
    async decide({ scenario, action, state }) {
      const memories = await state.client.search({
        userId: state.userId,
        query: actionText(action),
      });
      return decisionFromMemories(memories, action, scenario.seed.faultInjection);
    },
    async cleanup({ state }) {
      if (state?.client && state?.userId && process.env.MEM0_GUARDBENCH_SKIP_CLEANUP !== '1') {
        await state.client.deleteUser(state.userId);
      }
    },
  };
}

export default createGuardBenchAdapter();
