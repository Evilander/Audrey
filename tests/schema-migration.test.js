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
    db.prepare(
      `INSERT INTO semantics (id, content, created_at) VALUES (?, ?, ?)`
    ).run('sem-1', 'test', new Date().toISOString());
    const row = db.prepare('SELECT interference_count FROM semantics WHERE id = ?').get('sem-1');
    expect(row.interference_count).toBe(0);
  });

  it('semantics has salience column defaulting to 0.5', () => {
    db.prepare(
      `INSERT INTO semantics (id, content, created_at) VALUES (?, ?, ?)`
    ).run('sem-1', 'test', new Date().toISOString());
    const row = db.prepare('SELECT salience FROM semantics WHERE id = ?').get('sem-1');
    expect(row.salience).toBe(0.5);
  });

  it('procedures has interference_count column defaulting to 0', () => {
    db.prepare(
      `INSERT INTO procedures (id, content, created_at) VALUES (?, ?, ?)`
    ).run('proc-1', 'test', new Date().toISOString());
    const row = db.prepare('SELECT interference_count FROM procedures WHERE id = ?').get('proc-1');
    expect(row.interference_count).toBe(0);
  });

  it('procedures has salience column defaulting to 0.5', () => {
    db.prepare(
      `INSERT INTO procedures (id, content, created_at) VALUES (?, ?, ?)`
    ).run('proc-1', 'test', new Date().toISOString());
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

    const row = db.prepare(
      "SELECT value FROM audrey_config WHERE key = 'schema_version'"
    ).get();
    expect(row).toBeDefined();
    expect(Number(row.value)).toBeGreaterThanOrEqual(6);
  });

  it('is idempotent — running migrations twice causes no errors', () => {
    mkdirSync(LEGACY_DIR, { recursive: true });
    ({ db } = createDatabase(LEGACY_DIR));
    const firstVersion = db.prepare(
      "SELECT value FROM audrey_config WHERE key = 'schema_version'"
    ).get();
    closeDatabase(db);

    ({ db } = createDatabase(LEGACY_DIR));
    const secondVersion = db.prepare(
      "SELECT value FROM audrey_config WHERE key = 'schema_version'"
    ).get();

    expect(secondVersion.value).toBe(firstVersion.value);
  });

  it('preserves existing data during migration', () => {
    const legacyDb = createLegacyDb();
    const now = new Date().toISOString();
    legacyDb.prepare(
      `INSERT INTO episodes (id, content, source, source_reliability, created_at)
       VALUES (?, ?, ?, ?, ?)`
    ).run('ep-legacy-1', 'I remember the old days', 'direct-observation', 1.0, now);
    legacyDb.close();

    ({ db } = createDatabase(LEGACY_DIR));

    const row = db.prepare('SELECT * FROM episodes WHERE id = ?').get('ep-legacy-1');
    expect(row).toBeDefined();
    expect(row.content).toBe('I remember the old days');
    expect(row.source).toBe('direct-observation');
    expect(row.context).toBe('{}');
    expect(row.affect).toBe('{}');
  });
});
