import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { encodeEpisode } from '../dist/src/encode.js';
import { createDatabase, closeDatabase } from '../dist/src/db.js';
import { MockEmbeddingProvider } from '../dist/src/embedding.js';
import { Audrey } from '../dist/src/index.js';
import { existsSync, rmSync, mkdirSync } from 'node:fs';

const TEST_DIR = './test-redaction-firewall-data';

describe('encodeEpisode redaction firewall', () => {
  let db, embedding;

  beforeEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
    ({ db } = createDatabase(TEST_DIR, { dimensions: 8 }));
    embedding = new MockEmbeddingProvider({ dimensions: 8 });
  });

  afterEach(() => {
    closeDatabase(db);
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  it('redacts a secret in content before it reaches the episodes row', async () => {
    const secret = 'sk-ant-abcdefghij1234567890';
    const id = await encodeEpisode(db, embedding, {
      content: `remember my key: ${secret}`,
      source: 'told-by-user',
    });
    const row = db.prepare('SELECT content FROM episodes WHERE id = ?').get(id);
    // Pre-fix, encodeEpisode never called redact() at all, so this would
    // still contain the raw secret.
    expect(row.content).not.toContain(secret);
    expect(row.content).toContain('[REDACTED:anthropic_api_key');
  });

  it('redacts secrets embedded in context values', async () => {
    const secret = 'AKIAIOSFODNN7EXAMPLE';
    const id = await encodeEpisode(db, embedding, {
      content: 'deployed the service',
      source: 'direct-observation',
      context: { credentials: `access_key: ${secret}` },
    });
    const row = db.prepare('SELECT context FROM episodes WHERE id = ?').get(id);
    const context = JSON.parse(row.context);
    expect(context.credentials).not.toContain(secret);
    expect(context.credentials).toContain('[REDACTED:aws_access_key');
  });

  it('redacts a secret in the affect label', async () => {
    const secret = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';
    const id = await encodeEpisode(db, embedding, {
      content: 'shipped the fix',
      source: 'direct-observation',
      affect: { valence: 0.5, arousal: 0.4, label: `relief about ${secret}` },
    });
    const row = db.prepare('SELECT affect FROM episodes WHERE id = ?').get(id);
    const affect = JSON.parse(row.affect);
    expect(affect.label).not.toContain(secret);
    expect(affect.label).toContain('[REDACTED:github_token');
  });

  it('does not leave the secret searchable in the FTS index', async () => {
    const secret = 'sk-ant-abcdefghij1234567890';
    const id = await encodeEpisode(db, embedding, {
      content: `remember my key: ${secret}`,
      source: 'told-by-user',
    });
    const row = db.prepare('SELECT content FROM fts_episodes WHERE id = ?').get(id);
    expect(row.content).not.toContain(secret);
  });

  it('leaves ordinary prose byte-identical', async () => {
    const content = 'Stripe API returned 429 after the third retry this morning.';
    const id = await encodeEpisode(db, embedding, { content, source: 'direct-observation' });
    const row = db.prepare('SELECT content FROM episodes WHERE id = ?').get(id);
    expect(row.content).toBe(content);
  });

  it('invokes onRedaction with a clean summary for ordinary prose', async () => {
    let summary;
    await encodeEpisode(
      db,
      embedding,
      { content: 'a normal sentence about payments processing', source: 'direct-observation' },
      {
        onRedaction: s => {
          summary = s;
        },
      },
    );
    expect(summary).toEqual({ redacted: false, classes: [], count: 0 });
  });

  it('invokes onRedaction with a merged, deduped summary across content and context', async () => {
    let summary;
    await encodeEpisode(
      db,
      embedding,
      {
        content:
          'first leak ghp_abcdefghij1234567890abcdefghij and second leak ghp_zyxwvutsrq9876543210zyxwvutsrq',
        source: 'direct-observation',
        context: { note: 'access_key: AKIAIOSFODNN7EXAMPLE' },
      },
      {
        onRedaction: s => {
          summary = s;
        },
      },
    );
    expect(summary.redacted).toBe(true);
    expect([...summary.classes].sort()).toEqual(['aws_access_key', 'github_token']);
    expect(summary.count).toBe(3);
  });

  it('still returns the episode id and preserves the existing return type', async () => {
    const id = await encodeEpisode(db, embedding, {
      content: 'plain content',
      source: 'direct-observation',
    });
    expect(typeof id).toBe('string');
    expect(id.length).toBeGreaterThan(0);
  });

  it('hands the sanitized fields to onSanitized, matching what was stored', async () => {
    const secret = 'sk-ant-abcdefghij1234567890';
    let sanitized;
    const id = await encodeEpisode(
      db,
      embedding,
      {
        content: `remember my key: ${secret}`,
        source: 'told-by-user',
        context: { note: `token ${secret}` },
      },
      {
        onSanitized: s => {
          sanitized = s;
        },
      },
    );
    expect(sanitized).toBeDefined();
    expect(sanitized.content).not.toContain(secret);
    expect(sanitized.content).toContain('[REDACTED:');
    expect(JSON.stringify(sanitized.context)).not.toContain(secret);
    const row = db.prepare('SELECT content FROM episodes WHERE id = ?').get(id);
    expect(sanitized.content).toBe(row.content);
  });
});

describe('post-encode pipeline never sees raw secrets', () => {
  const PIPE_DIR = './test-redaction-pipeline-data';
  let audrey;

  beforeEach(() => {
    if (existsSync(PIPE_DIR)) rmSync(PIPE_DIR, { recursive: true });
    audrey = new Audrey({
      dataDir: PIPE_DIR,
      agent: 'firewall-pipeline-test',
      embedding: { provider: 'mock', dimensions: 8 },
    });
  });

  afterEach(() => {
    audrey.close();
    if (existsSync(PIPE_DIR)) rmSync(PIPE_DIR, { recursive: true });
  });

  it('enqueues sanitized params for grounding/validation, not the raw request', async () => {
    // The storage row was already redacted; the leak was the background
    // pipeline (grounding, validation, the contradiction LLM prompt)
    // receiving the caller's raw params object. This pins the seam: whatever
    // _enqueuePostEncode gets is what every downstream stage sees.
    const secret = 'sk-ant-abcdefghij1234567890';
    const captured = [];
    const original = audrey._enqueuePostEncode.bind(audrey);
    audrey._enqueuePostEncode = (id, params, embeddingBuffer) => {
      captured.push(params);
      return original(id, params, embeddingBuffer);
    };

    await audrey.encode({
      content: `remember my key: ${secret}`,
      source: 'told-by-user',
      context: { note: `token ${secret}` },
    });
    await audrey.drainPostEncodeQueue();

    expect(captured).toHaveLength(1);
    const serialized = JSON.stringify(captured[0]);
    expect(serialized).not.toContain(secret);
    expect(captured[0].content).toContain('[REDACTED:');
  });

  it('encodeBatch enqueues sanitized params too', async () => {
    const secret = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';
    const captured = [];
    const original = audrey._enqueuePostEncode.bind(audrey);
    audrey._enqueuePostEncode = (id, params, embeddingBuffer) => {
      captured.push(params);
      return original(id, params, embeddingBuffer);
    };

    await audrey.encodeBatch([
      { content: `first with ${secret}`, source: 'tool-result' },
      { content: 'second plain entry', source: 'tool-result' },
    ]);
    await audrey.drainPostEncodeQueue();

    expect(captured).toHaveLength(2);
    expect(JSON.stringify(captured)).not.toContain(secret);
  });
});
