#!/usr/bin/env node

const AUDREY_URL = (process.env.AUDREY_URL || 'http://127.0.0.1:7437').replace(/\/$/, '');
const OLLAMA_URL = (process.env.OLLAMA_URL || 'http://127.0.0.1:11434').replace(/\/$/, '');
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'qwen3';
const AUDREY_API_KEY = process.env.AUDREY_API_KEY || '';
const MAX_TOOL_LOOPS = Number.parseInt(process.env.MAX_TOOL_LOOPS || '4', 10);

const userPrompt = process.argv.slice(2).join(' ').trim()
  || 'Use Audrey memory to explain how this local Ollama agent should remember useful facts.';

function usage() {
  console.log(`
Audrey + Ollama local memory agent

Prerequisites:
  1. Start Audrey: AUDREY_AGENT=ollama-local-agent npx audrey serve
  2. Start Ollama and pull a tool-capable model: ollama pull qwen3

Run:
  OLLAMA_MODEL=qwen3 node examples/ollama-memory-agent.js "What should you remember about this project?"

Environment:
  AUDREY_URL=http://127.0.0.1:7437
  AUDREY_API_KEY=secret
  OLLAMA_URL=http://127.0.0.1:11434
  OLLAMA_MODEL=qwen3
`);
}

function headers() {
  const h = { 'Content-Type': 'application/json' };
  if (AUDREY_API_KEY) h.Authorization = `Bearer ${AUDREY_API_KEY}`;
  return h;
}

async function jsonFetch(url, options = {}) {
  const response = await fetch(url, options);
  const text = await response.text();
  let data = null;
  if (text.trim()) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text };
    }
  }
  if (!response.ok) {
    const detail = data?.error || data?.message || text || response.statusText;
    throw new Error(`${response.status} ${response.statusText}: ${detail}`);
  }
  return data;
}

async function audreyGet(path) {
  return jsonFetch(`${AUDREY_URL}${path}`, { headers: headers() });
}

async function audreyPost(path, body) {
  return jsonFetch(`${AUDREY_URL}${path}`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify(body),
  });
}

async function memoryRecall({ query, limit = 5 }) {
  if (!query || typeof query !== 'string') {
    throw new Error('memory_recall requires a string query');
  }
  return audreyPost('/v1/recall', { query, limit });
}

async function memoryCapsule({ query, budget_chars = 4000 }) {
  if (!query || typeof query !== 'string') {
    throw new Error('memory_capsule requires a string query');
  }
  return audreyPost('/v1/capsule', { query, budget_chars });
}

async function memoryPreflight({ action, tool, strict = false, include_capsule = false }) {
  if (!action || typeof action !== 'string') {
    throw new Error('memory_preflight requires a string action');
  }
  return audreyPost('/v1/preflight', { action, tool, strict, include_capsule });
}

async function memoryReflexes({ action, tool, strict = false, include_preflight = false }) {
  if (!action || typeof action !== 'string') {
    throw new Error('memory_reflexes requires a string action');
  }
  return audreyPost('/v1/reflexes', { action, tool, strict, include_preflight });
}

async function memoryEncode({ content, source = 'model-generated', tags = ['ollama-agent'] }) {
  if (!content || typeof content !== 'string') {
    throw new Error('memory_encode requires string content');
  }
  return audreyPost('/v1/encode', { content, source, tags });
}

const toolExecutors = {
  memory_preflight: memoryPreflight,
  memory_reflexes: memoryReflexes,
  memory_recall: memoryRecall,
  memory_capsule: memoryCapsule,
  memory_encode: memoryEncode,
};

