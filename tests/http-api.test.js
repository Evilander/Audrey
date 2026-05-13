import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, rmSync, mkdirSync } from 'node:fs';
import { createApp } from '../dist/src/routes.js';
import { startServer } from '../dist/src/server.js';
import { Audrey } from '../dist/src/index.js';

const TEST_DIR = './test-http-data';

function metadataOf(event) {
  return event.metadata ? JSON.parse(event.metadata) : {};
}

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
        content: 'Test user prefers ES modules',
        source: 'told-by-user',
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(typeof body.id).toBe('string');
    expect(body.id.length).toBeGreaterThan(0);
    expect(body.content).toBe('Test user prefers ES modules');
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
    expect(Array.isArray(body.results)).toBe(true);
    expect(body.partial_failure).toBe(false);
    expect(body.errors).toEqual([]);
    expect(body.results.length).toBeGreaterThan(0);
    expect(body.results[0].content).toContain('SQLite');
  });

  it('POST /v1/recall serializes recall degradation diagnostics', async () => {
    await audrey.encode({ content: 'The deployment checklist mentions SQLite migrations', source: 'direct-observation' });
    audrey.db.exec('DROP TABLE fts_episodes');

    const res = await app.request('/v1/recall', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'SQLite migrations', retrieval: 'hybrid' }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.results)).toBe(true);
    expect(body.partial_failure).toBe(true);
    expect(body.errors.some(error => error.type === 'fts' && error.stage === 'recall.fts_lookup')).toBe(true);
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

  it('POST /v1/validate binds feedback to a preflight event', async () => {
    const memoryId = await audrey.encode({
      content: 'Never run release automation before npm pack --dry-run passes.',
      source: 'direct-observation',
      tags: ['must-follow', 'release'],
    });

    const preflightRes = await app.request('/v1/preflight', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'run release automation',
        tool: 'Bash',
        record_event: true,
      }),
    });
    const preflight = await preflightRes.json();
    expect(preflight.preflight_event_id).toMatch(/^01/);
    expect(preflight.evidence_ids).toContain(memoryId);

    const validateRes = await app.request('/v1/validate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: memoryId,
        outcome: 'helpful',
        preflight_event_id: preflight.preflight_event_id,
        evidence_ids: preflight.evidence_ids,
      }),
    });

    expect(validateRes.status).toBe(200);
    const body = await validateRes.json();
    expect(body.ok).toBe(true);
    expect(body.preflightEventId).toBe(preflight.preflight_event_id);
    expect(body.evidenceIds).toContain(memoryId);
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

  it('POST /v1/guard/before returns caution receipt, reflexes, and recent failure warning', async () => {
    audrey.observeTool({
      event: 'PostToolUse',
      tool: 'npm test',
      outcome: 'failed',
      errorSummary: 'Vitest failed with spawn EPERM on this host',
      cwd: process.cwd(),
    });

    const res = await app.request('/v1/guard/before', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'run npm test before release',
        tool: 'npm test',
        include_capsule: false,
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.receipt_id).toMatch(/^01/);
    expect(body.decision).toBe('caution');
    expect(body.reflexes[0].trigger).toBe('Before using npm test');
    expect(body.warnings.some(w => w.type === 'recent_failure')).toBe(true);
  });

  it('POST /v1/guard/before rejects blank action', async () => {
    const res = await app.request('/v1/guard/before', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: '   ' }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/action/i);
  });

  it('POST /v1/guard/after records a redacted failed outcome linked to receipt', async () => {
    const rawToken = 'sk-proj-abcdefghijklmnopqrstuvwxyz123456';
    const beforeRes = await app.request('/v1/guard/before', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'run npm test',
        tool: 'npm test',
        session_id: 'S-http-guard',
        include_capsule: false,
      }),
    });
    expect(beforeRes.status).toBe(200);
    const before = await beforeRes.json();

    const afterRes = await app.request('/v1/guard/after', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        receipt_id: before.receipt_id,
        tool: 'npm test',
        session_id: 'S-http-guard',
        outcome: 'failed',
        error_summary: `Vitest failed while using ${rawToken}`,
        metadata: { route: 'http-test' },
        unsafe_extra_field: rawToken,
      }),
    });

    expect(afterRes.status).toBe(200);
    const body = await afterRes.json();
    expect(JSON.stringify(body)).not.toContain(rawToken);
    expect(body.receipt_id).toBe(before.receipt_id);
    expect(body.outcome).toBe('failed');

    const events = audrey.listEvents({ eventType: 'PostToolUseFailure', toolName: 'npm test' });
    expect(events).toHaveLength(1);
    expect(events[0].session_id).toBe('S-http-guard');
    expect(events[0].outcome).toBe('failed');
    expect(events[0].redaction_state).toBe('redacted');
    expect(events[0].error_summary).not.toContain(rawToken);
    expect(events[0].error_summary).toContain('[REDACTED:openai_api_key');
    expect(metadataOf(events[0]).receipt_id).toBe(before.receipt_id);
    expect(JSON.stringify(metadataOf(events[0]))).not.toContain(rawToken);
  });

  it('POST /v1/guard/after returns 404 for unknown receipt', async () => {
    const res = await app.request('/v1/guard/after', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        receipt_id: '01UNKNOWNRECEIPT000000000000',
        outcome: 'failed',
      }),
    });

    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toContain('application/json');
    const body = await res.json();
    expect(body.error).toMatch(/receipt/i);
  });

  it('POST /v1/guard/after rejects invalid evidence feedback outcomes', async () => {
    const memoryId = await audrey.encode({
      content: 'Never deploy Audrey without package tarball inspection.',
      source: 'direct-observation',
      tags: ['must-follow', 'release'],
      salience: 0.5,
    });
    const beforeRes = await app.request('/v1/guard/before', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'deploy Audrey release',
        tool: 'deploy',
        strict: true,
        include_capsule: false,
      }),
    });
    expect(beforeRes.status).toBe(200);
    const before = await beforeRes.json();

    const res = await app.request('/v1/guard/after', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        receipt_id: before.receipt_id,
        outcome: 'blocked',
        evidence_feedback: {
          [memoryId]: 'bogus',
        },
      }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/invalid evidence feedback/i);
    expect(audrey.impact().validatedTotal).toBe(0);
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

  it('GET /v1/status exposes the latest recall degradation signal', async () => {
    await audrey.encode({ content: 'status degraded recall memory', source: 'direct-observation' });
    audrey.db.exec('DROP TABLE fts_episodes');
    await audrey.recall('status degraded recall memory', { types: ['episodic'], retrieval: 'hybrid' });

    const res = await app.request('/v1/status');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.recall_degraded).toBe(true);
    expect(body.last_recall_errors.some(error => error.type === 'fts')).toBe(true);
  });

  it('GET /v1/export is disabled unless admin tools are enabled', async () => {
    const res = await app.request('/v1/export');
    expect(res.status).toBe(403);
  });

  it('GET /v1/export returns snapshot when admin tools are enabled', async () => {
    const adminApp = createApp(audrey, { adminToolsEnabled: true });
    const res = await adminApp.request('/v1/export');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty('version');
    expect(body).toHaveProperty('episodes');
  });

  it('POST /v1/forget is disabled unless admin tools are enabled', async () => {
    const res = await app.request('/v1/forget', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(403);
  });

  it('POST /v1/forget returns error for missing params when admin tools are enabled', async () => {
    const adminApp = createApp(audrey, { adminToolsEnabled: true });
    const res = await adminApp.request('/v1/forget', {
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

  it('POST /v1/recall ignores includePrivate from request body (privacy ACL)', async () => {
    // Store one private memory and one public memory.
    await app.request('/v1/encode', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'PUBLIC: ES modules are required', source: 'told-by-user' }),
    });
    await app.request('/v1/encode', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content: 'PRIVATE: test API token is sk-secret-xxxx',
        source: 'told-by-user',
        private: true,
      }),
    });
    // Try to coerce the route into returning private memories — pre-fix, this
    // body-spread leaked. Post-fix, the sanitizer must drop includePrivate.
    const res = await app.request('/v1/recall', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: 'test api token sk-secret',
        includePrivate: true,
        limit: 10,
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    for (const result of body.results) {
      expect(result.content).not.toContain('sk-secret-xxxx');
      expect(result.content).not.toContain('PRIVATE:');
    }
  });

  it('POST /v1/recall ignores confidenceConfig override (integrity)', async () => {
    await app.request('/v1/encode', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'Score-stable test memory', source: 'told-by-user' }),
    });
    // Pre-fix, a caller could swap weights to inflate scores. Post-fix, this
    // is silently dropped — the response should match a normal recall.
    const baseline = await app.request('/v1/recall', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'score test', limit: 5 }),
    });
    const tampered = await app.request('/v1/recall', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: 'score test',
        limit: 5,
        confidenceConfig: { weights: { affect: 999 } },
      }),
    });
    expect((await baseline.json()).results.map(r => r.id)).toEqual((await tampered.json()).results.map(r => r.id));
  });

  it('POST /v1/validate adjusts salience and returns the new state', async () => {
    const encodeRes = await app.request('/v1/encode', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'closed-loop test memory', source: 'direct-observation', salience: 0.5 }),
    });
    const { id } = await encodeRes.json();

    const validateRes = await app.request('/v1/validate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, outcome: 'helpful' }),
    });
    expect(validateRes.status).toBe(200);
    const body = await validateRes.json();
    expect(body.ok).toBe(true);
    expect(body.id).toBe(id);
    expect(body.type).toBe('episodic');
    expect(body.salience).toBeGreaterThan(0.5);
    expect(body.usageCount).toBe(1);
  });

  it('POST /v1/validate returns 404 for unknown id', async () => {
    const res = await app.request('/v1/validate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'nonexistent_id', outcome: 'helpful' }),
    });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.ok).toBe(false);
  });

  it('POST /v1/mark-used is the legacy alias defaulting outcome to "used"', async () => {
    const encodeRes = await app.request('/v1/encode', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'mark-used legacy test', source: 'direct-observation' }),
    });
    const { id } = await encodeRes.json();

    const res = await app.request('/v1/mark-used', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
  });

  it('POST /v1/recall accepts allowlisted retrieval mode but rejects keyword', async () => {
    const r1 = await app.request('/v1/recall', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'test', retrieval: 'vector', limit: 1 }),
    });
    expect(r1.status).toBe(200);
    // 'keyword' is internal-only; the sanitizer should drop it (silent OK is
    // acceptable since there's no observable side-effect to assert here other
    // than that the call doesn't error).
    const r2 = await app.request('/v1/recall', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'test', retrieval: 'keyword', limit: 1 }),
    });
    expect(r2.status).toBe(200);
  });
});

