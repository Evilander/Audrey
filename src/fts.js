/**
 * FTS5 full-text search for Audrey memories.
 * Creates virtual tables alongside vec0 tables for hybrid retrieval.
 */

export function createFTSTables(db) {
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS fts_episodes
      USING fts5(id UNINDEXED, content, tags, tokenize='porter unicode61');
    CREATE VIRTUAL TABLE IF NOT EXISTS fts_semantics
      USING fts5(id UNINDEXED, content, tokenize='porter unicode61');
    CREATE VIRTUAL TABLE IF NOT EXISTS fts_procedures
      USING fts5(id UNINDEXED, content, tokenize='porter unicode61');
  `);
}

export function hasFTSTables(db) {
  const row = db.prepare(
    "SELECT COUNT(*) AS c FROM sqlite_master WHERE type='table' AND name='fts_episodes'"
  ).get();
  return row.c > 0;
}

export function insertFTSEpisode(db, id, content, tags) {
  db.prepare('INSERT OR REPLACE INTO fts_episodes(id, content, tags) VALUES (?, ?, ?)').run(
    id, content, tags ? (Array.isArray(tags) ? tags.join(' ') : tags) : ''
  );
}

export function insertFTSSemantic(db, id, content) {
  db.prepare('INSERT OR REPLACE INTO fts_semantics(id, content) VALUES (?, ?)').run(id, content);
}

export function insertFTSProcedure(db, id, content) {
  db.prepare('INSERT OR REPLACE INTO fts_procedures(id, content) VALUES (?, ?)').run(id, content);
}

export function deleteFTSEpisode(db, id) {
  db.prepare('DELETE FROM fts_episodes WHERE id = ?').run(id);
}

export function deleteFTSSemantic(db, id) {
  db.prepare('DELETE FROM fts_semantics WHERE id = ?').run(id);
}

export function deleteFTSProcedure(db, id) {
  db.prepare('DELETE FROM fts_procedures WHERE id = ?').run(id);
}

/**
 * Search episodes via FTS5 BM25.
 * Returns [{ id, content, rank }] sorted by relevance.
 */
export function searchFTSEpisodes(db, query, limit = 30, agentFilter = null) {
  const agentClause = agentFilter ? 'AND e.agent = ?' : '';
  const params = agentFilter ? [query, agentFilter, limit] : [query, limit];
  return db.prepare(`
    SELECT f.id, f.content, e.agent, bm25(fts_episodes) AS rank
    FROM fts_episodes f
    JOIN episodes e ON e.id = f.id
    WHERE fts_episodes MATCH ?
      AND e.superseded_by IS NULL
      ${agentClause}
    ORDER BY rank
    LIMIT ?
  `).all(...params);
}

export function searchFTSSemantics(db, query, limit = 30, agentFilter = null) {
  const agentClause = agentFilter ? 'AND s.agent = ?' : '';
  const params = agentFilter ? [query, agentFilter, limit] : [query, limit];
  return db.prepare(`
    SELECT f.id, f.content, s.agent, bm25(fts_semantics) AS rank
    FROM fts_semantics f
    JOIN semantics s ON s.id = f.id
    WHERE fts_semantics MATCH ?
      AND s.state = 'active'
      ${agentClause}
    ORDER BY rank
    LIMIT ?
  `).all(...params);
}

export function searchFTSProcedures(db, query, limit = 30, agentFilter = null) {
  const agentClause = agentFilter ? 'AND p.agent = ?' : '';
  const params = agentFilter ? [query, agentFilter, limit] : [query, limit];
  return db.prepare(`
    SELECT f.id, f.content, p.agent, bm25(fts_procedures) AS rank
    FROM fts_procedures f
    JOIN procedures p ON p.id = f.id
    WHERE fts_procedures MATCH ?
      AND p.state = 'active'
      ${agentClause}
    ORDER BY rank
    LIMIT ?
  `).all(...params);
}

/**
 * Backfill FTS tables from existing data.
 */
export function backfillFTS(db) {
  const episodes = db.prepare('SELECT id, content, tags FROM episodes').all();
  const insert = db.prepare('INSERT OR IGNORE INTO fts_episodes(id, content, tags) VALUES (?, ?, ?)');
  for (const ep of episodes) {
    const tags = ep.tags ? (typeof ep.tags === 'string' ? JSON.parse(ep.tags) : ep.tags) : [];
    insert.run(ep.id, ep.content, Array.isArray(tags) ? tags.join(' ') : '');
  }

  const semantics = db.prepare('SELECT id, content FROM semantics').all();
  const insertSem = db.prepare('INSERT OR IGNORE INTO fts_semantics(id, content) VALUES (?, ?)');
  for (const sem of semantics) {
    insertSem.run(sem.id, sem.content);
  }

  const procedures = db.prepare('SELECT id, content FROM procedures').all();
  const insertProc = db.prepare('INSERT OR IGNORE INTO fts_procedures(id, content) VALUES (?, ?)');
  for (const proc of procedures) {
    insertProc.run(proc.id, proc.content);
  }
}

/**
 * Sanitize FTS5 query — escape special characters.
 */
export function sanitizeFTSQuery(query) {
  return query
    .replace(/[*"(){}[\]^~\\:]/g, ' ')
    .replace(/\bAND\b|\bOR\b|\bNOT\b|\bNEAR\b/gi, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .join(' ');
}
