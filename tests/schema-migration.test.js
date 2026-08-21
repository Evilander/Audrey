import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createDatabase, closeDatabase } from '../dist/src/db.js';
import { existsSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';

const TEST_DIR = './test-schema-migration';

describe('v0.7.0 schema columns', () => {
  let db;

  beforeEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
    ({ db } = createDatabase(TEST_DIR));
  });

  afterEach(() => {
    closeDatabase(db);
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  it('semantics has interference_count column defaulting to 0', () => {
    db.prepare(`INSERT INTO semantics (id, content, created_at) VALUES (?, ?, ?)`).run(
      'sem-1',
      'test',
      new Date().toISOString(),
    );
    const row = db.prepare('SELECT interference_count FROM semantics WHERE id = ?').get('sem-1');
    expect(row.interference_count).toBe(0);
  });

  it('semantics has salience column defaulting to 0.5', () => {
    db.prepare(`INSERT INTO semantics (id, content, created_at) VALUES (?, ?, ?)`).run(
      'sem-1',
      'test',
      new Date().toISOString(),
    );
    const row = db.prepare('SELECT salience FROM semantics WHERE id = ?').get('sem-1');
    expect(row.salience).toBe(0.5);
  });

  it('procedures has interference_count column defaulting to 0', () => {
    db.prepare(`INSERT INTO procedures (id, content, created_at) VALUES (?, ?, ?)`).run(
      'proc-1',
      'test',
      new Date().toISOString(),
    );
    const row = db.prepare('SELECT interference_count FROM procedures WHERE id = ?').get('proc-1');
    expect(row.interference_count).toBe(0);
  });

  it('procedures has salience column defaulting to 0.5', () => {
    db.prepare(`INSERT INTO procedures (id, content, created_at) VALUES (?, ?, ?)`).run(
      'proc-1',
      'test',
      new Date().toISOString(),
    );
    const row = db.prepare('SELECT salience FROM procedures WHERE id = ?').get('proc-1');
    expect(row.salience).toBe(0.5);
  });
});

// Pre-v0.7 schema: episodes without context/affect, semantics/procedures without interference_count/salience
const LEGACY_SCHEMA = `
  CREATE TABLE episodes (
    id TEXT PRIMARY KEY,
    content TEXT NOT NULL,
    embedding BLOB,
    source TEXT NOT NULL CHECK(source IN ('direct-observation','told-by-user','tool-result','inference','model-generated')),
    source_reliability REAL NOT NULL,
    salience REAL DEFAULT 0.5,
    tags TEXT,
    causal_trigger TEXT,
    causal_consequence TEXT,
    created_at TEXT NOT NULL,
    embedding_model TEXT,
    embedding_version TEXT,
    supersedes TEXT,
    superseded_by TEXT,
    consolidated INTEGER DEFAULT 0,
    FOREIGN KEY (supersedes) REFERENCES episodes(id)
  );

  CREATE TABLE semantics (
    id TEXT PRIMARY KEY,
    content TEXT NOT NULL,
    embedding BLOB,
    state TEXT DEFAULT 'active' CHECK(state IN ('active','disputed','superseded','context_dependent','dormant','rolled_back')),
    conditions TEXT,
    evidence_episode_ids TEXT,
    evidence_count INTEGER DEFAULT 0,
    supporting_count INTEGER DEFAULT 0,
    contradicting_count INTEGER DEFAULT 0,
    source_type_diversity INTEGER DEFAULT 0,
    consolidation_checkpoint TEXT,
    embedding_model TEXT,
    embedding_version TEXT,
    consolidation_model TEXT,
    consolidation_prompt_hash TEXT,
    created_at TEXT NOT NULL,
    last_reinforced_at TEXT,
    retrieval_count INTEGER DEFAULT 0,
    challenge_count INTEGER DEFAULT 0
  );

  CREATE TABLE procedures (
    id TEXT PRIMARY KEY,
    content TEXT NOT NULL,
    embedding BLOB,
    state TEXT DEFAULT 'active' CHECK(state IN ('active','disputed','superseded','context_dependent','dormant','rolled_back')),
    trigger_conditions TEXT,
    evidence_episode_ids TEXT,
    success_count INTEGER DEFAULT 0,
    failure_count INTEGER DEFAULT 0,
    embedding_model TEXT,
    embedding_version TEXT,
    created_at TEXT NOT NULL,
    last_reinforced_at TEXT,
    retrieval_count INTEGER DEFAULT 0
  );

  CREATE TABLE causal_links (
    id TEXT PRIMARY KEY,
    cause_id TEXT NOT NULL,
    effect_id TEXT NOT NULL,
    link_type TEXT DEFAULT 'causal' CHECK(link_type IN ('causal','correlational','temporal')),
    mechanism TEXT,
    confidence REAL,
    evidence_count INTEGER DEFAULT 1,
    created_at TEXT NOT NULL
  );

  CREATE TABLE contradictions (
    id TEXT PRIMARY KEY,
    claim_a_id TEXT NOT NULL,
    claim_b_id TEXT NOT NULL,
    claim_a_type TEXT NOT NULL,
    claim_b_type TEXT NOT NULL,
    state TEXT DEFAULT 'open' CHECK(state IN ('open','resolved','context_dependent','reopened')),
    resolution TEXT,
    resolved_at TEXT,
    reopened_at TEXT,
    reopen_evidence_id TEXT,
    created_at TEXT NOT NULL
  );

  CREATE TABLE consolidation_runs (
    id TEXT PRIMARY KEY,
    checkpoint_cursor TEXT,
    input_episode_ids TEXT,
    output_memory_ids TEXT,
    confidence_deltas TEXT,
    consolidation_model TEXT,
    consolidation_prompt_hash TEXT,
    started_at TEXT,
    completed_at TEXT,
    status TEXT DEFAULT 'running' CHECK(status IN ('running','completed','failed','rolled_back'))
  );

  CREATE TABLE audrey_config (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE consolidation_metrics (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    min_cluster_size INTEGER NOT NULL,
    similarity_threshold REAL NOT NULL,
    episodes_evaluated INTEGER NOT NULL,
    clusters_found INTEGER NOT NULL,
    principles_extracted INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY (run_id) REFERENCES consolidation_runs(id)
  );

  CREATE INDEX idx_episodes_created ON episodes(created_at);
  CREATE INDEX idx_episodes_consolidated ON episodes(consolidated);
  CREATE INDEX idx_episodes_source ON episodes(source);
  CREATE INDEX idx_semantics_state ON semantics(state);
  CREATE INDEX idx_procedures_state ON procedures(state);
  CREATE INDEX idx_contradictions_state ON contradictions(state);
  CREATE INDEX idx_consolidation_status ON consolidation_runs(status);
`;

const LEGACY_DIR = './test-schema-legacy';

function createLegacyDb() {
  mkdirSync(LEGACY_DIR, { recursive: true });
  const dbPath = join(LEGACY_DIR, 'audrey.db');
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(LEGACY_SCHEMA);
  return db;
}

function getColumnNames(db, table) {
  return db.pragma(`table_info(${table})`).map(col => col.name);
}

describe('schema migration framework', () => {
  let db;

  afterEach(() => {
    if (db && db.open) db.close();
    if (existsSync(LEGACY_DIR)) rmSync(LEGACY_DIR, { recursive: true });
  });

  it('upgrades legacy database missing context and affect columns', () => {
    const legacyDb = createLegacyDb();
    legacyDb.close();

    ({ db } = createDatabase(LEGACY_DIR));

    const episodeCols = getColumnNames(db, 'episodes');
    expect(episodeCols).toContain('context');
    expect(episodeCols).toContain('affect');

    const semanticsCols = getColumnNames(db, 'semantics');
    expect(semanticsCols).toContain('interference_count');
    expect(semanticsCols).toContain('salience');

    const proceduresCols = getColumnNames(db, 'procedures');
    expect(proceduresCols).toContain('interference_count');
    expect(proceduresCols).toContain('salience');
  });

  it('sets schema_version to latest on fresh database', () => {
    mkdirSync(LEGACY_DIR, { recursive: true });
    ({ db } = createDatabase(LEGACY_DIR));

    const row = db.prepare("SELECT value FROM audrey_config WHERE key = 'schema_version'").get();
    expect(row).toBeDefined();
    expect(Number(row.value)).toBe(15);
  });

  it('is idempotent — running migrations twice causes no errors', () => {
    mkdirSync(LEGACY_DIR, { recursive: true });
    ({ db } = createDatabase(LEGACY_DIR));
    const firstVersion = db
      .prepare("SELECT value FROM audrey_config WHERE key = 'schema_version'")
      .get();
    closeDatabase(db);

    ({ db } = createDatabase(LEGACY_DIR));
    const secondVersion = db
      .prepare("SELECT value FROM audrey_config WHERE key = 'schema_version'")
      .get();

    expect(secondVersion.value).toBe(firstVersion.value);
  });

  it('preserves existing data during migration', () => {
    const legacyDb = createLegacyDb();
    const now = new Date().toISOString();
    legacyDb
      .prepare(
        `INSERT INTO episodes (id, content, source, source_reliability, created_at)
       VALUES (?, ?, ?, ?, ?)`,
      )
      .run('ep-legacy-1', 'I remember the old days', 'direct-observation', 1.0, now);
    legacyDb.close();

    ({ db } = createDatabase(LEGACY_DIR));

    const row = db.prepare('SELECT * FROM episodes WHERE id = ?').get('ep-legacy-1');
    expect(row).toBeDefined();
    expect(row.content).toBe('I remember the old days');
    expect(row.source).toBe('direct-observation');
    expect(row.context).toBe('{}');
    expect(row.affect).toBe('{}');
  });

  it('backfills indexed action keys from valid guard metadata', () => {
    mkdirSync(LEGACY_DIR, { recursive: true });
    ({ db } = createDatabase(LEGACY_DIR));
    db.prepare(
      `INSERT INTO memory_events (
        id, event_type, source, actor_agent, tool_name, outcome, metadata, created_at
      ) VALUES (?, 'PostToolUseFailure', 'tool-trace', 'codex', 'Bash', 'failed', ?, ?)`,
    ).run(
      'event-with-action-key',
      JSON.stringify({ audrey_guard_action_key: 'b'.repeat(64) }),
      '2026-04-20T10:00:00Z',
    );
    db.prepare(
      `INSERT INTO memory_events (
        id, event_type, source, actor_agent, tool_name, outcome, metadata, created_at
      ) VALUES (?, 'Observation', 'test', 'codex', 'Bash', 'unknown', ?, ?)`,
    ).run('event-with-invalid-metadata', '{not-json', '2026-04-20T11:00:00Z');
    db.prepare(`UPDATE audrey_config SET value = '11' WHERE key = 'schema_version'`).run();
    closeDatabase(db);

    ({ db } = createDatabase(LEGACY_DIR));

    expect(
      db.prepare('SELECT action_key FROM memory_events WHERE id = ?').get('event-with-action-key')
        .action_key,
    ).toBe('b'.repeat(64));
    expect(
      db
        .prepare('SELECT action_key FROM memory_events WHERE id = ?')
        .get('event-with-invalid-metadata').action_key,
    ).toBeNull();
    const indexes = db.prepare("PRAGMA index_list('memory_events')").all();
    expect(indexes.map(index => index.name)).toContain('idx_memory_events_action_key');
  });

  it('migrates a real v11 memory_events table with no indexed correlation columns', () => {
    mkdirSync(LEGACY_DIR, { recursive: true });
    const legacy = new Database(join(LEGACY_DIR, 'audrey.db'));
    legacy.exec(`
      CREATE TABLE audrey_config (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO audrey_config (key, value) VALUES ('schema_version', '11');
      CREATE TABLE memory_events (
        id TEXT PRIMARY KEY,
        session_id TEXT,
        event_type TEXT NOT NULL,
        source TEXT NOT NULL,
        actor_agent TEXT,
        tool_name TEXT,
        input_hash TEXT,
        output_hash TEXT,
        outcome TEXT,
        error_summary TEXT,
        cwd TEXT,
        file_fingerprints TEXT,
        redaction_state TEXT,
        metadata TEXT,
        created_at TEXT NOT NULL
      );
    `);
    legacy
      .prepare(
        `INSERT INTO memory_events
         (id, session_id, event_type, source, actor_agent, tool_name, outcome,
          redaction_state, metadata, created_at)
         VALUES (?, ?, 'PreToolUse', 'tool-trace', 'codex', 'Bash', 'unknown',
                 'unreviewed', ?, ?)`,
      )
      .run(
        'legacy-v11-event',
        'legacy-session',
        JSON.stringify({
          audrey_guard_action_key: 'a'.repeat(64),
          autopilot_host: 'codex',
          autopilot_tool_use_id: 'legacy-tool-use',
        }),
        '2026-07-01T00:00:00.000Z',
      );
    legacy.close();

    ({ db } = createDatabase(LEGACY_DIR));

    expect(
      db
        .prepare(
          `SELECT action_key, hook_host, hook_tool_use_id, receipt_id
           FROM memory_events WHERE id = 'legacy-v11-event'`,
        )
        .get(),
    ).toEqual({
      action_key: 'a'.repeat(64),
      hook_host: 'codex',
      hook_tool_use_id: 'legacy-tool-use',
      receipt_id: null,
    });
  });

  it('backfills v12 Autopilot correlation columns and uses their indexes', () => {
    mkdirSync(LEGACY_DIR, { recursive: true });
    const legacy = new Database(join(LEGACY_DIR, 'audrey.db'));
    legacy.exec(`
      CREATE TABLE audrey_config (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO audrey_config (key, value) VALUES ('schema_version', '12');
      CREATE TABLE memory_events (
        id TEXT PRIMARY KEY,
        session_id TEXT,
        event_type TEXT NOT NULL,
        source TEXT NOT NULL,
        actor_agent TEXT,
        tool_name TEXT,
        input_hash TEXT,
        output_hash TEXT,
        outcome TEXT,
        error_summary TEXT,
        cwd TEXT,
        file_fingerprints TEXT,
        redaction_state TEXT,
        action_key TEXT,
        metadata TEXT,
        created_at TEXT NOT NULL
      );
    `);
    const insert = legacy.prepare(
      `INSERT INTO memory_events
       (id, session_id, event_type, source, actor_agent, tool_name, outcome,
        redaction_state, action_key, metadata, created_at)
       VALUES (?, 'session-12', ?, 'tool-trace', 'codex', 'Bash', ?,
               'unreviewed', ?, ?, ?)`,
    );
    insert.run(
      'v12-before',
      'PreToolUse',
      'unknown',
      'b'.repeat(64),
      JSON.stringify({
        autopilot_host: 'codex',
        autopilot_tool_use_id: 'v12-tool-use',
      }),
      '2026-07-02T00:00:00.000Z',
    );
    insert.run(
      'v12-after',
      'PostToolUseFailure',
      'failed',
      'b'.repeat(64),
      JSON.stringify({
        autopilot_host: 'codex',
        autopilot_tool_use_id: 'v12-tool-use',
        receipt_id: 'v12-before',
      }),
      '2026-07-02T00:00:01.000Z',
    );
    legacy.close();

    ({ db } = createDatabase(LEGACY_DIR));

    expect(
      db
        .prepare(
          `SELECT hook_host, hook_tool_use_id, receipt_id
           FROM memory_events WHERE id = 'v12-after'`,
        )
        .get(),
    ).toEqual({
      hook_host: 'codex',
      hook_tool_use_id: 'v12-tool-use',
      receipt_id: 'v12-before',
    });
    const correlationPlan = db
      .prepare(
        `EXPLAIN QUERY PLAN
         SELECT id FROM memory_events
         WHERE actor_agent = ? AND hook_host = ? AND hook_tool_use_id = ?
           AND session_id = ? AND event_type = ?`,
      )
      .all('codex', 'codex', 'v12-tool-use', 'session-12', 'PreToolUse');
    expect(correlationPlan.some(row => row.detail.includes('idx_memory_events_hook_lookup'))).toBe(
      true,
    );
    const receiptPlan = db
      .prepare(
        `EXPLAIN QUERY PLAN
         SELECT id FROM memory_events WHERE receipt_id = ? AND actor_agent = ?`,
      )
      .all('v12-before', 'codex');
    expect(receiptPlan.some(row => row.detail.includes('idx_memory_events_receipt'))).toBe(true);
  });

  it('preserves explicit correlation fields while backfilling missing sibling columns', () => {
    mkdirSync(LEGACY_DIR, { recursive: true });
    const legacy = new Database(join(LEGACY_DIR, 'audrey.db'));
    legacy.exec(`
      CREATE TABLE audrey_config (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO audrey_config (key, value) VALUES ('schema_version', '12');
      CREATE TABLE memory_events (
        id TEXT PRIMARY KEY,
        session_id TEXT,
        event_type TEXT NOT NULL,
        source TEXT NOT NULL,
        actor_agent TEXT,
        tool_name TEXT,
        input_hash TEXT,
        output_hash TEXT,
        outcome TEXT,
        error_summary TEXT,
        cwd TEXT,
        file_fingerprints TEXT,
        redaction_state TEXT,
        action_key TEXT,
        hook_host TEXT,
        hook_tool_use_id TEXT,
        receipt_id TEXT,
        metadata TEXT,
        created_at TEXT NOT NULL
      );
      INSERT INTO memory_events (
        id, event_type, source, actor_agent, redaction_state, hook_host, metadata, created_at
      ) VALUES (
        'partial-v13', 'PreToolUse', 'tool-trace', 'codex', 'unreviewed', 'explicit-host',
        '{"autopilot_host":"metadata-host","autopilot_tool_use_id":"backfilled-tool","receipt_id":"backfilled-receipt"}',
        '2026-07-03T00:00:00.000Z'
      );
    `);
    legacy.close();

    ({ db } = createDatabase(LEGACY_DIR));

    expect(
      db
        .prepare(
          `SELECT hook_host, hook_tool_use_id, receipt_id
           FROM memory_events WHERE id = 'partial-v13'`,
        )
        .get(),
    ).toEqual({
      hook_host: 'explicit-host',
      hook_tool_use_id: 'backfilled-tool',
      receipt_id: 'backfilled-receipt',
    });
  });

  it('repairs a live-shaped v12 store with correlation columns but no action_key', () => {
    mkdirSync(LEGACY_DIR, { recursive: true });
    const legacy = new Database(join(LEGACY_DIR, 'audrey.db'));
    legacy.exec(`
      CREATE TABLE audrey_config (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO audrey_config (key, value) VALUES ('schema_version', '12');
      CREATE TABLE memory_events (
        id TEXT PRIMARY KEY,
        session_id TEXT,
        event_type TEXT NOT NULL,
        source TEXT NOT NULL,
        actor_agent TEXT,
        tool_name TEXT,
        input_hash TEXT,
        output_hash TEXT,
        outcome TEXT,
        error_summary TEXT,
        cwd TEXT,
        file_fingerprints TEXT,
        redaction_state TEXT,
        hook_host TEXT,
        hook_tool_use_id TEXT,
        receipt_id TEXT,
        metadata TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX idx_memory_events_session ON memory_events(session_id);
      CREATE INDEX idx_memory_events_tool ON memory_events(tool_name);
      CREATE INDEX idx_memory_events_created ON memory_events(created_at);
      CREATE INDEX idx_memory_events_outcome ON memory_events(outcome);
      INSERT INTO memory_events (
        id, session_id, event_type, source, actor_agent, tool_name, outcome,
        redaction_state, hook_host, hook_tool_use_id, receipt_id, metadata, created_at
      ) VALUES (
        'live-shaped-v12', 'live-session', 'PostToolUseFailure', 'tool-trace',
        'codex', 'Bash', 'failed', 'unreviewed', 'codex', 'live-tool-use',
        'live-receipt',
        '{"audrey_guard_action_key":"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"}',
        '2026-07-23T00:00:00.000Z'
      );
    `);
    legacy.close();

    ({ db } = createDatabase(LEGACY_DIR));

    expect(
      db
        .prepare(
          `SELECT action_key, hook_host, hook_tool_use_id, receipt_id
           FROM memory_events WHERE id = 'live-shaped-v12'`,
        )
        .get(),
    ).toEqual({
      action_key: 'c'.repeat(64),
      hook_host: 'codex',
      hook_tool_use_id: 'live-tool-use',
      receipt_id: 'live-receipt',
    });
    expect(
      db.prepare("SELECT value FROM audrey_config WHERE key = 'schema_version'").get().value,
    ).toBe('15');
    const indexes = db.prepare("PRAGMA index_list('memory_events')").all();
    expect(indexes.map(index => index.name)).toEqual(
      expect.arrayContaining([
        'idx_memory_events_action_key',
        'idx_memory_events_hook_lookup',
        'idx_memory_events_receipt',
      ]),
    );

    closeDatabase(db);
    ({ db } = createDatabase(LEGACY_DIR));
    expect(
      db.prepare("SELECT value FROM audrey_config WHERE key = 'schema_version'").get().value,
    ).toBe('15');
  });
});

const VEC_SYNC_DIR = './test-schema-vec-sync';

function readConfigValue(configDb, key) {
  const row = configDb.prepare('SELECT value FROM audrey_config WHERE key = ?').get(key);
  return row ? row.value : undefined;
}

function insertRawEpisode(rawDb, id, embedding, createdAt = new Date().toISOString()) {
  rawDb
    .prepare(
      `INSERT INTO episodes (id, content, embedding, source, source_reliability, created_at)
       VALUES (?, ?, ?, 'direct-observation', 1.0, ?)`,
    )
    .run(id, `episode ${id}`, embedding, createdAt);
}

function mockEmbedding(fillValue) {
  return Buffer.from(new Float32Array(new Array(8).fill(fillValue)).buffer);
}

describe('v14 vec0 sync high-water mark', () => {
  let db;

  afterEach(() => {
    if (db && db.open) db.close();
    if (existsSync(VEC_SYNC_DIR)) rmSync(VEC_SYNC_DIR, { recursive: true });
  });

  it('creates the tool_name/outcome/created_at/actor_agent index and the embedding-presence partial indexes on a fresh database', () => {
    mkdirSync(VEC_SYNC_DIR, { recursive: true });
    ({ db } = createDatabase(VEC_SYNC_DIR, { dimensions: 8 }));

    const eventIndexes = db.pragma("index_list('memory_events')").map(index => index.name);
    expect(eventIndexes).toContain('idx_memory_events_tool_outcome_created_actor');

    for (const table of ['episodes', 'semantics', 'procedures']) {
      const indexes = db.pragma(`index_list('${table}')`).map(index => index.name);
      expect(indexes).toContain(`idx_${table}_embedding_present`);
    }
  });

  it('persists a vec0 sync high-water mark so a steady reopen has nothing left to scan', () => {
    mkdirSync(VEC_SYNC_DIR, { recursive: true });
    ({ db } = createDatabase(VEC_SYNC_DIR, { dimensions: 8 }));
    insertRawEpisode(db, 'ep-1', mockEmbedding(0.1));
    closeDatabase(db);

    ({ db } = createDatabase(VEC_SYNC_DIR, { dimensions: 8 }));
    expect(db.prepare('SELECT id FROM vec_episodes WHERE id = ?').get('ep-1')).toBeDefined();
    const markAfterFirstSync = readConfigValue(db, 'vec_sync_id_episodes');
    expect(markAfterFirstSync).toBeDefined();
    closeDatabase(db);

    ({ db } = createDatabase(VEC_SYNC_DIR, { dimensions: 8 }));
    expect(readConfigValue(db, 'vec_sync_id_episodes')).toBe(markAfterFirstSync);
    expect(db.prepare('SELECT COUNT(*) AS c FROM vec_episodes').get().c).toBe(1);
  });

  it('reopen after another connection inserts new rows syncs only the delta', () => {
    mkdirSync(VEC_SYNC_DIR, { recursive: true });
    ({ db } = createDatabase(VEC_SYNC_DIR, { dimensions: 8 }));
    insertRawEpisode(db, 'ep-a', mockEmbedding(0.2));
    closeDatabase(db);

    ({ db } = createDatabase(VEC_SYNC_DIR, { dimensions: 8 }));
    const markAfterFirstSync = readConfigValue(db, 'vec_sync_id_episodes');
    closeDatabase(db);

    const otherConnection = new Database(join(VEC_SYNC_DIR, 'audrey.db'));
    insertRawEpisode(otherConnection, 'ep-b', mockEmbedding(0.2));
    otherConnection.close();

    ({ db } = createDatabase(VEC_SYNC_DIR, { dimensions: 8 }));
    expect(db.prepare('SELECT id FROM vec_episodes WHERE id = ?').get('ep-b')).toBeDefined();
    expect(db.prepare('SELECT COUNT(*) AS c FROM vec_episodes').get().c).toBe(2);
    // Marks are memory ids, compared as text: ids are ULIDs, so lexical
    // order is insertion order and a delete never recycles one.
    expect(readConfigValue(db, 'vec_sync_id_episodes') > markAfterFirstSync).toBe(true);
  });

  it('syncs a row whose rowid was recycled by an earlier delete', () => {
    // SQLite hands out max(rowid)+1, so deleting the row holding the current
    // maximum makes the next insert reuse that rowid. A rowid-keyed mark read
    // the reused row as already-synced and dropped it from vec0 permanently.
    mkdirSync(VEC_SYNC_DIR, { recursive: true });
    ({ db } = createDatabase(VEC_SYNC_DIR, { dimensions: 8 }));
    for (const id of ['ep-aaa', 'ep-bbb', 'ep-ccc']) insertRawEpisode(db, id, mockEmbedding(0.5));
    closeDatabase(db);

    ({ db } = createDatabase(VEC_SYNC_DIR, { dimensions: 8 }));
    expect(db.prepare('SELECT COUNT(*) AS c FROM vec_episodes').get().c).toBe(3);
    const recycled = db.prepare('SELECT MAX(rowid) AS r FROM episodes').get().r;
    db.prepare('DELETE FROM episodes WHERE rowid = ?').run(recycled);
    db.prepare('DELETE FROM vec_episodes WHERE id = ?').run('ep-ccc');
    insertRawEpisode(db, 'ep-ddd', mockEmbedding(0.5));
    expect(db.prepare("SELECT rowid FROM episodes WHERE id = 'ep-ddd'").get().rowid).toBe(recycled);
    closeDatabase(db);

    ({ db } = createDatabase(VEC_SYNC_DIR, { dimensions: 8 }));
    expect(db.prepare('SELECT id FROM vec_episodes WHERE id = ?').get('ep-ddd')).toBeDefined();
  });

  it('a dimension change clears the high-water marks so the new vector space resyncs from scratch', () => {
    mkdirSync(VEC_SYNC_DIR, { recursive: true });
    ({ db } = createDatabase(VEC_SYNC_DIR, { dimensions: 8 }));
    insertRawEpisode(db, 'ep-dim', mockEmbedding(0.3));
    closeDatabase(db);

    ({ db } = createDatabase(VEC_SYNC_DIR, { dimensions: 8 }));
    expect(readConfigValue(db, 'vec_sync_id_episodes')).toBeDefined();
    closeDatabase(db);

    const result = createDatabase(VEC_SYNC_DIR, { dimensions: 16 });
    db = result.db;
    expect(result.migrated).toBe(true);
    expect(readConfigValue(db, 'vec_sync_id_episodes')).toBeUndefined();
    expect(readConfigValue(db, 'dimensions')).toBe('16');
    expect(db.prepare('SELECT COUNT(*) AS c FROM vec_episodes').get().c).toBe(0);
  });

  it('upgrades a pre-v14 store, backfilling the vec0 sync mark for its existing embedded rows', () => {
    mkdirSync(VEC_SYNC_DIR, { recursive: true });
    ({ db } = createDatabase(VEC_SYNC_DIR, { dimensions: 8 }));
    insertRawEpisode(db, 'ep-legacy', mockEmbedding(0.4));
    db.prepare(`UPDATE audrey_config SET value = '13' WHERE key = 'schema_version'`).run();
    db.prepare('DELETE FROM audrey_config WHERE key LIKE ?').run('vec_sync_%');
    db.prepare('DELETE FROM vec_episodes WHERE id = ?').run('ep-legacy');
    closeDatabase(db);

    ({ db } = createDatabase(VEC_SYNC_DIR, { dimensions: 8 }));

    expect(
      db.prepare("SELECT value FROM audrey_config WHERE key = 'schema_version'").get().value,
    ).toBe('15');
    expect(db.prepare('SELECT id FROM vec_episodes WHERE id = ?').get('ep-legacy')).toBeDefined();
    expect(readConfigValue(db, 'vec_sync_id_episodes')).toBeDefined();

    const indexes = db.pragma("index_list('episodes')").map(index => index.name);
    expect(indexes).toContain('idx_episodes_embedding_present');
  });
});