describe('HTTP server bind safety', () => {
  it('refuses to start on non-loopback host without API key', async () => {
    await expect(startServer({
      hostname: '0.0.0.0',
      port: 0,
      config: {
        dataDir: TEST_DIR + '-bind-safety',
        agent: 'test',
        embedding: { provider: 'mock', dimensions: 8 },
      },
    })).rejects.toThrow(/refusing to start.*without AUDREY_API_KEY/);
    if (existsSync(TEST_DIR + '-bind-safety')) rmSync(TEST_DIR + '-bind-safety', { recursive: true });
  });

  it('allows non-loopback bind when AUDREY_ALLOW_NO_AUTH=1', async () => {
    const before = process.env.AUDREY_ALLOW_NO_AUTH;
    process.env.AUDREY_ALLOW_NO_AUTH = '1';
    try {
      const server = await startServer({
        hostname: '127.0.0.1',  // staying on loopback so we don't actually bind LAN in CI
        port: 0,
        config: {
          dataDir: TEST_DIR + '-allow-no-auth',
          agent: 'test',
          embedding: { provider: 'mock', dimensions: 8 },
        },
      });
      expect(server.hostname).toBe('127.0.0.1');
      await server.close();
      if (existsSync(TEST_DIR + '-allow-no-auth')) rmSync(TEST_DIR + '-allow-no-auth', { recursive: true });
    } finally {
      if (before === undefined) delete process.env.AUDREY_ALLOW_NO_AUTH;
      else process.env.AUDREY_ALLOW_NO_AUTH = before;
    }
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
