# Audrey MCP Server Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Wrap Audrey's core API as a 5-tool MCP server so Claude Code gets persistent biological memory via stdio transport.

**Architecture:** Single `mcp-server/index.js` entry point using `@modelcontextprotocol/sdk` with stdio transport. Creates an `Audrey` instance from env vars at startup, registers 5 tools (encode, recall, consolidate, introspect, resolve_truth), returns JSON results. All logging to stderr.

**Tech Stack:** Node.js (ES modules), @modelcontextprotocol/sdk, zod, better-sqlite3, sqlite-vec

**Design doc:** `docs/plans/2026-02-19-mcp-server-design.md`

---

## Task 1: Install Dependencies

**Files:**
- Modify: `package.json`

**Step 1: Install MCP SDK and zod**

Run: `cd A:/ai/claude/audrey && npm install @modelcontextprotocol/sdk zod`

**Step 2: Verify package.json updated**

Run: `cd A:/ai/claude/audrey && node -e "import('@modelcontextprotocol/sdk/server/mcp.js').then(() => console.log('OK')).catch(e => console.error(e))"`
Expected: `OK`

**Step 3: Commit**

```bash
cd A:/ai/claude/audrey
git add package.json package-lock.json
git commit -m "chore: add @modelcontextprotocol/sdk and zod dependencies"
```

---

## Task 2: MCP Server Entry Point — Startup and Config

**Files:**
- Create: `mcp-server/index.js`

**Step 1: Create the server with Audrey instance from env vars**

```js
// mcp-server/index.js
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { Audrey } from '../src/index.js';

const dataDir = process.env.AUDREY_DATA_DIR || join(homedir(), '.audrey', 'data');
const agent = process.env.AUDREY_AGENT || 'claude-code';

const embeddingProvider = process.env.AUDREY_EMBEDDING_PROVIDER || 'mock';
const embeddingDimensions = parseInt(process.env.AUDREY_EMBEDDING_DIMENSIONS || (embeddingProvider === 'openai' ? '1536' : '8'), 10);

const embeddingConfig = { provider: embeddingProvider, dimensions: embeddingDimensions };
if (embeddingProvider === 'openai') {
  embeddingConfig.apiKey = process.env.OPENAI_API_KEY;
}

const llmProvider = process.env.AUDREY_LLM_PROVIDER;
let llmConfig;
if (llmProvider) {
  llmConfig = { provider: llmProvider };
  if (llmProvider === 'anthropic') llmConfig.apiKey = process.env.ANTHROPIC_API_KEY;
  if (llmProvider === 'openai') llmConfig.apiKey = process.env.OPENAI_API_KEY;
}

let audrey;
try {
  audrey = new Audrey({ dataDir, agent, embedding: embeddingConfig, llm: llmConfig });
  console.error(`Audrey initialized: ${dataDir} (${embeddingProvider} embeddings, ${embeddingDimensions}d)`);
} catch (err) {
  console.error(`Failed to initialize Audrey: ${err.message}`);
  process.exit(1);
}

const server = new McpServer({
  name: 'audrey-memory',
  version: '0.3.0',
});

// Tools registered in Tasks 3-7

const transport = new StdioServerTransport();
await server.connect(transport);
console.error('Audrey MCP server running on stdio');

process.on('SIGINT', () => {
  audrey.close();
  process.exit(0);
});
```

