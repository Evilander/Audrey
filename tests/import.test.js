import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Audrey } from '../dist/src/index.js';
import { existsSync, rmSync } from 'node:fs';

const EXPORT_DIR = './test-import-export';
const IMPORT_DIR = './test-import-dest';

describe('import', () => {
  let source, dest;

  beforeEach(async () => {
    if (existsSync(EXPORT_DIR)) rmSync(EXPORT_DIR, { recursive: true });
    if (existsSync(IMPORT_DIR)) rmSync(IMPORT_DIR, { recursive: true });
    source = new Audrey({
      dataDir: EXPORT_DIR,
      embedding: { provider: 'mock', dimensions: 8 },
    });
    await source.encode({ content: 'Export test one', source: 'told-by-user', tags: ['test'] });
    await source.encode({ content: 'Export test two', source: 'direct-observation' });
  });

  afterEach(() => {
    source?.close();
    dest?.close();
    if (existsSync(EXPORT_DIR)) rmSync(EXPORT_DIR, { recursive: true });
    if (existsSync(IMPORT_DIR)) rmSync(IMPORT_DIR, { recursive: true });
  });

  it('round-trips episodes through export/import', async () => {
    const snapshot = source.export();
    dest = new Audrey({
      dataDir: IMPORT_DIR,
      embedding: { provider: 'mock', dimensions: 8 },
    });
    await dest.import(snapshot);
    const stats = dest.introspect();
    expect(stats.episodic).toBe(2);
  });

  it('round-trips explicit usefulness history for every memory table', async () => {
    const usedAt = '2026-07-22T18:30:00.000Z';
    source.db
      .prepare(
        "UPDATE episodes SET usage_count = 3, last_used_at = ? WHERE content = 'Export test one'",
      )
      .run(usedAt);
    source.db
      .prepare(
        `INSERT INTO semantics
           (id, content, state, created_at, usage_count, last_used_at)
         VALUES ('semantic-usefulness', 'Remember explicit semantic feedback', 'active', ?, 4, ?)`,
      )
      .run(usedAt, usedAt);
    source.db
      .prepare(
        `INSERT INTO procedures
           (id, content, state, created_at, usage_count, last_used_at)
         VALUES ('procedure-usefulness', 'Apply explicit procedure feedback', 'active', ?, 5, ?)`,
      )
      .run(usedAt, usedAt);

    const snapshot = source.export();
    expect(snapshot.episodes.find(row => row.content === 'Export test one')).toMatchObject({
      usage_count: 3,
      last_used_at: usedAt,
    });
    expect(snapshot.semantics[0]).toMatchObject({ usage_count: 4, last_used_at: usedAt });
    expect(snapshot.procedures[0]).toMatchObject({ usage_count: 5, last_used_at: usedAt });

    dest = new Audrey({
      dataDir: IMPORT_DIR,
      embedding: { provider: 'mock', dimensions: 8 },
    });
    await dest.import(snapshot);

    expect(
      dest.db
        .prepare(
          `SELECT usage_count, last_used_at FROM episodes
           WHERE content = 'Export test one'`,
        )
        .get(),
    ).toEqual({ usage_count: 3, last_used_at: usedAt });
    expect(
      dest.db
        .prepare(
          `SELECT usage_count, last_used_at FROM semantics
           WHERE id = 'semantic-usefulness'`,
        )
        .get(),
    ).toEqual({ usage_count: 4, last_used_at: usedAt });
    expect(
      dest.db
        .prepare(
          `SELECT usage_count, last_used_at FROM procedures
           WHERE id = 'procedure-usefulness'`,
        )
        .get(),
    ).toEqual({ usage_count: 5, last_used_at: usedAt });

    const legacySnapshot = structuredClone(snapshot);
    for (const row of [
      ...legacySnapshot.episodes,
      ...legacySnapshot.semantics,
      ...legacySnapshot.procedures,
    ]) {
      delete row.usage_count;
      delete row.last_used_at;
    }
    dest.close();
    dest = undefined;
    rmSync(IMPORT_DIR, { recursive: true });
    dest = new Audrey({
      dataDir: IMPORT_DIR,
      embedding: { provider: 'mock', dimensions: 8 },
    });
    await dest.import(legacySnapshot);
    for (const table of ['episodes', 'semantics', 'procedures']) {
      expect(
        dest.db.prepare(`SELECT usage_count, last_used_at FROM ${table} LIMIT 1`).get(),
      ).toEqual({ usage_count: 0, last_used_at: null });
    }
  });

  it('backfills imported historical Guard action keys from event metadata', async () => {
    const actionKey = 'd'.repeat(64);
    source.observeTool({
      event: 'PostToolUseFailure',
      tool: 'Bash',
      outcome: 'failed',
      metadata: { audrey_guard_action_key: actionKey },
    });
    const snapshot = source.export();
    for (const event of snapshot.memoryEvents) delete event.action_key;

    dest = new Audrey({
      dataDir: IMPORT_DIR,
      embedding: { provider: 'mock', dimensions: 8 },
    });
    await dest.import(snapshot);

    const imported = dest.db
      .prepare("SELECT action_key FROM memory_events WHERE tool_name = 'Bash'")
      .get();
    expect(imported.action_key).toBe(actionKey);
  });

  it('prefers explicit indexed event fields over mismatched metadata during import', async () => {
    source.observeTool({
      event: 'PostToolUseFailure',
      tool: 'Bash',
      outcome: 'failed',
      metadata: {
        audrey_guard_action_key: 'b'.repeat(64),
        autopilot_host: 'claude-code',
        autopilot_tool_use_id: 'metadata-tool-use',
        receipt_id: 'metadata-receipt',
      },
    });
    const snapshot = source.export();
    const event = snapshot.memoryEvents.find(row => row.tool_name === 'Bash');
    event.action_key = 'a'.repeat(64);
    event.hook_host = 'codex';
    event.hook_tool_use_id = 'explicit-tool-use';
    event.receipt_id = 'explicit-receipt';

    dest = new Audrey({
      dataDir: IMPORT_DIR,
      embedding: { provider: 'mock', dimensions: 8 },
    });
    await dest.import(snapshot);

    expect(
      dest.db
        .prepare(
          `SELECT action_key, hook_host, hook_tool_use_id, receipt_id
           FROM memory_events WHERE tool_name = 'Bash'`,
        )
        .get(),
    ).toEqual({
      action_key: 'a'.repeat(64),
      hook_host: 'codex',
      hook_tool_use_id: 'explicit-tool-use',
      receipt_id: 'explicit-receipt',
    });
  });

  it('rejects malformed explicit action keys during import', async () => {
    source.observeTool({
      event: 'Observation',
      tool: 'Bash',
      outcome: 'unknown',
    });
    const snapshot = source.export();
    snapshot.memoryEvents.find(row => row.tool_name === 'Bash').action_key = 'A'.repeat(64);
    dest = new Audrey({
      dataDir: IMPORT_DIR,
      embedding: { provider: 'mock', dimensions: 8 },
    });

    await expect(dest.import(snapshot)).rejects.toThrow(/action_key/i);
  });

  it.each(['1', '999999'])(
    'preserves the destination schema marker when snapshot config claims version %s',
    async snapshotVersion => {
      const snapshot = source.export();
      snapshot.config.schema_version = snapshotVersion;
      dest = new Audrey({
        dataDir: IMPORT_DIR,
        embedding: { provider: 'mock', dimensions: 8 },
      });
      const expectedSchemaVersion = dest.db
        .prepare("SELECT value FROM audrey_config WHERE key = 'schema_version'")
        .get().value;

      await dest.import(snapshot);

      expect(
        dest.db.prepare("SELECT value FROM audrey_config WHERE key = 'schema_version'").get().value,
      ).toBe(expectedSchemaVersion);
      const columns = dest.db.pragma('table_info(memory_events)').map(column => column.name);
      expect(columns).toEqual(
        expect.arrayContaining(['action_key', 'hook_host', 'hook_tool_use_id', 'receipt_id']),
      );
    },
  );

  it('preserves episode metadata', async () => {
    const snapshot = source.export();
    dest = new Audrey({
      dataDir: IMPORT_DIR,
      embedding: { provider: 'mock', dimensions: 8 },
    });
    await dest.import(snapshot);
    const ep = dest.db.prepare("SELECT * FROM episodes WHERE content = 'Export test one'").get();
    expect(ep.source).toBe('told-by-user');
    expect(JSON.parse(ep.tags)).toEqual(['test']);
  });

  it('preserves episode agent identity', async () => {
    if (existsSync('./test-import-agent-src'))
      rmSync('./test-import-agent-src', { recursive: true, force: true });
    if (existsSync('./test-import-agent-dest'))
      rmSync('./test-import-agent-dest', { recursive: true, force: true });
    const agentSource = new Audrey({
      dataDir: './test-import-agent-src',
      agent: 'agent-alpha',
      embedding: { provider: 'mock', dimensions: 8 },
    });
    await agentSource.encode({ content: 'Agent-owned memory', source: 'direct-observation' });

    const snapshot = agentSource.export();
    const agentDest = new Audrey({
      dataDir: './test-import-agent-dest',
      embedding: { provider: 'mock', dimensions: 8 },
    });
    await agentDest.import(snapshot);

    const ep = agentDest.db
      .prepare("SELECT id, agent FROM episodes WHERE content = 'Agent-owned memory'")
      .get();
    expect(ep.agent).toBe('agent-alpha');
    const vecEp = agentDest.db.prepare('SELECT agent FROM vec_episodes WHERE id = ?').get(ep.id);
    expect(vecEp.agent).toBe('agent-alpha');

    agentSource.close();
    agentDest.close();
    rmSync('./test-import-agent-src', { recursive: true, force: true });
    rmSync('./test-import-agent-dest', { recursive: true, force: true });
  });

  it('preserves consolidated memory agent identity', async () => {
    if (existsSync('./test-import-consolidated-agent-src'))
      rmSync('./test-import-consolidated-agent-src', { recursive: true, force: true });
    if (existsSync('./test-import-consolidated-agent-dest'))
      rmSync('./test-import-consolidated-agent-dest', { recursive: true, force: true });
    const agentSource = new Audrey({
      dataDir: './test-import-consolidated-agent-src',
      agent: 'agent-alpha',
      embedding: { provider: 'mock', dimensions: 8 },
    });
    await agentSource.encode({
      content: 'Consolidated agent marker',
      source: 'direct-observation',
    });
    await agentSource.encode({ content: 'Consolidated agent marker', source: 'tool-result' });
    await agentSource.encode({ content: 'Consolidated agent marker', source: 'told-by-user' });
    await agentSource.consolidate({
      minClusterSize: 3,
      similarityThreshold: 0.99,
      extractPrinciple: () => ({ content: 'Agent-owned consolidated semantic', type: 'semantic' }),
    });

    const snapshot = agentSource.export();
    const agentDest = new Audrey({
      dataDir: './test-import-consolidated-agent-dest',
      embedding: { provider: 'mock', dimensions: 8 },
    });
    await agentDest.import(snapshot);

    const sem = agentDest.db
      .prepare(
        "SELECT id, agent FROM semantics WHERE content = 'Agent-owned consolidated semantic'",
      )
      .get();
    expect(sem.agent).toBe('agent-alpha');
    const vecSem = agentDest.db.prepare('SELECT agent FROM vec_semantics WHERE id = ?').get(sem.id);
    expect(vecSem.agent).toBe('agent-alpha');

    agentSource.close();
    agentDest.close();
    rmSync('./test-import-consolidated-agent-src', { recursive: true, force: true });
    rmSync('./test-import-consolidated-agent-dest', { recursive: true, force: true });
  });

  it('re-embeds content with current provider', async () => {
    const snapshot = source.export();
    dest = new Audrey({
      dataDir: IMPORT_DIR,
      embedding: { provider: 'mock', dimensions: 8 },
    });
    await dest.import(snapshot);
    const vecCount = dest.db.prepare('SELECT COUNT(*) as c FROM vec_episodes').get().c;
    expect(vecCount).toBe(2);
  });

  it('imports into empty database only', async () => {
    const snapshot = source.export();
    await expect(source.import(snapshot)).rejects.toThrow('not empty');
  });

  it('rejects imported episode content above the production limit', async () => {
    const snapshot = source.export();
    const unsafeSnapshot = JSON.parse(JSON.stringify(snapshot));
    unsafeSnapshot.episodes[0].content = 'x'.repeat(50001);
    dest = new Audrey({
      dataDir: IMPORT_DIR,
      embedding: { provider: 'mock', dimensions: 8 },
    });

    await expect(dest.import(unsafeSnapshot)).rejects.toThrow(/content|maximum|too big/i);
  });

  it('rejects malformed private flags during import', async () => {
    const snapshot = source.export();
    const unsafeSnapshot = JSON.parse(JSON.stringify(snapshot));
    unsafeSnapshot.episodes[0].private = 2;
    dest = new Audrey({
      dataDir: IMPORT_DIR,
      embedding: { provider: 'mock', dimensions: 8 },
    });

    await expect(dest.import(unsafeSnapshot)).rejects.toThrow(/private|invalid/i);
  });

  it('round-trips context and affect through export/import', async () => {
    const ctxSource = new Audrey({
      dataDir: './test-import-ctx-src',
      embedding: { provider: 'mock', dimensions: 8 },
    });
    await ctxSource.encode({
      content: 'Frustrating auth bug',
      source: 'direct-observation',
      context: { task: 'debugging', domain: 'auth' },
      affect: { valence: -0.5, arousal: 0.8, label: 'frustration' },
    });

    const snapshot = ctxSource.export();
    const ctxDest = new Audrey({
      dataDir: './test-import-ctx-dest',
      embedding: { provider: 'mock', dimensions: 8 },
    });
    await ctxDest.import(snapshot);

    const ep = ctxDest.db
      .prepare("SELECT context, affect FROM episodes WHERE content = 'Frustrating auth bug'")
      .get();
    expect(JSON.parse(ep.context)).toEqual({ task: 'debugging', domain: 'auth' });
    expect(JSON.parse(ep.affect)).toEqual({ valence: -0.5, arousal: 0.8, label: 'frustration' });

    ctxSource.close();
    ctxDest.close();
    rmSync('./test-import-ctx-src', { recursive: true });
    rmSync('./test-import-ctx-dest', { recursive: true });
  });

  it('round-trips interference_count and salience on semantics', async () => {
    await source.encode({ content: 'Export test one', source: 'tool-result' });
    await source.consolidate({ minClusterSize: 2, similarityThreshold: 0.5 });

    const snapshot = source.export();
    const sem = snapshot.semantics?.[0];
    if (sem) {
      expect(sem).toHaveProperty('interference_count');
      expect(sem).toHaveProperty('salience');
    }

    dest = new Audrey({
      dataDir: IMPORT_DIR,
      embedding: { provider: 'mock', dimensions: 8 },
    });
    await dest.import(snapshot);
    const stats = dest.introspect();
    expect(stats.semantic).toBeGreaterThanOrEqual(1);

    const importedSem = dest.db
      .prepare('SELECT interference_count, salience FROM semantics LIMIT 1')
      .get();
    if (importedSem) {
      expect(importedSem.interference_count).toBeDefined();
      expect(importedSem.salience).toBeDefined();
    }
  });

  it('imports semantic memories', async () => {
    await source.encode({ content: 'Export test one', source: 'tool-result' });
    await source.consolidate({ minClusterSize: 2, similarityThreshold: 0.5 });

    const snapshot = source.export();
    dest = new Audrey({
      dataDir: IMPORT_DIR,
      embedding: { provider: 'mock', dimensions: 8 },
    });
    await dest.import(snapshot);
    const stats = dest.introspect();
    expect(stats.semantic).toBeGreaterThanOrEqual(1);
  });
});
