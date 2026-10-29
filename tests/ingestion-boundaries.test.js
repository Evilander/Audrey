import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Audrey } from '../dist/src/audrey.js';
import { createApp } from '../dist/src/routes.js';

describe('memory ingestion and REST boundaries', () => {
  let directory, memory, app;
  const encode = (content, options = {}) =>
    memory.encode({
      content,
      source: 'told-by-user',
      waitForConsolidation: true,
      ...options,
    });
  const post = (path, body, agent) =>
    app.request(path, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(agent ? { 'X-Audrey-Agent': agent } : {}),
      },
      body: JSON.stringify(body),
    });

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'audrey-ingestion-'));
    memory = new Audrey({
      dataDir: join(directory, 'store'),
      agent: 'server',
      embedding: { provider: 'mock', dimensions: 8 },
      interference: { enabled: false },
    });
    app = createApp(memory, { adminToolsEnabled: true });
  });
  afterEach(async () => {
    await memory.closeAsync();
    rmSync(directory, { recursive: true, force: true });
  });

  it('rejects foreign or missing supersession targets without a partial insert', async () => {
    const original = await encode('Original owner fact', { agent: 'alpha' });
    for (const target of [original, 'missing-episode']) {
      await expect(
        encode('Replacement owner fact', { agent: 'beta', supersedes: target }),
      ).rejects.toThrow(/owned by the acting agent/);
    }
    expect(memory.db.prepare('SELECT id, superseded_by FROM episodes').all()).toEqual([
      { id: original, superseded_by: null },
    ]);
    expect(memory.db.prepare('SELECT count(*) n FROM vec_episodes').get().n).toBe(1);
  });

  it('stores REST causal/supersedes fields and removes the retired vector', async () => {
    const original = await encode('Use npm for scripts', { agent: 'client' });
    const response = await post(
      '/v1/encode',
      {
        content: 'Use pnpm for scripts',
        source: 'told-by-user',
        supersedes: original,
        causal: { trigger: 'workspace upgrade', consequence: 'pnpm required' },
      },
      'client',
    );
    expect(response.status).toBe(200);
    const { id } = await response.json();
    await memory.waitForIdle();
    expect(
      memory.db
        .prepare(
          'SELECT agent, supersedes, causal_trigger, causal_consequence FROM episodes WHERE id=?',
        )
        .get(id),
    ).toEqual({
      agent: 'client',
      supersedes: original,
      causal_trigger: 'workspace upgrade',
      causal_consequence: 'pnpm required',
    });
    expect(
      memory.db.prepare('SELECT superseded_by FROM episodes WHERE id=?').get(original)
        .superseded_by,
    ).toBe(id);
    expect(
      memory.db.prepare('SELECT id FROM vec_episodes WHERE id=?').get(original),
    ).toBeUndefined();
    expect(memory.memoryStatus().reembed_recommended).toBe(false);
  });

  it('uses the requested agent when forgetting by query', async () => {
    const content = 'The release checklist is stored in the project handbook';
    const server = await encode(content);
    const client = await encode(content, { agent: 'client' });
    const response = await post(
      '/v1/forget',
      { query: content, minSimilarity: 0.99, purge: true },
      'client',
    );
    expect(response.status).toBe(200);
    expect(memory.db.prepare('SELECT id FROM episodes WHERE id=?').get(server)).toBeDefined();
    expect(memory.db.prepare('SELECT id FROM episodes WHERE id=?').get(client)).toBeUndefined();
  });

  it('redacts context by sensitive key and sends only stored values to batch listeners', async () => {
    const secret = 'sk-ant-abcdefghij1234567890';
    const seen = [];
    memory.on('encode', event => seen.push(event));
    const [id] = await memory.encodeBatch([
      {
        content: `Keep token ${secret} private`,
        source: 'told-by-user',
        context: { api_key: 'short-synthetic-key', project: 'billing' },
        tags: [secret],
        causal: { trigger: secret, consequence: secret },
        waitForConsolidation: true,
      },
    ]);
    const row = memory.db
      .prepare(
        'SELECT content, context, tags, causal_trigger, causal_consequence FROM episodes WHERE id=?',
      )
      .get(id);
    expect(JSON.parse(row.context)).toEqual({
      api_key: '[REDACTED:password_assignment]',
      project: 'billing',
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      content: row.content,
      context: JSON.parse(row.context),
      tags: JSON.parse(row.tags),
      causal: { trigger: row.causal_trigger, consequence: row.causal_consequence },
    });
    expect(JSON.stringify(seen)).not.toContain(secret);
    expect(JSON.stringify(seen)).not.toContain('short-synthetic-key');
  });

  it.each([0, false, 1, null])('rejects context value %j before storage', async value => {
    const response = await post('/v1/encode', {
      content: 'Context must preserve its values',
      source: 'told-by-user',
      context: { retry_count: value },
    });
    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatch(/only string values/);
    expect(memory.db.prepare('SELECT count(*) n FROM episodes').get().n).toBe(0);
  });

  it.each([1.5, 0, -1])('rejects recall limit %j at the REST boundary', async limit => {
    const response = await post('/v1/recall', { query: 'deployment', limit });
    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatch(/positive integer/);
  });

  it.each(['incorrect', null, 3])(
    'rejects invalid feedback %j without reinforcement',
    async outcome => {
      const id = await encode('Do not reward invalid feedback');
      const before = memory.db
        .prepare('SELECT salience, usage_count FROM episodes WHERE id=?')
        .get(id);
      const response = await post('/v1/validate', { id, outcome });
      expect(response.status).toBe(400);
      expect(
        memory.db.prepare('SELECT salience, usage_count FROM episodes WHERE id=?').get(id),
      ).toEqual(before);
    },
  );

  it.each(['/v1/consolidate', '/v1/dream', '/v1/decay'])(
    'rejects malformed JSON at %s before maintenance',
    async route => {
      const response = await app.request(route, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{',
      });
      expect(response.status).toBe(400);
      expect(memory.consolidationHistory()).toEqual([]);
    },
  );

  it('still permits an absent maintenance options body', async () => {
    const response = await app.request('/v1/consolidate', { method: 'POST' });
    expect(response.status).toBe(200);
    expect(memory.consolidationHistory()).toHaveLength(1);
  });

  it('compares the complete API key, including suffixes beyond 1024 bytes', async () => {
    const key = 'x'.repeat(1100) + 'correct-suffix';
    const secured = createApp(memory, { apiKey: key });
    for (const [candidate, status] of [
      [key, 200],
      [key.slice(0, 1017), 401],
      ['x'.repeat(1100) + 'wrong-suffix', 401],
    ]) {
      const response = await secured.request('/v1/status', {
        headers: { Authorization: `Bearer ${candidate}` },
      });
      expect(response.status).toBe(status);
    }
  });

  it('assigns reflected memories to the requested agent', async () => {
    memory.llmProvider = {
      complete: async () => ({
        content: JSON.stringify({
          memories: [{ content: 'Use TypeScript', source: 'told-by-user' }],
        }),
      }),
    };
    const response = await post(
      '/v1/reflect',
      { turns: [{ role: 'user', content: 'I prefer TypeScript' }] },
      'client',
    );
    expect(response.status).toBe(200);
    expect((await response.json()).encoded).toBe(1);
    await memory.waitForIdle();
    expect(memory.db.prepare('SELECT agent FROM episodes').all()).toEqual([{ agent: 'client' }]);
  });

  it('excludes another project failure from REST capsules', async () => {
    const projectA = join(directory, 'project-a'),
      projectB = join(directory, 'project-b');
    mkdirSync(projectA);
    mkdirSync(projectB);
    mkdirSync(join(projectA, '.git'));
    mkdirSync(join(projectB, '.git'));
    memory.observeTool({
      event: 'PostToolUseFailure',
      tool: 'Deploy',
      outcome: 'failed',
      errorSummary: 'Project A deployment failed',
      cwd: projectA,
    });
    const unscoped = await post('/v1/capsule', { query: 'deployment' });
    expect((await unscoped.json()).sections.risks).toHaveLength(1);
    const response = await post('/v1/capsule', { query: 'deployment', cwd: projectB });
    expect(response.status).toBe(200);
    expect((await response.json()).sections.risks).toEqual([]);
  });

  it('excludes forgotten memories from greeting sections and mood', async () => {
    const retired = await encode('An obsolete unresolved personal note', {
      private: true,
      tags: ['unresolved'],
      salience: 1,
      affect: { valence: -1, arousal: 1 },
    });
    const recent = await encode('A retired public update');
    memory.forget(retired);
    memory.forget(recent);
    const greeting = await memory.greeting();
    expect(greeting.recent).toEqual([]);
    expect(greeting.identity).toEqual([]);
    expect(greeting.unresolved).toEqual([]);
    expect(greeting.mood).toEqual({ valence: 0, arousal: 0, samples: 0 });
  });

  it('restores vectors when a resolved contradiction becomes context dependent', async () => {
    const a = await encode('Deploy billing to east');
    const b = await encode('Deploy billing to west');
    memory.db
      .prepare(
        "INSERT INTO contradictions(id,claim_a_id,claim_a_type,claim_b_id,claim_b_type,state,created_at) VALUES('context-transition',?,'episodic',?,'episodic','open',?)",
      )
      .run(a, b, new Date().toISOString());
    memory.llmProvider = {
      json: async () => ({ resolution: 'a_wins', explanation: 'East is current' }),
    };
    await memory.resolveTruth('context-transition');
    expect(memory.db.prepare('SELECT count(*) n FROM vec_episodes').get().n).toBe(1);
    memory.llmProvider = {
      json: async () => ({
        resolution: 'context_dependent',
        explanation: 'Both are valid by environment',
        conditions: { a: 'production', b: 'staging' },
      }),
    };
    await memory.resolveTruth('context-transition');
    expect(memory.db.prepare('SELECT count(*) n FROM vec_episodes').get().n).toBe(2);
    expect(memory.memoryStatus().healthy).toBe(true);
    expect(memory.memoryStatus().reembed_recommended).toBe(false);
  });
});
