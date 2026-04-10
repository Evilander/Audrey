# v0.19 HTTP API Server Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `npx audrey serve` — an HTTP API wrapping all 13 Audrey memory tools, enabling multi-language access.

**Architecture:** Thin Hono HTTP server that instantiates the same `Audrey` class used by the MCP server. Each endpoint maps 1:1 to an MCP tool. Zod schemas from mcp-server/index.ts are reused for request validation. OpenAPI spec auto-generated from Zod via `@hono/zod-openapi`. The HTTP server runs alongside (not replacing) the existing MCP server.

**Tech Stack:** Hono (HTTP framework), @hono/zod-openapi (OpenAPI generation), @hono/node-server (Node.js adapter)

---

### Task 1: Install dependencies and create server skeleton

**Files:**
- Modify: `package.json` (add hono deps)
- Create: `src/server.ts` (HTTP server module)
- Create: `src/routes.ts` (route definitions)

- [ ] **Step 1: Install Hono and OpenAPI plugin**

```bash
npm install hono @hono/node-server @hono/zod-openapi
```

- [ ] **Step 2: Create src/server.ts — the server entrypoint**

```typescript
// src/server.ts
import { serve } from '@hono/node-server';
import { createApp } from './routes.js';
import { Audrey } from './audrey.js';
import type { AudreyConfig } from './types.js';

export interface ServerOptions {
  port?: number;
  hostname?: string;
  config: AudreyConfig;
  apiKey?: string;
}

export async function startServer(options: ServerOptions): Promise<{ port: number; close: () => void }> {
  const { port = 7437, hostname = '0.0.0.0', config, apiKey } = options;
  const audrey = new Audrey(config);

  // Initialize embedding provider if it has a ready() method
  if (audrey.embeddingProvider && typeof audrey.embeddingProvider.ready === 'function') {
    await audrey.embeddingProvider.ready();
  }

  const app = createApp(audrey, { apiKey });

  const server = serve({ fetch: app.fetch, port, hostname }, (info) => {
    console.error(`[audrey-http] listening on ${hostname}:${info.port}`);
  });

  return {
    port,
    close: () => {
      server.close();
      audrey.close();
    },
  };
}
```

- [ ] **Step 3: Create src/routes.ts — all route definitions**

```typescript
// src/routes.ts
import { Hono } from 'hono';
import { Audrey } from './audrey.js';

interface AppOptions {
  apiKey?: string;
}

export function createApp(audrey: Audrey, options: AppOptions = {}): Hono {
  const app = new Hono();

  // API key middleware (optional)
  if (options.apiKey) {
    app.use('/v1/*', async (c, next) => {
      const auth = c.req.header('Authorization');
      if (!auth || auth !== `Bearer ${options.apiKey}`) {
        return c.json({ error: 'Unauthorized' }, 401);
      }
      await next();
    });
  }

  // Health check (no auth required)
  app.get('/health', (c) => {
    try {
      const status = audrey.memoryStatus();
      return c.json({ status: 'ok', healthy: status.healthy });
    } catch {
      return c.json({ status: 'error' }, 500);
    }
  });

  // Placeholder — routes added in Task 2
  return app;
}
```

- [ ] **Step 4: Build and verify compilation**

```bash
npm run build
npx tsc --noEmit
```

- [ ] **Step 5: Commit**

```bash
git add src/server.ts src/routes.ts package.json package-lock.json
git commit -m "feat: add HTTP server skeleton with Hono"
```

---

### Task 2: Implement all 13 API endpoints

**Files:**
- Modify: `src/routes.ts` (add all endpoints)

Implement every endpoint, mapping 1:1 to MCP tools. Reuse the same validation logic from mcp-server/index.ts but with Hono's request handling.

- [ ] **Step 1: Add all endpoints to src/routes.ts**

Each endpoint follows this pattern:
```typescript
app.post('/v1/encode', async (c) => {
  try {
    const body = await c.req.json();
    // validate and call audrey method
    const id = await audrey.encode(body);
    return c.json({ id, content: body.content, source: body.source });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: message }, 400);
  }
});
```

Full endpoint list:

```
POST   /v1/encode       → audrey.encode({ content, source, tags, salience, context, affect, private })
POST   /v1/recall       → audrey.recall(query, { limit, types, minConfidence, tags, sources, after, before, context, mood })
POST   /v1/consolidate  → audrey.consolidate({ minClusterSize, similarityThreshold })
POST   /v1/dream        → audrey.dream({ minClusterSize, similarityThreshold, dormantThreshold })
GET    /v1/introspect   → audrey.introspect()
POST   /v1/resolve-truth → audrey.resolveTruth(contradiction_id)
GET    /v1/export       → audrey.export()
POST   /v1/import       → audrey.import(snapshot)
POST   /v1/forget       → audrey.forget(id, { purge }) or audrey.forgetByQuery(query, { minSimilarity, purge })
POST   /v1/decay        → audrey.decay({ dormantThreshold })
GET    /v1/status       → audrey.memoryStatus()
POST   /v1/reflect      → audrey.reflect(turns)
POST   /v1/greeting     → audrey.greeting({ context })
```

For POST endpoints, parse JSON body with `await c.req.json()`.
For GET endpoints, no body needed.

Validation: use basic checks (typeof content === 'string', etc.) — keep it simple. The Audrey class methods already validate their inputs and throw descriptive errors.

Error handling: wrap each handler in try/catch, return `{ error: message }` with appropriate HTTP status.

- [ ] **Step 2: Build and verify**

```bash
npm run build
```

- [ ] **Step 3: Commit**

```bash
git add src/routes.ts
git commit -m "feat: implement all 13 HTTP API endpoints"
```

---

### Task 3: Add `serve` CLI subcommand

**Files:**
- Modify: `mcp-server/index.ts` (add serve subcommand)
- Modify: `mcp-server/config.ts` (add serve config helper)

- [ ] **Step 1: Add serve function to mcp-server/index.ts**

Add a new `serve()` async function alongside the existing CLI subcommands (install, uninstall, status, greeting, reflect, dream, reembed):

```typescript
async function serveHttp() {
  const { startServer } = await import('../src/server.js');
  const config = buildAudreyConfig();
  const port = parseInt(process.env.AUDREY_PORT || '7437', 10);
  const apiKey = process.env.AUDREY_API_KEY;

  const server = await startServer({ port, config, apiKey });
  console.error(`[audrey-http] v${VERSION} serving on port ${server.port}`);
  if (apiKey) {
    console.error('[audrey-http] API key authentication enabled');
  }
}
```

Add to the CLI dispatch block:
```typescript
} else if (subcommand === 'serve') {
  serveHttp().catch(err => {
    console.error('[audrey] serve failed:', err);
    process.exit(1);
  });
}
```

- [ ] **Step 2: Build and test manually**

```bash
npm run build
# In one terminal:
npx audrey serve
# In another terminal:
curl http://localhost:7437/health
curl -X POST http://localhost:7437/v1/encode -H 'Content-Type: application/json' -d '{"content":"test memory","source":"direct-observation"}'
curl -X POST http://localhost:7437/v1/recall -H 'Content-Type: application/json' -d '{"query":"test"}'
curl http://localhost:7437/v1/status
```

- [ ] **Step 3: Commit**

```bash
git add mcp-server/index.ts mcp-server/config.ts
git commit -m "feat: add 'npx audrey serve' CLI subcommand"
```

---

### Task 4: Write HTTP API tests

**Files:**
- Create: `tests/http-api.test.js`

- [ ] **Step 1: Create tests/http-api.test.js**

Test the HTTP API by creating a Hono app directly (no need to start a real server — Hono supports in-process testing via `app.request()`).

