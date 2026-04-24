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

  it('GET /health returns { status: "ok" }', async () => {
    const res = await app.request('/health');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('ok');
    expect(body.healthy).toBe(true);
  });

  it('POST /v1/encode stores a memory and returns id', async () => {
    const res = await app.request('/v1/encode', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content: 'Tyler prefers ES modules',
        source: 'told-by-user',
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(typeof body.id).toBe('string');
    expect(body.id.length).toBeGreaterThan(0);
    expect(body.content).toBe('Tyler prefers ES modules');
    expect(body.source).toBe('told-by-user');
  });

  it('POST /v1/recall returns results after encoding', async () => {
    // Encode a memory first
    await app.request('/v1/encode', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content: 'The database uses SQLite with sqlite-vec',
        source: 'direct-observation',
      }),
    });

    const res = await app.request('/v1/recall', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'database' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBeGreaterThan(0);
    expect(body[0].content).toContain('SQLite');
  });

  it('POST /v1/capsule returns a structured memory packet', async () => {
    await app.request('/v1/encode', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content: 'Before editing Audrey host docs, keep Codex and Ollama as first-class targets',
        source: 'direct-observation',
        tags: ['procedure', 'codex', 'ollama'],
      }),
    });

    const res = await app.request('/v1/capsule', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'Audrey Codex Ollama host docs', budget_chars: 2000 }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.query).toBe('Audrey Codex Ollama host docs');
    expect(body.sections).toHaveProperty('procedures');
    expect(Array.isArray(body.evidence_ids)).toBe(true);
  });

  it('POST /v1/preflight checks memory before an action', async () => {
    audrey.observeTool({
      event: 'PostToolUse',
      tool: 'npm test',
      outcome: 'failed',
      errorSummary: 'Vitest failed with spawn EPERM on this Windows host',
      cwd: process.cwd(),
    });

    const res = await app.request('/v1/preflight', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'run npm test before release',
        tool: 'npm test',
        record_event: true,
        include_capsule: false,
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.action).toBe('run npm test before release');
    expect(body.decision).toBe('caution');
    expect(body.warnings.some(w => w.type === 'recent_failure')).toBe(true);
    expect(body.preflight_event_id).toMatch(/^01/);
    expect(body.capsule).toBeUndefined();
  });

  it('POST /v1/reflexes returns trigger-response memory reflexes', async () => {
    audrey.observeTool({
      event: 'PostToolUse',
      tool: 'npm test',
      outcome: 'failed',
      errorSummary: 'Vitest failed with spawn EPERM on this Windows host',
      cwd: process.cwd(),
    });

    const res = await app.request('/v1/reflexes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'run npm test before release',
        tool: 'npm test',
        include_preflight: true,
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.decision).toBe('caution');
    expect(body.reflexes[0].trigger).toBe('Before using npm test');
    expect(body.reflexes[0].response_type).toBe('warn');
    expect(body.preflight.decision).toBe('caution');
  });

  it('POST /v1/dream runs full cycle', async () => {
    const res = await app.request('/v1/dream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty('consolidation');
    expect(body).toHaveProperty('decay');
    expect(body).toHaveProperty('stats');
  });

  it('GET /v1/introspect returns stats', async () => {
    const res = await app.request('/v1/introspect');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(typeof body.episodic).toBe('number');
    expect(typeof body.semantic).toBe('number');
    expect(typeof body.procedural).toBe('number');
  });

  it('GET /v1/status returns health info', async () => {
    const res = await app.request('/v1/status');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(typeof body.healthy).toBe('boolean');
  });

  it('GET /v1/export returns snapshot', async () => {
    const res = await app.request('/v1/export');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty('version');
    expect(body).toHaveProperty('episodes');
  });

  it('POST /v1/forget returns error for missing params', async () => {
    const res = await app.request('/v1/forget', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/exactly one/i);
  });

  it('POST /v1/decay applies decay', async () => {
    const res = await app.request('/v1/decay', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty('totalEvaluated');
    expect(body).toHaveProperty('transitionedToDormant');
  });

  it('POST /v1/greeting returns briefing', async () => {
    const res = await app.request('/v1/greeting', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty('recent');
    expect(body).toHaveProperty('principles');
  });
});

describe('HTTP API auth', () => {
  let audrey, app;
  const API_KEY = 'test-secret-key-12345';

  beforeEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
    audrey = new Audrey({
      dataDir: TEST_DIR,
      agent: 'test',
      embedding: { provider: 'mock', dimensions: 8 },
    });
    app = createApp(audrey, { apiKey: API_KEY });
  });

  afterEach(() => {
    audrey.close();
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  it('rejects /v1/* requests without API key', async () => {
    const res = await app.request('/v1/introspect');
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe('Unauthorized');
  });

  it('accepts /v1/* requests with correct API key', async () => {
    const res = await app.request('/v1/introspect', {
      headers: { Authorization: `Bearer ${API_KEY}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(typeof body.episodic).toBe('number');
  });

  it('/health skips auth even when API key is configured', async () => {
    const res = await app.request('/health');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('ok');
  });
});