**Step 2: Verify it starts (will exit since no stdin, but shouldn't crash)**

Run: `cd A:/ai/claude/audrey && echo '{}' | timeout 3 node mcp-server/index.js 2>&1 || true`
Expected: Stderr shows "Audrey initialized" (may error on protocol handshake — that's OK at this stage)

**Step 3: Commit**

```bash
cd A:/ai/claude/audrey
git add mcp-server/index.js
git commit -m "feat: add MCP server entry point with Audrey startup from env vars"
```

---

## Task 3: Tool — memory_encode

**Files:**
- Modify: `mcp-server/index.js`
- Create: `tests/mcp-server.test.js`

**Step 1: Write failing tests**

```js
// tests/mcp-server.test.js
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Audrey } from '../src/index.js';
import { existsSync, rmSync } from 'node:fs';

const TEST_DIR = './test-mcp-data';

// Test the tool handler logic directly — no MCP transport needed
// We test the Audrey operations that the MCP tools will call

describe('MCP tool: memory_encode', () => {
  let audrey;

  beforeEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    audrey = new Audrey({
      dataDir: TEST_DIR,
      agent: 'test-mcp',
      embedding: { provider: 'mock', dimensions: 8 },
    });
  });

  afterEach(() => {
    audrey.close();
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  it('encodes an episode and returns id', async () => {
    const id = await audrey.encode({
      content: 'User prefers dark mode',
      source: 'told-by-user',
    });
    expect(typeof id).toBe('string');
    expect(id.length).toBe(26); // ULID
  });

  it('encodes with tags', async () => {
    const id = await audrey.encode({
      content: 'Stripe rate limit is 100/s',
      source: 'direct-observation',
      tags: ['stripe', 'api'],
    });
    const ep = audrey.db.prepare('SELECT tags FROM episodes WHERE id = ?').get(id);
    expect(JSON.parse(ep.tags)).toEqual(['stripe', 'api']);
  });

  it('rejects empty content', async () => {
    await expect(audrey.encode({ content: '', source: 'told-by-user' }))
      .rejects.toThrow();
  });

  it('rejects invalid source', async () => {
    await expect(audrey.encode({ content: 'test', source: 'invalid-source' }))
      .rejects.toThrow();
  });
});
```

**Step 2: Run tests to verify they pass** (these test Audrey directly, should already work)

Run: `cd A:/ai/claude/audrey && npx vitest run tests/mcp-server.test.js`
Expected: All PASS

**Step 3: Add memory_encode tool to mcp-server/index.js**

Insert before the transport connection:

```js
const VALID_SOURCES = ['direct-observation', 'told-by-user', 'tool-result', 'inference', 'model-generated'];

server.tool(
  'memory_encode',
  {
    content: z.string().min(1).describe('The observation, fact, or experience to remember'),
    source: z.enum(VALID_SOURCES).describe('Where this information came from'),
    tags: z.array(z.string()).optional().describe('Categorization tags'),
    salience: z.number().min(0).max(1).optional().describe('Importance weight (0-1)'),
  },
  async ({ content, source, tags, salience }) => {
    try {
      const id = await audrey.encode({ content, source, tags, salience });
      return { content: [{ type: 'text', text: JSON.stringify({ id, content, source }) }] };
    } catch (err) {
      return { isError: true, content: [{ type: 'text', text: `Encode failed: ${err.message}` }] };
    }
  }
);
```

**Step 4: Commit**

```bash
cd A:/ai/claude/audrey
git add mcp-server/index.js tests/mcp-server.test.js
git commit -m "feat: add memory_encode MCP tool"
```

---

## Task 4: Tool — memory_recall

**Files:**
- Modify: `mcp-server/index.js`
- Modify: `tests/mcp-server.test.js`

**Step 1: Add recall tests**

Append to `tests/mcp-server.test.js`:

```js
describe('MCP tool: memory_recall', () => {
  let audrey;

  beforeEach(async () => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    audrey = new Audrey({
      dataDir: TEST_DIR,
      agent: 'test-mcp',
      embedding: { provider: 'mock', dimensions: 8 },
    });
    await audrey.encode({ content: 'Stripe rate limit is 100 req/s', source: 'direct-observation' });
    await audrey.encode({ content: 'Redis default port is 6379', source: 'told-by-user' });
  });

  afterEach(() => {
    audrey.close();
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  it('recalls memories matching a query', async () => {
    const results = await audrey.recall('stripe rate limit');
    expect(Array.isArray(results)).toBe(true);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]).toHaveProperty('content');
    expect(results[0]).toHaveProperty('score');
  });

  it('respects limit parameter', async () => {
    const results = await audrey.recall('test', { limit: 1 });
    expect(results.length).toBeLessThanOrEqual(1);
  });

  it('returns empty array for no matches when min_confidence is high', async () => {
    const results = await audrey.recall('nonexistent quantum topic', { minConfidence: 0.99 });
    expect(results).toEqual([]);
  });
});
```

**Step 2: Run tests**

Run: `cd A:/ai/claude/audrey && npx vitest run tests/mcp-server.test.js`
Expected: All PASS

**Step 3: Add memory_recall tool to mcp-server/index.js**

```js
server.tool(
  'memory_recall',
  {
    query: z.string().min(1).describe('What to search for in memory'),
    limit: z.number().int().min(1).max(50).optional().describe('Max results (default 10)'),
    types: z.array(z.enum(['episodic', 'semantic', 'procedural'])).optional().describe('Filter by memory type'),
    min_confidence: z.number().min(0).max(1).optional().describe('Minimum confidence threshold'),
  },
  async ({ query, limit, types, min_confidence }) => {
    try {
      const results = await audrey.recall(query, {
        limit: limit || 10,
        types,
        minConfidence: min_confidence || 0,
      });
      return { content: [{ type: 'text', text: JSON.stringify(results) }] };
    } catch (err) {
      return { isError: true, content: [{ type: 'text', text: `Recall failed: ${err.message}` }] };
    }
  }
);
```

**Step 4: Commit**

```bash
cd A:/ai/claude/audrey
git add mcp-server/index.js tests/mcp-server.test.js
git commit -m "feat: add memory_recall MCP tool"
```

---

## Task 5: Tool — memory_consolidate

**Files:**
- Modify: `mcp-server/index.js`
- Modify: `tests/mcp-server.test.js`

**Step 1: Add consolidation tests**

Append to `tests/mcp-server.test.js`:

```js
describe('MCP tool: memory_consolidate', () => {
  let audrey;

  beforeEach(async () => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    audrey = new Audrey({
      dataDir: TEST_DIR,
      agent: 'test-mcp',
      embedding: { provider: 'mock', dimensions: 8 },
    });
  });

  afterEach(() => {
    audrey.close();
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  it('runs consolidation and returns stats', async () => {
    await audrey.encode({ content: 'same observation', source: 'direct-observation' });
    await audrey.encode({ content: 'same observation', source: 'tool-result' });
    await audrey.encode({ content: 'same observation', source: 'told-by-user' });

    const result = await audrey.consolidate({
      minClusterSize: 3,
      similarityThreshold: 0.99,
    });

    expect(result).toHaveProperty('runId');
    expect(result).toHaveProperty('principlesExtracted');
    expect(result.principlesExtracted).toBe(1);
  });

  it('returns zero when nothing to consolidate', async () => {
    const result = await audrey.consolidate();
    expect(result.principlesExtracted).toBe(0);
  });
});
```

**Step 2: Run tests**

Run: `cd A:/ai/claude/audrey && npx vitest run tests/mcp-server.test.js`
Expected: All PASS

**Step 3: Add memory_consolidate tool**

```js
server.tool(
  'memory_consolidate',
  {
    min_cluster_size: z.number().int().min(2).optional().describe('Minimum episodes to form a principle (default 3)'),
    similarity_threshold: z.number().min(0).max(1).optional().describe('Clustering threshold (default 0.80)'),
  },
  async ({ min_cluster_size, similarity_threshold }) => {
    try {
      const result = await audrey.consolidate({
        minClusterSize: min_cluster_size || 3,
        similarityThreshold: similarity_threshold || 0.80,
      });
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    } catch (err) {
      return { isError: true, content: [{ type: 'text', text: `Consolidation failed: ${err.message}` }] };
    }
  }
);
```

**Step 4: Commit**

```bash
cd A:/ai/claude/audrey
git add mcp-server/index.js tests/mcp-server.test.js
git commit -m "feat: add memory_consolidate MCP tool"
```

---

## Task 6: Tool — memory_introspect

**Files:**
- Modify: `mcp-server/index.js`
- Modify: `tests/mcp-server.test.js`

**Step 1: Add introspect tests**

Append to `tests/mcp-server.test.js`:

```js
describe('MCP tool: memory_introspect', () => {
  let audrey;

  beforeEach(async () => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    audrey = new Audrey({
      dataDir: TEST_DIR,
      agent: 'test-mcp',
      embedding: { provider: 'mock', dimensions: 8 },
    });
  });

  afterEach(() => {
    audrey.close();
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  it('returns memory system stats', async () => {
    await audrey.encode({ content: 'test', source: 'direct-observation' });
    const stats = audrey.introspect();
    expect(stats.episodic).toBe(1);
    expect(stats.semantic).toBe(0);
    expect(stats).toHaveProperty('contradictions');
    expect(stats).toHaveProperty('lastConsolidation');
  });
});
```

**Step 2: Run tests**

Run: `cd A:/ai/claude/audrey && npx vitest run tests/mcp-server.test.js`
Expected: All PASS

**Step 3: Add memory_introspect tool**

```js
server.tool(
  'memory_introspect',
  {},
  async () => {
    try {
      const stats = audrey.introspect();
      return { content: [{ type: 'text', text: JSON.stringify(stats) }] };
    } catch (err) {
      return { isError: true, content: [{ type: 'text', text: `Introspect failed: ${err.message}` }] };
    }
  }
);
```

**Step 4: Commit**

```bash
cd A:/ai/claude/audrey
git add mcp-server/index.js tests/mcp-server.test.js
git commit -m "feat: add memory_introspect MCP tool"
```

---

## Task 7: Tool — memory_resolve_truth

**Files:**
- Modify: `mcp-server/index.js`
- Modify: `tests/mcp-server.test.js`

**Step 1: Add resolve_truth tests**

Append to `tests/mcp-server.test.js`:

```js
import { MockLLMProvider } from '../src/llm.js';

describe('MCP tool: memory_resolve_truth', () => {
  let audrey;

  beforeEach(async () => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    audrey = new Audrey({
      dataDir: TEST_DIR,
      agent: 'test-mcp',
      embedding: { provider: 'mock', dimensions: 8 },
      llm: {
        provider: 'mock',
        responses: {
          contextResolution: {
            resolution: 'context_dependent',
            conditions: { a: 'live mode', b: 'test mode' },
            explanation: 'Both valid in different contexts',
          },
        },
      },
    });
  });

  afterEach(() => {
    audrey.close();
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  it('resolves an open contradiction', async () => {
    // Create a contradiction manually
    audrey.db.prepare(`INSERT INTO contradictions (id, claim_a_id, claim_a_type, claim_b_id, claim_b_type,
      state, created_at) VALUES (?, ?, ?, ?, ?, 'open', ?)`).run(
      'con-test', 'sem-a', 'semantic', 'ep-b', 'episodic', new Date().toISOString()
    );
    audrey.db.prepare(`INSERT INTO semantics (id, content, state, created_at, evidence_count,
      supporting_count, source_type_diversity, evidence_episode_ids)
      VALUES (?, ?, 'active', ?, 1, 1, 1, '[]')`).run(
      'sem-a', 'Claim A', new Date().toISOString()
    );
    audrey.db.prepare(`INSERT INTO episodes (id, content, source, source_reliability, created_at)
      VALUES (?, ?, ?, ?, ?)`).run(
      'ep-b', 'Claim B', 'direct-observation', 0.95, new Date().toISOString()
    );

    const result = await audrey.resolveTruth('con-test');
    expect(result.resolution).toBe('context_dependent');
    expect(result.conditions).toBeDefined();
  });

  it('throws when no LLM configured', async () => {
    const noLlm = new Audrey({
      dataDir: TEST_DIR + '-nollm',
      agent: 'test',
      embedding: { provider: 'mock', dimensions: 8 },
    });

    await expect(noLlm.resolveTruth('fake-id')).rejects.toThrow('requires an LLM provider');
    noLlm.close();
    if (existsSync(TEST_DIR + '-nollm')) rmSync(TEST_DIR + '-nollm', { recursive: true });
  });
});
```

**Step 2: Run tests**

Run: `cd A:/ai/claude/audrey && npx vitest run tests/mcp-server.test.js`
Expected: All PASS

**Step 3: Add memory_resolve_truth tool**

```js
server.tool(
  'memory_resolve_truth',
  {
    contradiction_id: z.string().min(1).describe('The ID of the contradiction to resolve'),
  },
  async ({ contradiction_id }) => {
    try {
      const result = await audrey.resolveTruth(contradiction_id);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    } catch (err) {
      return { isError: true, content: [{ type: 'text', text: `Resolve failed: ${err.message}` }] };
    }
  }
);
```

**Step 4: Run full test suite**

Run: `cd A:/ai/claude/audrey && npm test`
Expected: All tests PASS

**Step 5: Commit**

```bash
cd A:/ai/claude/audrey
git add mcp-server/index.js tests/mcp-server.test.js
git commit -m "feat: add memory_resolve_truth MCP tool"
```

---

## Task 8: Registration Script and Final Verification

**Files:**
- Create: `mcp-server/register.sh`

**Step 1: Create registration helper**

```bash
#!/usr/bin/env bash
# mcp-server/register.sh — Register Audrey MCP server with Claude Code
# Usage: bash mcp-server/register.sh [--openai] [--anthropic]

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SERVER_PATH="$SCRIPT_DIR/index.js"

ENVS="AUDREY_DATA_DIR=$HOME/.audrey/data"

if [[ "$*" == *"--openai"* ]]; then
  ENVS="$ENVS,AUDREY_EMBEDDING_PROVIDER=openai,AUDREY_EMBEDDING_DIMENSIONS=1536"
  if [ -n "$OPENAI_API_KEY" ]; then
    ENVS="$ENVS,OPENAI_API_KEY=$OPENAI_API_KEY"
  fi
else
  ENVS="$ENVS,AUDREY_EMBEDDING_PROVIDER=mock,AUDREY_EMBEDDING_DIMENSIONS=8"
fi

if [[ "$*" == *"--anthropic"* ]]; then
  ENVS="$ENVS,AUDREY_LLM_PROVIDER=anthropic"
  if [ -n "$ANTHROPIC_API_KEY" ]; then
    ENVS="$ENVS,ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY"
  fi
fi

# Build the env flags
ENV_FLAGS=""
IFS=',' read -ra PAIRS <<< "$ENVS"
for pair in "${PAIRS[@]}"; do
  ENV_FLAGS="$ENV_FLAGS --env $pair"
done

echo "Registering Audrey MCP server..."
echo "  Server: $SERVER_PATH"
echo "  Env: $ENVS"

claude mcp add --transport stdio --scope user $ENV_FLAGS audrey-memory -- node "$SERVER_PATH"

echo "Done. Run 'claude mcp list' to verify."
```

**Step 2: Test with MCP Inspector**

Run: `cd A:/ai/claude/audrey && npx @modelcontextprotocol/inspector node mcp-server/index.js`
This opens a browser UI. Verify all 5 tools appear with correct schemas.

**Step 3: Run full test suite one final time**

Run: `cd A:/ai/claude/audrey && npm test`
Expected: All tests PASS

**Step 4: Commit**

```bash
cd A:/ai/claude/audrey
git add mcp-server/register.sh
git commit -m "feat: add MCP server registration helper script"
```

---

## Summary of File Changes

| Task | File | Action |
|------|------|--------|
| 1 | `package.json` | Modify — add SDK + zod deps |
| 2 | `mcp-server/index.js` | Create — server entry point |
| 3 | `mcp-server/index.js` | Modify — memory_encode tool |
| 3 | `tests/mcp-server.test.js` | Create — encode tests |
| 4 | `mcp-server/index.js` | Modify — memory_recall tool |
| 4 | `tests/mcp-server.test.js` | Modify — recall tests |
| 5 | `mcp-server/index.js` | Modify — memory_consolidate tool |
| 5 | `tests/mcp-server.test.js` | Modify — consolidate tests |
| 6 | `mcp-server/index.js` | Modify — memory_introspect tool |
| 6 | `tests/mcp-server.test.js` | Modify — introspect tests |
| 7 | `mcp-server/index.js` | Modify — memory_resolve_truth tool |
| 7 | `tests/mcp-server.test.js` | Modify — resolve_truth tests |
| 8 | `mcp-server/register.sh` | Create — registration helper |