```javascript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, rmSync, mkdirSync } from 'node:fs';
import { createApp } from '../dist/src/routes.js';
import { Audrey } from '../dist/src/index.js';

const TEST_DIR = './test-http-data';

describe('HTTP API', () => {
  let audrey, app;

  beforeEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
    audrey = new Audrey({
      dataDir: TEST_DIR,
      agent: 'test',
      embedding: { provider: 'mock', dimensions: 8 },
    });
    app = createApp(audrey);
  });

  afterEach(() => {
    audrey.close();
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  it('GET /health returns ok', async () => {
    const res = await app.request('/health');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('ok');
  });

  it('POST /v1/encode stores a memory', async () => {
    const res = await app.request('/v1/encode', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'test memory', source: 'direct-observation' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBeDefined();
    expect(body.content).toBe('test memory');
  });

  it('POST /v1/recall returns results', async () => {
    // Encode first
    await app.request('/v1/encode', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'stripe rate limit 429', source: 'direct-observation' }),
    });

    const res = await app.request('/v1/recall', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'stripe rate limit' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBeGreaterThan(0);
  });

  it('POST /v1/dream runs full cycle', async () => {
    const res = await app.request('/v1/dream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.consolidation).toBeDefined();
    expect(body.decay).toBeDefined();
    expect(body.stats).toBeDefined();
  });

  it('GET /v1/introspect returns stats', async () => {
    const res = await app.request('/v1/introspect');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(typeof body.episodic).toBe('number');
    expect(typeof body.semantic).toBe('number');
  });

  it('GET /v1/status returns health', async () => {
    const res = await app.request('/v1/status');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(typeof body.healthy).toBe('boolean');
  });

  it('GET /v1/export returns snapshot', async () => {
    const res = await app.request('/v1/export');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.version).toBeDefined();
    expect(Array.isArray(body.episodes)).toBe(true);
  });

  it('POST /v1/forget returns error for missing params', async () => {
    const res = await app.request('/v1/forget', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it('POST /v1/decay applies decay', async () => {
    const res = await app.request('/v1/decay', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(typeof body.totalEvaluated).toBe('number');
  });

  it('POST /v1/greeting returns briefing', async () => {
    const res = await app.request('/v1/greeting', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.mood).toBeDefined();
  });

  describe('API key auth', () => {
    let securedApp;

    beforeEach(() => {
      securedApp = createApp(audrey, { apiKey: 'test-secret-key' });
    });

    it('rejects requests without API key', async () => {
      const res = await securedApp.request('/v1/status');
      expect(res.status).toBe(401);
    });

    it('accepts requests with correct API key', async () => {
      const res = await securedApp.request('/v1/status', {
        headers: { 'Authorization': 'Bearer test-secret-key' },
      });
      expect(res.status).toBe(200);
    });

    it('health endpoint does not require auth', async () => {
      const res = await securedApp.request('/health');
      expect(res.status).toBe(200);
    });
  });
});
```

- [ ] **Step 2: Build and run tests**

```bash
npm run build && npm test
```

All tests must pass including the new HTTP API tests.

- [ ] **Step 3: Commit**

```bash
git add tests/http-api.test.js
git commit -m "test: add HTTP API endpoint tests"
```

---

### Task 5: Export server from index.ts and update package.json

**Files:**
- Modify: `src/index.ts` (add server exports)
- Modify: `package.json` (add server export path)

- [ ] **Step 1: Add server exports to src/index.ts**

Add to the bottom of src/index.ts:
```typescript
export { startServer } from './server.js';
export { createApp } from './routes.js';
```

- [ ] **Step 2: Add a dedicated export for the server in package.json**

Add to the exports field:
```json
"./server": {
  "types": "./dist/src/server.d.ts",
  "default": "./dist/src/server.js"
}
```

- [ ] **Step 3: Build, test, pack check**

```bash
npm run build && npm test && npm run bench:memory:check && npm run pack:check
```

- [ ] **Step 4: Commit**

```bash
git add src/index.ts package.json
git commit -m "feat: export HTTP server from package entry points"
```

---

### Task 6: Version bump to 0.19.0

**Files:**
- Modify: `package.json`
- Modify: `mcp-server/config.ts`

- [ ] **Step 1: Bump version**

```bash
npm version 0.19.0 --no-git-tag-version
```

Update VERSION in mcp-server/config.ts to '0.19.0'.

- [ ] **Step 2: Update mcp-server test if it checks version**

If tests/mcp-server.test.js has a hardcoded version assertion, update it.

- [ ] **Step 3: Full validation**

```bash
npm run build && npm run typecheck && npm test && npm run bench:memory:check && npm run pack:check
```

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json mcp-server/config.ts tests/mcp-server.test.js
git commit -m "release: v0.19.0 — HTTP API server"
```

---

## Post-Implementation Checklist

- [ ] `npx audrey serve` starts HTTP server on port 7437
- [ ] All 13 endpoints return correct results
- [ ] `GET /health` works without auth
- [ ] API key auth works when AUDREY_API_KEY is set
- [ ] All existing tests still pass (MCP, unit, benchmark)
- [ ] New HTTP API tests pass
- [ ] `npm run pack:check` includes dist/ with server files
