const DEFAULT_BASE_URL = 'https://api.getzep.com';
const DEFAULT_INGEST_DELAY_MS = 0;
const BATCH_SIZE = 50;

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required for the Zep Cloud GuardBench adapter.`);
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

function resultText(result) {
  return [
    result?.fact,
    result?.content,
    result?.summary,
    result?.name,
    result?.context,
  ].filter(Boolean).join('\n');
}

function collectSearchResults(response) {
  const rows = [];
  for (const key of ['edges', 'episodes', 'nodes', 'observations', 'thread_summaries']) {
    if (Array.isArray(response?.[key])) rows.push(...response[key]);
  }
  if (response?.context) rows.push({ uuid: 'zep-context', context: response.context });
  return rows;
}

function evidenceIds(results) {
  return results.map((result, index) =>
    result?.uuid ?? result?.id ?? result?.task_id ?? result?.thread_id ?? `zep-result-${index + 1}`);
}

function decisionFromSearchResults(results, action, unsupportedFault = null) {
  if (unsupportedFault) {
    return {
      decision: 'warn',
      riskScore: 0.55,
      evidenceIds: evidenceIds(results),
      recommendedActions: ['External adapter cannot inject storage faults into Zep Cloud; verify memory health separately.'],
      summary: `Zep Cloud adapter cannot emulate fault injection: ${unsupportedFault}.`,
    };
  }

  const query = actionText(action);
  const texts = results.map(resultText);
  const joined = texts.join('\n').toLowerCase();
  if (/\b(must-follow|never|do not|high-risk|conflicting)\b/i.test(joined)) {
    const relevant = texts.some(text => tokenOverlap(query, text) >= 0.18);
    return {
      decision: relevant ? 'block' : 'warn',
      riskScore: relevant ? 0.85 : 0.55,
      evidenceIds: evidenceIds(results),
      recommendedActions: ['Review retrieved Zep graph memory before acting.'],
      summary: relevant
        ? 'Zep returned policy-like graph memory with lexical overlap; adapter escalated from retrieval to a block.'
        : 'Zep returned policy-like graph memory without enough lexical overlap for a block.',
    };
  }

  if (results.length > 0) {
    return {
      decision: 'warn',
      riskScore: 0.35,
      evidenceIds: evidenceIds(results),
      recommendedActions: ['Treat retrieved Zep graph memory as advisory context.'],
      summary: 'Zep returned related graph memory, but no policy-like control evidence was found.',
    };
  }

  return {
    decision: 'allow',
    riskScore: 0,
    evidenceIds: [],
    recommendedActions: [],
    summary: 'Zep returned no relevant graph memory for this action.',
  };
}

class ZepCloudClient {
  constructor({
    apiKey = requireEnv('ZEP_API_KEY'),
    baseUrl = process.env.ZEP_BASE_URL ?? DEFAULT_BASE_URL,
    authScheme = process.env.ZEP_AUTH_SCHEME ?? 'Api-Key',
    fetchImpl = globalThis.fetch,
  } = {}) {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.authScheme = authScheme;
    this.fetch = fetchImpl;
  }

  get authorization() {
    return this.authScheme ? `${this.authScheme} ${this.apiKey}` : this.apiKey;
  }

  async request(path, { method = 'GET', body, okStatuses = [200, 201, 204], ignoreNotFound = false } = {}) {
    const response = await this.fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        Authorization: this.authorization,
        'Content-Type': 'application/json',
      },
      body: body == null ? undefined : JSON.stringify(body),
    });

    if (ignoreNotFound && response.status === 404) return null;
    if (!okStatuses.includes(response.status)) {
      const text = await response.text();
      throw new Error(`Zep ${method} ${path} failed ${response.status}: ${text.slice(0, 500)}`);
    }

    if (response.status === 204) return null;
    const text = await response.text();
    return text ? JSON.parse(text) : null;
  }

  async createUser(userId) {
    return this.request('/api/v2/users', {
      method: 'POST',
      body: { user_id: userId },
    });
  }

  async createSession({ sessionId, userId }) {
    return this.request('/api/v2/sessions', {
      method: 'POST',
      body: { session_id: sessionId, user_id: userId },
    });
  }

  async addMessages({ sessionId, messages }) {
    if (messages.length === 0) return null;
    return this.request(`/api/v2/sessions/${encodeURIComponent(sessionId)}/memory`, {
      method: 'POST',
      body: { messages, return_context: false },
    });
  }

  async searchGraph({ userId, query }) {
    return this.request('/api/v2/graph/search', {
      method: 'POST',
      body: {
        user_id: userId,
        query: query.slice(0, 400),
        scope: 'edges',
        limit: 10,
      },
    });
  }

  async deleteUser(userId) {
    return this.request(`/api/v2/users/${encodeURIComponent(userId)}`, {
      method: 'DELETE',
      ignoreNotFound: true,
    });
  }
}

function message(content) {
  return {
    role: 'guardbench',
    role_type: 'norole',
    content,
  };
}

function memoryMessagesFromScenario(scenario) {
  const messages = [];
  for (const memory of scenario.seed.seededMemories ?? []) {
    messages.push(message(memory.content));
  }
  for (const event of scenario.seed.seededToolEvents ?? []) {
    const seededSecret = event.errorSummaryPattern && scenario.privateSeed?.seededSecrets?.[0]
      ? `${'x'.repeat(1990)} ${scenario.privateSeed.seededSecrets[0]}`
      : '';
    messages.push(message([
      `Tool event: ${event.tool ?? 'tool'}`,
      event.action ? `Action: ${event.action}` : '',
      event.outcome ? `Outcome: ${event.outcome}` : '',
      event.errorSummary ? `Error: ${event.errorSummary}` : '',
      event.errorSummaryPattern ? `Error pattern: ${event.errorSummaryPattern}` : '',
      seededSecret ? `Error: ${seededSecret}` : '',
      event.output ? `Output: ${event.output}` : '',
    ].filter(Boolean).join('\n')));
  }
  if (scenario.seed.seededNoise?.count) {
    for (let i = 0; i < scenario.seed.seededNoise.count; i++) {
      messages.push(message(`Irrelevant background memory ${i}: UI color preference, lunch note, or unrelated calendar detail.`));
    }
  }
  return messages;
}

async function addInBatches(client, { sessionId, messages }) {
  for (let i = 0; i < messages.length; i += BATCH_SIZE) {
    await client.addMessages({
      sessionId,
      messages: messages.slice(i, i + BATCH_SIZE),
    });
  }
}

function idForScenario(kind, scenario) {
  const prefix = process.env.ZEP_GUARDBENCH_USER_PREFIX ?? 'audrey-guardbench';
  const runId = process.env.ZEP_GUARDBENCH_RUN_ID ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `${prefix}-${runId}-${kind}-${scenario.id}`.toLowerCase();
}

export function createGuardBenchAdapter(options = {}) {
  return {
    name: 'Zep Cloud',
    description: 'Zep Cloud REST adapter using v2 users, sessions, memory.add, graph.search, and user cleanup.',
    async setup({ scenario }) {
      const client = new ZepCloudClient(options);
      const userId = idForScenario('user', scenario);
      const sessionId = idForScenario('session', scenario);
      const messages = memoryMessagesFromScenario(scenario);
      await client.createUser(userId);
      await client.createSession({ sessionId, userId });
      await addInBatches(client, { sessionId, messages });
      const ingestDelayMs = Number(options.ingestDelayMs ?? process.env.ZEP_GUARDBENCH_INGEST_DELAY_MS ?? DEFAULT_INGEST_DELAY_MS);
      if (ingestDelayMs > 0) await sleep(ingestDelayMs);
      return { client, userId, sessionId };
    },
    async decide({ scenario, action, state }) {
      const search = await state.client.searchGraph({
        userId: state.userId,
        query: actionText(action),
      });
      const results = collectSearchResults(search);
      return decisionFromSearchResults(results, action, scenario.seed.faultInjection);
    },
    async cleanup({ state }) {
      if (state?.client && state?.userId && process.env.ZEP_GUARDBENCH_SKIP_CLEANUP !== '1') {
        await state.client.deleteUser(state.userId);
      }
    },
  };
}

export default createGuardBenchAdapter();
