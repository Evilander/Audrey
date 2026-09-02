import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { join } from 'node:path';
import { mkdirSync, existsSync } from 'node:fs';
import { createFTSTables, backfillFTS } from './fts.js';
import { requireAgent } from './utils.js';

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS episodes (
    id TEXT PRIMARY KEY,
    content TEXT NOT NULL,
    embedding BLOB,
    source TEXT NOT NULL CHECK(source IN ('direct-observation','told-by-user','tool-result','inference','model-generated')),
    agent TEXT DEFAULT 'default',
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
    agent TEXT DEFAULT 'default',
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
    salience REAL DEFAULT 0.5,
    private INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS procedures (
    id TEXT PRIMARY KEY,
    content TEXT NOT NULL,
    agent TEXT DEFAULT 'default',
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
    salience REAL DEFAULT 0.5,
    private INTEGER DEFAULT 0
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
    action_key TEXT,
    hook_host TEXT,
    hook_tool_use_id TEXT,
    receipt_id TEXT,
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
  agent: string;
  embedding: Buffer;
  source?: string;
  consolidated?: number;
  state?: string;
}

type Vec0TableName = 'vec_episodes' | 'vec_semantics' | 'vec_procedures';

interface Vec0MigrationSpec {
  table: Vec0TableName;
  source: 'episodes' | 'semantics' | 'procedures';
  stageColumns: string;
  insertColumns: string;
  selectColumns: string;
}

interface SqlDefinitionRow {
  sql: string | null;
}

interface InvalidOwnerRow {
  id: string;
}

interface PragmaColumn {
  name: string;
}

interface MigrateTableOptions {
  source: VecSyncSource;
  target: Vec0TableName;
  selectCols: string;
  insertCols: string;
  placeholders: string;
  transform: (row: MigrationRow) => unknown[];
  dimensions?: number;
  markKey: string;
}

interface MaxIdRow {
  m: string | null;
}

const VEC0_MIGRATION_SPECS: Vec0MigrationSpec[] = [
  {
    table: 'vec_episodes',
    source: 'episodes',
    stageColumns: 'id, embedding, source, consolidated',
    insertColumns: 'id, agent, embedding, source, consolidated',
    selectColumns: 'staged.id, owner.agent, staged.embedding, staged.source, staged.consolidated',
  },
  {
    table: 'vec_semantics',
    source: 'semantics',
    stageColumns: 'id, embedding, state',
    insertColumns: 'id, agent, embedding, state',
    selectColumns: 'staged.id, owner.agent, staged.embedding, staged.state',
  },
  {
    table: 'vec_procedures',
    source: 'procedures',
    stageColumns: 'id, embedding, state',
    insertColumns: 'id, agent, embedding, state',
    selectColumns: 'staged.id, owner.agent, staged.embedding, staged.state',
  },
];

function createVec0Table(db: Database.Database, dimensions: number, table: Vec0TableName): void {
  if (table === 'vec_episodes') {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS vec_episodes USING vec0(
        id text primary key,
        agent text partition key,
        embedding float[${dimensions}] distance_metric=cosine,
        source text,
        consolidated integer
      );
    `);
    return;
  }

  const stateTable = table === 'vec_semantics' ? 'vec_semantics' : 'vec_procedures';
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS ${stateTable} USING vec0(
      id text primary key,
      agent text partition key,
      embedding float[${dimensions}] distance_metric=cosine,
      state text
    );
  `);
}

export function createVec0Tables(db: Database.Database, dimensions: number): void {
  for (const spec of VEC0_MIGRATION_SPECS) {
    createVec0Table(db, dimensions, spec.table);
  }
}

export type VecSyncSource = 'episodes' | 'semantics' | 'procedures';

const VEC_SYNC_SOURCES: readonly VecSyncSource[] = ['episodes', 'semantics', 'procedures'];

/**
 * Keyed on id, not rowid, and deliberately a different config key from the
 * `vec_sync_rowid_*` marks earlier versions wrote.
 *
 * SQLite hands out max(rowid)+1, so deleting the row that holds the current
 * maximum makes the next insert reuse that rowid. A rowid high-water mark
 * then reads as already-synced and the new row never reaches its vec0
 * table — silently, permanently, with no error and no migrated flag. Memory
 * ids are ULIDs: monotonic, and never recycled by a delete.
 *
 * The key rename matters for the upgrade. A stored numeric mark like "412"
 * compares lexicographically against ULIDs beginning with "0", so reusing
 * the old key would make every existing row look already-synced. A fresh
 * key starts empty and every id sorts above it, which costs one full
 * catch-up scan on first open and is correct from then on.
 */
function vecSyncMarkKey(source: VecSyncSource): string {
  return `vec_sync_id_${source}`;
}

function readConfigText(db: Database.Database, key: string): string {
  const row = db.prepare('SELECT value FROM audrey_config WHERE key = ?').get(key) as
    ConfigRow | undefined;
  return row ? String(row.value) : '';
}

function writeConfigText(db: Database.Database, key: string, value: string): void {
  db.prepare(
    `INSERT INTO audrey_config (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(key, value);
}

const VEC_TARGET_TABLE: Record<VecSyncSource, Vec0TableName> = {
  episodes: 'vec_episodes',
  semantics: 'vec_semantics',
  procedures: 'vec_procedures',
};

/**
 * The vec0 tables mirror live rows only. A forgotten or superseded episode,
 * or a semantic/procedural row in the superseded state, has no vector:
 * recall would filter it out after the KNN anyway, but a dead vector still
 * spends one of the k candidate slots, and memoryStatus() reads "vector
 * count equals live embedded count" as the index being healthy. In strict
 * mode Guard blocks every action while that reads false, so every writer
 * that changes a row's liveness must keep the two in step.
 */
export function liveRowClause(source: VecSyncSource, alias = ''): string {
  const column = alias ? `${alias}.` : '';
  return source === 'episodes'
    ? `${column}superseded_by IS NULL`
    : `${column}state != 'superseded'`;
}

/**
 * Drops the vector for a row and re-inserts it when the row is live and
 * carries an embedding. Safe to call for a row that was just superseded,
 * restored, or deleted.
 */
export function refreshVectorRow(db: Database.Database, source: VecSyncSource, id: string): void {
  const target = VEC_TARGET_TABLE[source];
  db.prepare(`DELETE FROM ${target} WHERE id = ?`).run(id);
  if (source === 'episodes') {
    db.prepare(
      `INSERT INTO vec_episodes(id, agent, embedding, source, consolidated)
       SELECT id, COALESCE(agent, 'default'), embedding, source, consolidated
       FROM episodes
       WHERE id = ? AND embedding IS NOT NULL AND superseded_by IS NULL`,
    ).run(id);
    return;
  }
  db.prepare(
    `INSERT INTO ${target}(id, agent, embedding, state)
     SELECT id, COALESCE(agent, 'default'), embedding, state
     FROM ${source}
     WHERE id = ? AND embedding IS NOT NULL AND state != 'superseded'`,
  ).run(id);
}

const VEC_RECONCILED_KEY = 'vec_index_reconciled_at';

/**
 * One-time repair for stores written before every writer kept dead rows out
 * of the vec0 tables: a full re-embed, an import, or a resolve-truth
 * supersede used to leave vectors behind for rows recall would never
 * return. Runs once per store; the writers keep the invariant from then on.
 */
function reconcileVectorIndex(db: Database.Database): void {
  if (readConfigText(db, VEC_RECONCILED_KEY)) return;
  const sources: VecSyncSource[] = ['episodes', 'semantics', 'procedures'];
  db.transaction(() => {
    for (const source of sources) {
      const dead = db
        .prepare(`SELECT id FROM ${source} WHERE NOT (${liveRowClause(source)})`)
        .all() as Array<{ id: string }>;
      const drop = db.prepare(`DELETE FROM ${VEC_TARGET_TABLE[source]} WHERE id = ?`);
      for (const row of dead) drop.run(row.id);
    }
    writeConfigText(db, VEC_RECONCILED_KEY, new Date().toISOString());
  })();
}

export function dropVec0Tables(db: Database.Database): void {
  const drop = db.transaction(() => {
    db.exec('DROP TABLE IF EXISTS vec_episodes');
    db.exec('DROP TABLE IF EXISTS vec_semantics');
    db.exec('DROP TABLE IF EXISTS vec_procedures');
    // The vec0 tables are gone, so any high-water mark claiming rows up to
    // some rowid are already synced would be a lie — the next
    // migrateEmbeddingsToVec0 call must rescan those tables from scratch.
    const clearMark = db.prepare('DELETE FROM audrey_config WHERE key = ?');
    for (const source of VEC_SYNC_SOURCES) clearMark.run(vecSyncMarkKey(source));
  });
  drop();
}

/**
 * Copies not-yet-synced embeddings from a source table into its vec0
 * shadow, bounded by a persisted high-water mark (audrey_config key
 * markKey) instead of a full table scan on every call. Returns true when a
 * gap remains that this pass could not close (a dimension mismatch, most
 * likely — see the expectedBytes check below), in which case the mark is
 * deliberately left behind: the caller should trigger a full reembed, and
 * the next open must see the same rows again rather than silently treating
 * them as handled.
 */
function migrateTable(
  db: Database.Database,
  {
    source,
    target,
    selectCols,
    insertCols,
    placeholders,
    transform,
    dimensions,
    markKey,
  }: MigrateTableOptions,
): boolean {
  const mark = readConfigText(db, markKey);
  const maxIdRow = db.prepare(`SELECT MAX(id) AS m FROM ${source}`).get() as MaxIdRow;
  const maxId = maxIdRow.m ?? '';
  if (maxId === '' || maxId <= mark) return false;

  const rows = db
    .prepare(
      `
    SELECT ${selectCols}
    FROM ${source} source_row
    WHERE source_row.id > ?
      AND source_row.embedding IS NOT NULL
      AND ${liveRowClause(source, 'source_row')}
      AND NOT EXISTS (
        SELECT 1 FROM ${target} target_row WHERE target_row.id = source_row.id
      )
  `,
    )
    .all(mark) as MigrationRow[];

  const expectedBytes = dimensions ? dimensions * 4 : null;
  let inserted = 0;
  if (rows.length > 0) {
    const insert = db.prepare(`INSERT INTO ${target}(${insertCols}) VALUES (${placeholders})`);
    const tx = db.transaction(() => {
      for (const row of rows) {
        if (expectedBytes && row.embedding.byteLength !== expectedBytes) continue;
        insert.run(...transform(row));
        inserted += 1;
      }
    });
    tx();
  }

  if (inserted < rows.length) return true;

  writeConfigText(db, markKey, maxId);
  return false;
}

/**
 * Catches up vec0 tables with any source rows a normal encode/import/
 * consolidate write didn't already sync atomically (legacy pre-vec0 data,
 * or a row written by another connection). Each table is bounded by its
 * own high-water mark, so a steady-state open with nothing new touches
 * only three cheap MAX(rowid) lookups instead of a full table scan.
 * Returns true if any table still has an unresolved gap, signaling the
 * caller that a full reembed is needed.
 */
function migrateEmbeddingsToVec0(db: Database.Database, dimensions: number): boolean {
  const episodesMismatch = migrateTable(db, {
    source: 'episodes',
    target: 'vec_episodes',
    selectCols: 'id, agent, embedding, source, consolidated',
    insertCols: 'id, agent, embedding, source, consolidated',
    placeholders: '?, ?, ?, ?, ?',
    transform: row => [
      row.id,
      requireAgent(row.agent, 'default'),
      row.embedding,
      row.source,
      BigInt(row.consolidated ?? 0),
    ],
    dimensions,
    markKey: vecSyncMarkKey('episodes'),
  });

  const semanticsMismatch = migrateTable(db, {
    source: 'semantics',
    target: 'vec_semantics',
    selectCols: 'id, agent, embedding, state',
    insertCols: 'id, agent, embedding, state',
    placeholders: '?, ?, ?, ?',
    transform: row => [row.id, requireAgent(row.agent, 'default'), row.embedding, row.state],
    dimensions,
    markKey: vecSyncMarkKey('semantics'),
  });

  const proceduresMismatch = migrateTable(db, {
    source: 'procedures',
    target: 'vec_procedures',
    selectCols: 'id, agent, embedding, state',
    insertCols: 'id, agent, embedding, state',
    placeholders: '?, ?, ?, ?',
    transform: row => [row.id, requireAgent(row.agent, 'default'), row.embedding, row.state],
    dimensions,
    markKey: vecSyncMarkKey('procedures'),
  });

  return episodesMismatch || semanticsMismatch || proceduresMismatch;
}

function hasAgentPartition(db: Database.Database, table: Vec0TableName): boolean {
  const row = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(table) as SqlDefinitionRow | undefined;
  return Boolean(row?.sql && /\bagent\s+text\s+partition\s+key\b/i.test(row.sql));
}

function migrateVec0AgentPartitions(db: Database.Database, dimensions: number): void {
  const legacySpecs = VEC0_MIGRATION_SPECS.filter(spec => !hasAgentPartition(db, spec.table));
  if (legacySpecs.length === 0) return;

  const migrate = db.transaction(() => {
    for (const spec of legacySpecs) {
      const stage = `_audrey_${spec.table}_agent_stage`;
      db.exec(`DROP TABLE IF EXISTS "${stage}"`);
      db.exec(`CREATE TEMP TABLE "${stage}" AS SELECT ${spec.stageColumns} FROM ${spec.table}`);

      const invalidOwner = db
        .prepare(
          `
        SELECT staged.id
        FROM "${stage}" staged
        LEFT JOIN ${spec.source} owner ON owner.id = staged.id
        WHERE owner.id IS NULL
          OR typeof(owner.agent) <> 'text'
          OR length(trim(owner.agent)) = 0
          OR length(trim(owner.agent)) > 128
          OR owner.agent <> trim(owner.agent)
        LIMIT 1
      `,
        )
        .get() as InvalidOwnerRow | undefined;
      if (invalidOwner) {
        throw new Error(
          `Cannot migrate ${spec.table}: vector ${invalidOwner.id} has no valid normalized agent owner in ${spec.source}`,
        );
      }

      const oldCount = (db.prepare(`SELECT COUNT(*) AS c FROM "${stage}"`).get() as CountRow).c;
      db.exec(`DROP TABLE ${spec.table}`);
      createVec0Table(db, dimensions, spec.table);
      db.exec(`
        INSERT INTO ${spec.table}(${spec.insertColumns})
        SELECT ${spec.selectColumns}
        FROM "${stage}" staged
        JOIN ${spec.source} owner ON owner.id = staged.id
      `);

      const newCount = (db.prepare(`SELECT COUNT(*) AS c FROM ${spec.table}`).get() as CountRow).c;
      if (newCount !== oldCount) {
        throw new Error(
          `Cannot migrate ${spec.table}: expected ${oldCount} vectors, rebuilt ${newCount}`,
        );
      }
      db.exec(`DROP TABLE "${stage}"`);
    }
  });
  migrate();
}

function addColumnIfMissing(
  db: Database.Database,
  table: string,
  column: string,
  definition: string,
): void {
  const columns = db.pragma(`table_info(${table})`) as PragmaColumn[];
  const exists = columns.some(col => col.name === column);
  if (!exists) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

const SCHEMA_VERSION = 16;

const MIGRATIONS: { version: number; up(db: Database.Database): void }[] = [
  {
    version: 1,
    up(db) {
      addColumnIfMissing(db, 'episodes', 'context', "TEXT DEFAULT '{}'");
    },
  },
  {
    version: 2,
    up(db) {
      addColumnIfMissing(db, 'episodes', 'affect', "TEXT DEFAULT '{}'");
    },
  },
  {
    version: 3,
    up(db) {
      addColumnIfMissing(db, 'semantics', 'interference_count', 'INTEGER DEFAULT 0');
    },
  },
  {
    version: 4,
    up(db) {
      addColumnIfMissing(db, 'semantics', 'salience', 'REAL DEFAULT 0.5');
    },
  },
  {
    version: 5,
    up(db) {
      addColumnIfMissing(db, 'procedures', 'interference_count', 'INTEGER DEFAULT 0');
    },
  },
  {
    version: 6,
    up(db) {
      addColumnIfMissing(db, 'procedures', 'salience', 'REAL DEFAULT 0.5');
    },
  },
  {
    version: 7,
    up(db) {
      addColumnIfMissing(db, 'episodes', 'private', 'INTEGER DEFAULT 0');
    },
  },
  {
    version: 8,
    up(db) {
      addColumnIfMissing(db, 'episodes', 'agent', "TEXT DEFAULT 'default'");
      addColumnIfMissing(db, 'semantics', 'agent', "TEXT DEFAULT 'default'");
      addColumnIfMissing(db, 'procedures', 'agent', "TEXT DEFAULT 'default'");
      db.exec('CREATE INDEX IF NOT EXISTS idx_episodes_agent ON episodes(agent)');
      db.exec('CREATE INDEX IF NOT EXISTS idx_semantics_agent ON semantics(agent)');
      db.exec('CREATE INDEX IF NOT EXISTS idx_procedures_agent ON procedures(agent)');
    },
  },
  {
    version: 9,
    up(db) {
      createFTSTables(db);
      backfillFTS(db);
    },
  },
  {
    version: 10,
    up(db) {
      addColumnIfMissing(db, 'episodes', 'usage_count', 'INTEGER DEFAULT 0');
      addColumnIfMissing(db, 'episodes', 'last_used_at', 'TEXT');
      addColumnIfMissing(db, 'semantics', 'usage_count', 'INTEGER DEFAULT 0');
      addColumnIfMissing(db, 'semantics', 'last_used_at', 'TEXT');
      addColumnIfMissing(db, 'procedures', 'usage_count', 'INTEGER DEFAULT 0');
      addColumnIfMissing(db, 'procedures', 'last_used_at', 'TEXT');
    },
  },
  {
    version: 11,
    up(_db) {
      // memory_events table and its indexes are created via the top-level
      // SCHEMA block, which is idempotent (CREATE TABLE IF NOT EXISTS). Running
      // this migration simply advances schema_version to 11 for existing DBs.
    },
  },
  {
    version: 12,
    up(db) {
      addColumnIfMissing(db, 'memory_events', 'action_key', 'TEXT');
      db.exec(`
        UPDATE memory_events
        SET action_key = CASE
          WHEN json_valid(metadata) THEN CASE
            WHEN json_type(metadata, '$.audrey_guard_action_key') = 'text'
              THEN json_extract(metadata, '$.audrey_guard_action_key')
            ELSE NULL
          END
          ELSE NULL
        END
        WHERE action_key IS NULL;

        CREATE INDEX IF NOT EXISTS idx_memory_events_action_key
          ON memory_events(action_key, actor_agent, created_at, outcome);
      `);
    },
  },
  {
    version: 13,
    up(db) {
      // Some prerelease v12 stores advanced the logical version without
      // receiving the v12 action_key DDL. Repair the physical schema before
      // any v13 validation or indexes reference that column.
      addColumnIfMissing(db, 'memory_events', 'action_key', 'TEXT');
      addColumnIfMissing(db, 'memory_events', 'hook_host', 'TEXT');
      addColumnIfMissing(db, 'memory_events', 'hook_tool_use_id', 'TEXT');
      addColumnIfMissing(db, 'memory_events', 'receipt_id', 'TEXT');
      db.exec(`
        UPDATE memory_events
        SET action_key = json_extract(metadata, '$.audrey_guard_action_key')
        WHERE action_key IS NULL
          AND json_valid(metadata)
          AND json_type(metadata, '$.audrey_guard_action_key') = 'text'
          AND length(json_extract(metadata, '$.audrey_guard_action_key')) = 64
          AND json_extract(metadata, '$.audrey_guard_action_key') NOT GLOB '*[^0-9a-f]*';

        UPDATE memory_events
        SET action_key = NULL
        WHERE action_key IS NOT NULL
          AND (length(action_key) != 64 OR action_key GLOB '*[^0-9a-f]*');

        UPDATE memory_events
        SET hook_host = CASE
              WHEN hook_host IS NOT NULL THEN hook_host
              WHEN json_valid(metadata)
               AND json_type(metadata, '$.autopilot_host') = 'text'
                THEN json_extract(metadata, '$.autopilot_host')
              ELSE NULL
            END,
            hook_tool_use_id = CASE
              WHEN hook_tool_use_id IS NOT NULL THEN hook_tool_use_id
              WHEN json_valid(metadata)
               AND json_type(metadata, '$.autopilot_tool_use_id') = 'text'
                THEN json_extract(metadata, '$.autopilot_tool_use_id')
              ELSE NULL
            END,
            receipt_id = CASE
              WHEN receipt_id IS NOT NULL THEN receipt_id
              WHEN json_valid(metadata)
               AND json_type(metadata, '$.receipt_id') = 'text'
                THEN json_extract(metadata, '$.receipt_id')
              ELSE NULL
            END
        WHERE hook_host IS NULL OR hook_tool_use_id IS NULL OR receipt_id IS NULL;

        CREATE INDEX IF NOT EXISTS idx_memory_events_action_key
          ON memory_events(action_key, actor_agent, created_at, outcome);
        CREATE INDEX IF NOT EXISTS idx_memory_events_hook_lookup
          ON memory_events(
            actor_agent, hook_host, hook_tool_use_id, session_id, event_type, created_at DESC
          );
        CREATE INDEX IF NOT EXISTS idx_memory_events_receipt
          ON memory_events(receipt_id, actor_agent, created_at DESC);
      `);
    },
  },
  {
    version: 14,
    up(db) {
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_memory_events_tool_outcome_created_actor
          ON memory_events(tool_name, outcome, created_at, actor_agent);

        CREATE INDEX IF NOT EXISTS idx_episodes_embedding_present
          ON episodes(id) WHERE embedding IS NOT NULL;
        CREATE INDEX IF NOT EXISTS idx_semantics_embedding_present
          ON semantics(id) WHERE embedding IS NOT NULL;
        CREATE INDEX IF NOT EXISTS idx_procedures_embedding_present
          ON procedures(id) WHERE embedding IS NOT NULL;
      `);
    },
  },
  {
    version: 15,
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS memory_anchors (
          id TEXT PRIMARY KEY,
          memory_id TEXT NOT NULL,
          memory_type TEXT NOT NULL CHECK(memory_type IN ('episodic','semantic','procedural')),
          agent TEXT NOT NULL DEFAULT 'default',
          project_root TEXT NOT NULL,
          kind TEXT NOT NULL CHECK(kind IN ('path','npm_script')),
          value TEXT NOT NULL,
          state TEXT NOT NULL DEFAULT 'intact' CHECK(state IN ('intact','broken')),
          created_at TEXT NOT NULL,
          last_verified_at TEXT,
          broken_at TEXT
        );

        CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_anchors_unique
          ON memory_anchors(memory_id, project_root, kind, value);
        CREATE INDEX IF NOT EXISTS idx_memory_anchors_memory
          ON memory_anchors(memory_id);
        CREATE INDEX IF NOT EXISTS idx_memory_anchors_sweep
          ON memory_anchors(agent, project_root, last_verified_at);
        CREATE INDEX IF NOT EXISTS idx_memory_anchors_broken
          ON memory_anchors(memory_id) WHERE state = 'broken';

        CREATE INDEX IF NOT EXISTS idx_episodes_must_follow_tag
          ON episodes(id) WHERE tags LIKE '%"must-follow"%';
      `);
    },
  },
  {
    version: 16,
    up(db) {
      // Privacy taint: derived knowledge inherits the private flag from its
      // evidence episodes. Backfill marks any existing semantic/procedural row
      // private when at least one episode it was derived from is private.
      addColumnIfMissing(db, 'semantics', 'private', 'INTEGER DEFAULT 0');
      addColumnIfMissing(db, 'procedures', 'private', 'INTEGER DEFAULT 0');
      db.exec(`
        UPDATE semantics
        SET private = 1
        WHERE private = 0
          AND json_valid(evidence_episode_ids)
          AND EXISTS (
            SELECT 1 FROM json_each(semantics.evidence_episode_ids) je
            JOIN episodes e ON e.id = je.value
            WHERE e.private = 1
          );

        UPDATE procedures
        SET private = 1
        WHERE private = 0
          AND json_valid(evidence_episode_ids)
          AND EXISTS (
            SELECT 1 FROM json_each(procedures.evidence_episode_ids) je
            JOIN episodes e ON e.id = je.value
            WHERE e.private = 1
          );
      `);
    },
  },
];

function runMigrations(db: Database.Database): void {
  const row = db.prepare("SELECT value FROM audrey_config WHERE key = 'schema_version'").get() as
    ConfigRow | undefined;
  const currentVersion = row ? Number(row.value) : 0;

  if (currentVersion >= SCHEMA_VERSION) return;

  const pending = MIGRATIONS.filter(m => m.version > currentVersion);
  const setSchemaVersion = db.prepare(
    `INSERT INTO audrey_config (key, value) VALUES ('schema_version', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  );
  for (const migration of pending) {
    db.transaction(() => {
      migration.up(db);
      setSchemaVersion.run(String(migration.version));
    })();
  }
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
    const stored = db.prepare("SELECT value FROM audrey_config WHERE key = 'dimensions'").get() as
      ConfigRow | undefined;
    if (stored) {
      dimensions = parseInt(stored.value, 10);
    }
  }

  if (dimensions != null) {
    if (!Number.isInteger(dimensions) || dimensions <= 0) {
      throw new Error(`dimensions must be a positive integer, got: ${dimensions}`);
    }

    sqliteVec.load(db);

    const existing = db
      .prepare("SELECT value FROM audrey_config WHERE key = 'dimensions'")
      .get() as ConfigRow | undefined;

    if (existing) {
      const storedDims = parseInt(existing.value, 10);
      if (storedDims !== dimensions) {
        dropVec0Tables(db);
        db.prepare("UPDATE audrey_config SET value = ? WHERE key = 'dimensions'").run(
          String(dimensions),
        );
        migrated = true;
      }
    } else {
      db.prepare("INSERT INTO audrey_config (key, value) VALUES ('dimensions', ?)").run(
        String(dimensions),
      );
    }

    createVec0Tables(db, dimensions);
    migrateVec0AgentPartitions(db, dimensions);
    reconcileVectorIndex(db);

    if (!migrated && migrateEmbeddingsToVec0(db, dimensions)) {
      migrated = true;
    }
  }

  return { db, migrated };
}

export function readStoredDimensions(dataDir: string): number | null {
  const dbPath = join(dataDir, 'audrey.db');
  if (!existsSync(dbPath)) return null;
  const db = new Database(dbPath, { readonly: true });
  try {
    const row = db.prepare("SELECT value FROM audrey_config WHERE key = 'dimensions'").get() as
      ConfigRow | undefined;
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