const tools = [
  {
    type: 'function',
    function: {
      name: 'memory_preflight',
      description: 'Check Audrey memory before taking an action, so prior failures and rules are not repeated.',
      parameters: {
        type: 'object',
        required: ['action'],
        properties: {
          action: { type: 'string', description: 'Action the agent is considering.' },
          tool: { type: 'string', description: 'Optional tool or command family.' },
          strict: { type: 'boolean', description: 'If true, high-severity warnings can block the action.' },
          include_capsule: { type: 'boolean', description: 'Include full capsule context in the result.' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'memory_reflexes',
      description: 'Return Audrey Memory Reflexes: trigger-response rules for the action the agent is considering.',
      parameters: {
        type: 'object',
        required: ['action'],
        properties: {
          action: { type: 'string', description: 'Action the agent is considering.' },
          tool: { type: 'string', description: 'Optional tool or command family.' },
          strict: { type: 'boolean', description: 'If true, high-severity warnings can become blocking reflexes.' },
          include_preflight: { type: 'boolean', description: 'Include the full underlying preflight report.' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'memory_recall',
      description: 'Recall durable Audrey memories relevant to a query.',
      parameters: {
        type: 'object',
        required: ['query'],
        properties: {
          query: { type: 'string', description: 'Search query for Audrey memory.' },
          limit: { type: 'number', description: 'Maximum memories to return.' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'memory_capsule',
      description: 'Build a compact, evidence-backed Audrey Memory Capsule for the current task.',
      parameters: {
        type: 'object',
        required: ['query'],
        properties: {
          query: { type: 'string', description: 'Current task or question.' },
          budget_chars: { type: 'number', description: 'Maximum capsule size in characters.' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'memory_encode',
      description: 'Store a useful lasting observation, decision, preference, or procedure in Audrey.',
      parameters: {
        type: 'object',
        required: ['content'],
        properties: {
          content: { type: 'string', description: 'Memory content to store.' },
          source: {
            type: 'string',
            enum: ['direct-observation', 'told-by-user', 'tool-result', 'inference', 'model-generated'],
            description: 'Source reliability category.',
          },
          tags: {
            type: 'array',
            items: { type: 'string' },
            description: 'Searchable tags for this memory.',
          },
        },
      },
    },
  },
];

function parseToolArguments(args) {
  if (args == null) return {};
  if (typeof args === 'string') {
    try {
      return JSON.parse(args);
    } catch {
      return { raw: args };
    }
  }
  return args;
}

async function ollamaChat(messages) {
  return jsonFetch(`${OLLAMA_URL}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: OLLAMA_MODEL,
      stream: false,
      messages,
      tools,
    }),
  });
}

async function main() {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    usage();
    return;
  }

  try {
    await audreyGet('/health');
  } catch (err) {
    console.error(`Audrey is not reachable at ${AUDREY_URL}.`);
    console.error('Start it with: AUDREY_AGENT=ollama-local-agent npx audrey serve');
    console.error(`Details: ${err.message}`);
    process.exit(1);
  }

  const reflexes = await memoryReflexes({ action: userPrompt, include_preflight: false });
  const preflight = await memoryPreflight({ action: userPrompt, include_capsule: false });
  const capsule = await memoryCapsule({ query: userPrompt, budget_chars: 4000 });
  const messages = [
    {
      role: 'system',
      content: [
        'You are a local Ollama agent with Audrey long-term memory.',
        'Use Audrey tools when memory would improve the answer.',
        'Before taking risky tool actions, call memory_reflexes or memory_preflight and follow any warnings.',
        'Store only durable preferences, facts, decisions, procedures, and useful lessons.',
        '',
        'Initial Audrey Memory Reflexes:',
        JSON.stringify(reflexes, null, 2).slice(0, 3000),
        '',
        'Initial Audrey Preflight:',
        JSON.stringify(preflight, null, 2).slice(0, 3000),
        '',
        'Initial Audrey Memory Capsule:',
        JSON.stringify(capsule, null, 2).slice(0, 6000),
      ].join('\n'),
    },
    { role: 'user', content: userPrompt },
  ];

  console.error(`[audrey-ollama] model=${OLLAMA_MODEL} audrey=${AUDREY_URL} ollama=${OLLAMA_URL}`);

  for (let i = 0; i < MAX_TOOL_LOOPS; i += 1) {
    let response;
    try {
      response = await ollamaChat(messages);
    } catch (err) {
      console.error(`Ollama is not reachable at ${OLLAMA_URL}, or model "${OLLAMA_MODEL}" is not available.`);
      console.error(`Try: ollama pull ${OLLAMA_MODEL}`);
      console.error(`Details: ${err.message}`);
      process.exit(1);
    }

    const message = response.message || {};
    messages.push(message);

    const calls = message.tool_calls || [];
    if (calls.length === 0) {
      console.log(message.content || '(model returned no content)');
      await memoryEncode({
        content: `Ollama agent answered: ${userPrompt.slice(0, 240)}`,
        source: 'model-generated',
        tags: ['ollama-agent', 'session-summary'],
      }).catch(() => undefined);
      return;
    }

    for (const call of calls) {
      const name = call.function?.name;
      const executor = toolExecutors[name];
      if (!executor) {
        messages.push({ role: 'tool', tool_name: name || 'unknown', content: 'Unknown Audrey tool' });
        continue;
      }

      const args = parseToolArguments(call.function?.arguments);
      console.error(`[audrey-ollama] tool ${name} ${JSON.stringify(args)}`);
      try {
        const result = await executor(args);
        messages.push({
          role: 'tool',
          tool_name: name,
          content: JSON.stringify(result).slice(0, 8000),
        });
      } catch (err) {
        messages.push({
          role: 'tool',
          tool_name: name,
          content: `Audrey tool error: ${err.message}`,
        });
      }
    }
  }

  console.log('Stopped after MAX_TOOL_LOOPS without a final model answer.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
