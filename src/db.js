import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS episodes (
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

  CREATE TABLE IF NOT EXISTS semantics (
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

  CREATE TABLE IF NOT EXISTS procedures (
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

  CREATE TABLE IF NOT EXISTS causal_links (
    id TEXT PRIMARY KEY,
    cause_id TEXT NOT NULL,
    effect_id TEXT NOT NULL,
    link_type TEXT DEFAULT 'causal' CHECK(link_type IN ('causal','correlational','temporal')),
    mechanism TEXT,
    confidence REAL,
    evidence_count INTEGER DEFAULT 1,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS contradictions (
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

  CREATE TABLE IF NOT EXISTS consolidation_runs (
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

  CREATE TABLE IF NOT EXISTS audrey_config (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_episodes_created ON episodes(created_at);
  CREATE INDEX IF NOT EXISTS idx_episodes_consolidated ON episodes(consolidated);
  CREATE INDEX IF NOT EXISTS idx_episodes_source ON episodes(source);
  CREATE INDEX IF NOT EXISTS idx_semantics_state ON semantics(state);
  CREATE INDEX IF NOT EXISTS idx_procedures_state ON procedures(state);
  CREATE INDEX IF NOT EXISTS idx_contradictions_state ON contradictions(state);
  CREATE INDEX IF NOT EXISTS idx_consolidation_status ON consolidation_runs(status);
`;

function createVec0Tables(db, dimensions) {
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS vec_episodes USING vec0(
      id text primary key,
      embedding float[${dimensions}] distance_metric=cosine,
      source text,
      consolidated integer
    );
  `);
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS vec_semantics USING vec0(
      id text primary key,
      embedding float[${dimensions}] distance_metric=cosine,
      state text
    );
  `);
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS vec_procedures USING vec0(
      id text primary key,
      embedding float[${dimensions}] distance_metric=cosine,
      state text
    );
  `);
}

function migrateEmbeddingsToVec0(db) {
  // Migrate episodes: copy embedding BLOBs from episodes to vec_episodes if vec_episodes is empty
  const vecEpCount = db.prepare('SELECT COUNT(*) as c FROM vec_episodes').get().c;
  if (vecEpCount === 0) {
    const episodes = db.prepare(
      'SELECT id, embedding, source, consolidated FROM episodes WHERE embedding IS NOT NULL'
    ).all();
    if (episodes.length > 0) {
      const insert = db.prepare(
        'INSERT INTO vec_episodes(id, embedding, source, consolidated) VALUES (?, ?, ?, ?)'
      );
      const tx = db.transaction(() => {
        for (const ep of episodes) {
          insert.run(ep.id, ep.embedding, ep.source, BigInt(ep.consolidated));
        }
      });
      tx();
    }
  }

  // Migrate semantics
  const vecSemCount = db.prepare('SELECT COUNT(*) as c FROM vec_semantics').get().c;
  if (vecSemCount === 0) {
    const semantics = db.prepare(
      'SELECT id, embedding, state FROM semantics WHERE embedding IS NOT NULL'
    ).all();
    if (semantics.length > 0) {
      const insert = db.prepare(
        'INSERT INTO vec_semantics(id, embedding, state) VALUES (?, ?, ?)'
      );
      const tx = db.transaction(() => {
        for (const sem of semantics) {
          insert.run(sem.id, sem.embedding, sem.state);
        }
      });
      tx();
    }
  }

  // Migrate procedures
  const vecProcCount = db.prepare('SELECT COUNT(*) as c FROM vec_procedures').get().c;
  if (vecProcCount === 0) {
    const procedures = db.prepare(
      'SELECT id, embedding, state FROM procedures WHERE embedding IS NOT NULL'
    ).all();
    if (procedures.length > 0) {
      const insert = db.prepare(
        'INSERT INTO vec_procedures(id, embedding, state) VALUES (?, ?, ?)'
      );
      const tx = db.transaction(() => {
        for (const proc of procedures) {
          insert.run(proc.id, proc.embedding, proc.state);
        }
      });
      tx();
    }
  }
}

export function createDatabase(dataDir, options = {}) {
  const { dimensions } = options;

  mkdirSync(dataDir, { recursive: true });
  const dbPath = join(dataDir, 'audrey.db');
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.exec(SCHEMA);

  if (dimensions) {
    // Load sqlite-vec extension
    sqliteVec.load(db);

    // Validate or store dimensions in config
    const existing = db.prepare(
      "SELECT value FROM audrey_config WHERE key = 'dimensions'"
    ).get();

    if (existing) {
      const storedDims = parseInt(existing.value, 10);
      if (storedDims !== dimensions) {
        db.close();
        throw new Error(
          `Dimension mismatch: database was created with ${storedDims} dimensions, but ${dimensions} were requested`
        );
      }
    } else {
      db.prepare(
        "INSERT INTO audrey_config (key, value) VALUES ('dimensions', ?)"
      ).run(String(dimensions));
    }

    // Create vec0 virtual tables
    createVec0Tables(db, dimensions);

    // Migrate existing embedding BLOBs into vec0 tables
    migrateEmbeddingsToVec0(db);
  }

  return db;
}

export function closeDatabase(db) {
  if (db && db.open) {
    db.close();
  }
}
