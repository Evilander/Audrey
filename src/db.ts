import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { join } from 'node:path';
import { mkdirSync, existsSync } from 'node:fs';
import { createFTSTables, backfillFTS } from './fts.js';

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS episodes (
    id TEXT PRIMARY KEY,
    content TEXT NOT NULL,
    embedding BLOB,
    source TEXT NOT NULL CHECK(source IN ('direct-observation','told-by-user','tool-result','inference','model-generated')),
    source_reliability REAL NOT NULL,
    salience REAL DEFAULT 0.5,
    context TEXT DEFAULT '{}',
    affect TEXT DEFAULT '{}',
    tags TEXT,
    causal_trigger TEXT,
    causal_consequence TEXT,
    created_at TEXT NOT NULL,
    embedding_model TEXT,
    embedding_version TEXT,
    supersedes TEXT,
    superseded_by TEXT,
    consolidated INTEGER DEFAULT 0,
    private INTEGER DEFAULT 0,
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
    challenge_count INTEGER DEFAULT 0,
    interference_count INTEGER DEFAULT 0,
    salience REAL DEFAULT 0.5
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
    retrieval_count INTEGER DEFAULT 0,
    interference_count INTEGER DEFAULT 0,
    salience REAL DEFAULT 0.5
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

  CREATE TABLE IF NOT EXISTS consolidation_metrics (
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

  CREATE TABLE IF NOT EXISTS memory_events (
    id TEXT PRIMARY KEY,
    session_id TEXT,
    event_type TEXT NOT NULL,
    source TEXT NOT NULL,
    actor_agent TEXT,
    tool_name TEXT,
    input_hash TEXT,
    output_hash TEXT,
    outcome TEXT CHECK(outcome IN ('succeeded','failed','blocked','skipped','unknown') OR outcome IS NULL),
    error_summary TEXT,
    cwd TEXT,
    file_fingerprints TEXT,
    redaction_state TEXT DEFAULT 'unreviewed' CHECK(redaction_state IN ('unreviewed','redacted','clean','quarantined')),
    metadata TEXT,
    created_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_episodes_created ON episodes(created_at);
  CREATE INDEX IF NOT EXISTS idx_episodes_consolidated ON episodes(consolidated);
  CREATE INDEX IF NOT EXISTS idx_episodes_source ON episodes(source);
  CREATE INDEX IF NOT EXISTS idx_semantics_state ON semantics(state);
  CREATE INDEX IF NOT EXISTS idx_procedures_state ON procedures(state);
  CREATE INDEX IF NOT EXISTS idx_contradictions_state ON contradictions(state);
  CREATE INDEX IF NOT EXISTS idx_consolidation_status ON consolidation_runs(status);
  CREATE INDEX IF NOT EXISTS idx_memory_events_session ON memory_events(session_id);
  CREATE INDEX IF NOT EXISTS idx_memory_events_tool ON memory_events(tool_name);
  CREATE INDEX IF NOT EXISTS idx_memory_events_created ON memory_events(created_at);
  CREATE INDEX IF NOT EXISTS idx_memory_events_outcome ON memory_events(outcome);
`;

interface ConfigRow {
  value: string;
}

interface CountRow {
  c: number;
}

interface MigrationRow {
  id: string;
  embedding: Buffer;
  source?: string;
  consolidated?: number;
  state?: string;
}

interface PragmaColumn {
  name: string;
}

interface MigrateTableOptions {
  source: string;
  target: string;
  selectCols: string;
  insertCols: string;
  placeholders: string;
  transform: (row: MigrationRow) => unknown[];
  dimensions?: number;
}

export function createVec0Tables(db: Database.Database, dimensions: number): void {
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

export function dropVec0Tables(db: Database.Database): void {
  db.exec('DROP TABLE IF EXISTS vec_episodes');
  db.exec('DROP TABLE IF EXISTS vec_semantics');
  db.exec('DROP TABLE IF EXISTS vec_procedures');
}

function migrateTable(db: Database.Database, { source, target, selectCols, insertCols, placeholders, transform, dimensions }: MigrateTableOptions): void {
  const count = (db.prepare(`SELECT COUNT(*) as c FROM ${target}`).get() as CountRow).c;
  if (count > 0) return;

  const rows = db.prepare(`SELECT ${selectCols} FROM ${source} WHERE embedding IS NOT NULL`).all() as MigrationRow[];
  if (rows.length === 0) return;

  const expectedBytes = dimensions ? dimensions * 4 : null;
  const insert = db.prepare(`INSERT INTO ${target}(${insertCols}) VALUES (${placeholders})`);
  const tx = db.transaction(() => {
    for (const row of rows) {
      if (expectedBytes && row.embedding.byteLength !== expectedBytes) continue;
      insert.run(...transform(row));
    }
  });
  tx();
}

function migrateEmbeddingsToVec0(db: Database.Database, dimensions: number): void {
  migrateTable(db, {
    source: 'episodes',
    target: 'vec_episodes',
    selectCols: 'id, embedding, source, consolidated',
    insertCols: 'id, embedding, source, consolidated',
    placeholders: '?, ?, ?, ?',
    transform: (row) => [row.id, row.embedding, row.source, BigInt(row.consolidated ?? 0)],
    dimensions,
  });

  migrateTable(db, {
    source: 'semantics',
    target: 'vec_semantics',
    selectCols: 'id, embedding, state',
    insertCols: 'id, embedding, state',
    placeholders: '?, ?, ?',
    transform: (row) => [row.id, row.embedding, row.state],
    dimensions,
  });

  migrateTable(db, {
    source: 'procedures',
    target: 'vec_procedures',
    selectCols: 'id, embedding, state',
    insertCols: 'id, embedding, state',
    placeholders: '?, ?, ?',
    transform: (row) => [row.id, row.embedding, row.state],
    dimensions,
  });
}

interface EmbeddingSyncCounts {
  episodes: number;
  vecEpisodes: number;
  semantics: number;
  vecSemantics: number;
  procedures: number;
  vecProcedures: number;
}

function getEmbeddingSyncCounts(db: Database.Database): EmbeddingSyncCounts {
  let vecEpisodes = 0;
  let vecSemantics = 0;
  let vecProcedures = 0;

  try {
    vecEpisodes = (db.prepare('SELECT COUNT(*) as c FROM vec_episodes').get() as CountRow).c;
    vecSemantics = (db.prepare('SELECT COUNT(*) as c FROM vec_semantics').get() as CountRow).c;
    vecProcedures = (db.prepare('SELECT COUNT(*) as c FROM vec_procedures').get() as CountRow).c;
  } catch {
    // vec tables may not exist yet
  }

  const episodes = (db.prepare('SELECT COUNT(*) as c FROM episodes WHERE embedding IS NOT NULL').get() as CountRow).c;
  const semantics = (db.prepare('SELECT COUNT(*) as c FROM semantics WHERE embedding IS NOT NULL').get() as CountRow).c;
  const procedures = (db.prepare('SELECT COUNT(*) as c FROM procedures WHERE embedding IS NOT NULL').get() as CountRow).c;

  return {
    episodes,
    vecEpisodes,
    semantics,
    vecSemantics,
    procedures,
    vecProcedures,
  };
}

function addColumnIfMissing(db: Database.Database, table: string, column: string, definition: string): void {
  const columns = db.pragma(`table_info(${table})`) as PragmaColumn[];
  const exists = columns.some(col => col.name === column);
  if (!exists) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

const SCHEMA_VERSION = 11;

const MIGRATIONS: { version: number; up(db: Database.Database): void }[] = [
  { version: 1, up(db) { addColumnIfMissing(db, 'episodes', 'context', "TEXT DEFAULT '{}'"); } },
  { version: 2, up(db) { addColumnIfMissing(db, 'episodes', 'affect', "TEXT DEFAULT '{}'"); } },
  { version: 3, up(db) { addColumnIfMissing(db, 'semantics', 'interference_count', 'INTEGER DEFAULT 0'); } },
  { version: 4, up(db) { addColumnIfMissing(db, 'semantics', 'salience', 'REAL DEFAULT 0.5'); } },
  { version: 5, up(db) { addColumnIfMissing(db, 'procedures', 'interference_count', 'INTEGER DEFAULT 0'); } },
  { version: 6, up(db) { addColumnIfMissing(db, 'procedures', 'salience', 'REAL DEFAULT 0.5'); } },
  { version: 7, up(db) { addColumnIfMissing(db, 'episodes', 'private', 'INTEGER DEFAULT 0'); } },
  { version: 8, up(db) {
    addColumnIfMissing(db, 'episodes', 'agent', "TEXT DEFAULT 'default'");
    addColumnIfMissing(db, 'semantics', 'agent', "TEXT DEFAULT 'default'");
    addColumnIfMissing(db, 'procedures', 'agent', "TEXT DEFAULT 'default'");
    db.exec("CREATE INDEX IF NOT EXISTS idx_episodes_agent ON episodes(agent)");
    db.exec("CREATE INDEX IF NOT EXISTS idx_semantics_agent ON semantics(agent)");
    db.exec("CREATE INDEX IF NOT EXISTS idx_procedures_agent ON procedures(agent)");
  }},
  { version: 9, up(db) {
    createFTSTables(db);
    backfillFTS(db);
  }},
  { version: 10, up(db) {
    addColumnIfMissing(db, 'episodes', 'usage_count', 'INTEGER DEFAULT 0');
    addColumnIfMissing(db, 'episodes', 'last_used_at', 'TEXT');
    addColumnIfMissing(db, 'semantics', 'usage_count', 'INTEGER DEFAULT 0');
    addColumnIfMissing(db, 'semantics', 'last_used_at', 'TEXT');
    addColumnIfMissing(db, 'procedures', 'usage_count', 'INTEGER DEFAULT 0');
    addColumnIfMissing(db, 'procedures', 'last_used_at', 'TEXT');
  }},
  { version: 11, up(_db) {
    // memory_events table and its indexes are created via the top-level
    // SCHEMA block, which is idempotent (CREATE TABLE IF NOT EXISTS). Running
    // this migration simply advances schema_version to 11 for existing DBs.
  }},
];

function runMigrations(db: Database.Database): void {
  const row = db.prepare("SELECT value FROM audrey_config WHERE key = 'schema_version'").get() as ConfigRow | undefined;
  const currentVersion = row ? Number(row.value) : 0;

  if (currentVersion >= SCHEMA_VERSION) return;

  const pending = MIGRATIONS.filter(m => m.version > currentVersion);
  for (const migration of pending) {
    migration.up(db);
  }

  db.prepare(
    `INSERT INTO audrey_config (key, value) VALUES ('schema_version', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run(String(SCHEMA_VERSION));
}

export function createDatabase(
  dataDir: string,
  options: { dimensions?: number } = {},
): { db: Database.Database; migrated: boolean } {
  let { dimensions } = options;
  let migrated = false;

  mkdirSync(dataDir, { recursive: true });
  const dbPath = join(dataDir, 'audrey.db');
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  // Tuned for memory-store workloads (synchronous=NORMAL is durable under WAL,
  // 64 MiB page cache + 256 MiB mmap reduce read syscalls on hot recall paths).
  // AUDREY_PRAGMA_DEFAULTS=0 reverts to better-sqlite3 defaults.
  if (process.env.AUDREY_PRAGMA_DEFAULTS !== '0') {
    db.pragma('synchronous = NORMAL');
    db.pragma('cache_size = -65536');
    db.pragma('mmap_size = 268435456');
    db.pragma('temp_store = MEMORY');
  }
  db.exec(SCHEMA);
  runMigrations(db);

  if (dimensions == null) {
    const stored = db.prepare("SELECT value FROM audrey_config WHERE key = 'dimensions'").get() as ConfigRow | undefined;
    if (stored) {
      dimensions = parseInt(stored.value, 10);
    }
  }

  if (dimensions != null) {
    if (!Number.isInteger(dimensions) || dimensions <= 0) {
      throw new Error(`dimensions must be a positive integer, got: ${dimensions}`);
    }

    sqliteVec.load(db);

    const existing = db.prepare(
      "SELECT value FROM audrey_config WHERE key = 'dimensions'"
    ).get() as ConfigRow | undefined;

    if (existing) {
      const storedDims = parseInt(existing.value, 10);
      if (storedDims !== dimensions) {
        dropVec0Tables(db);
        db.prepare(
          "UPDATE audrey_config SET value = ? WHERE key = 'dimensions'"
        ).run(String(dimensions));
        migrated = true;
      }
    } else {
      db.prepare(
        "INSERT INTO audrey_config (key, value) VALUES ('dimensions', ?)"
      ).run(String(dimensions));
    }

    createVec0Tables(db, dimensions);

    if (!migrated) {
      migrateEmbeddingsToVec0(db, dimensions);
      const sync = getEmbeddingSyncCounts(db);
      if (
        sync.episodes !== sync.vecEpisodes
        || sync.semantics !== sync.vecSemantics
        || sync.procedures !== sync.vecProcedures
      ) {
        migrated = true;
      }
    }
  }

  return { db, migrated };
}

export function readStoredDimensions(dataDir: string): number | null {
  const dbPath = join(dataDir, 'audrey.db');
  if (!existsSync(dbPath)) return null;
  const db = new Database(dbPath, { readonly: true });
  try {
    const row = db.prepare("SELECT value FROM audrey_config WHERE key = 'dimensions'").get() as ConfigRow | undefined;
    return row ? parseInt(row.value, 10) : null;
  } catch (err: unknown) {
    if (err instanceof Error && err.message?.includes('no such table')) return null;
    throw err;
  } finally {
    db.close();
  }
}

export function closeDatabase(db: Database.Database): void {
  if (db && db.open) {
    db.close();
  }
}
