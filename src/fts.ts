/**
 * FTS5 full-text search for Audrey memories.
 * Creates virtual tables alongside vec0 tables for hybrid retrieval.
 */

import Database from 'better-sqlite3';

export interface FTSMatch {
  id: string;
  content: string;
  agent: string;
  rank: number;
}

export function createFTSTables(db: Database.Database): void {
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS fts_episodes
      USING fts5(id UNINDEXED, content, tags, tokenize='porter unicode61');
    CREATE VIRTUAL TABLE IF NOT EXISTS fts_semantics
      USING fts5(id UNINDEXED, content, tokenize='porter unicode61');
    CREATE VIRTUAL TABLE IF NOT EXISTS fts_procedures
      USING fts5(id UNINDEXED, content, tokenize='porter unicode61');
  `);
}

export function hasFTSTables(db: Database.Database): boolean {
  const row = db.prepare(
    "SELECT COUNT(*) AS c FROM sqlite_master WHERE type='table' AND name='fts_episodes'"
  ).get() as { c: number };
  return row.c > 0;
}

export function insertFTSEpisode(
  db: Database.Database,
  id: string,
  content: string,
  tags?: string | string[] | null,
): void {
  const tagsText = tags ? (Array.isArray(tags) ? tags.join(' ') : tags) : '';
  db.prepare('INSERT OR REPLACE INTO fts_episodes(id, content, tags) VALUES (?, ?, ?)').run(
    id, content, tagsText
  );
}

export function insertFTSSemantic(db: Database.Database, id: string, content: string): void {
  db.prepare('INSERT OR REPLACE INTO fts_semantics(id, content) VALUES (?, ?)').run(id, content);
}

export function insertFTSProcedure(db: Database.Database, id: string, content: string): void {
  db.prepare('INSERT OR REPLACE INTO fts_procedures(id, content) VALUES (?, ?)').run(id, content);
}

export function deleteFTSEpisode(db: Database.Database, id: string): void {
  db.prepare('DELETE FROM fts_episodes WHERE id = ?').run(id);
}

export function deleteFTSSemantic(db: Database.Database, id: string): void {
  db.prepare('DELETE FROM fts_semantics WHERE id = ?').run(id);
}

export function deleteFTSProcedure(db: Database.Database, id: string): void {
  db.prepare('DELETE FROM fts_procedures WHERE id = ?').run(id);
}

/**
 * Search episodes via FTS5 BM25.
 */
export function searchFTSEpisodes(
  db: Database.Database,
  query: string,
  limit: number = 30,
  agentFilter: string | null = null,
): FTSMatch[] {
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
  `).all(...params) as FTSMatch[];
}

export function searchFTSSemantics(
  db: Database.Database,
  query: string,
  limit: number = 30,
  agentFilter: string | null = null,
): FTSMatch[] {
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
  `).all(...params) as FTSMatch[];
}

export function searchFTSProcedures(
  db: Database.Database,
  query: string,
  limit: number = 30,
  agentFilter: string | null = null,
): FTSMatch[] {
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
  `).all(...params) as FTSMatch[];
}

interface EpisodeRow {
  id: string;
  content: string;
  tags: string | null;
}

interface ContentRow {
  id: string;
  content: string;
}

/**
 * Backfill FTS tables from existing data.
 */
export function backfillFTS(db: Database.Database): void {
  const episodes = db.prepare('SELECT id, content, tags FROM episodes').all() as EpisodeRow[];
  const insert = db.prepare('INSERT OR IGNORE INTO fts_episodes(id, content, tags) VALUES (?, ?, ?)');
  for (const ep of episodes) {
    const parsed: unknown = ep.tags ? (typeof ep.tags === 'string' ? JSON.parse(ep.tags) : ep.tags) : [];
    const tagsText = Array.isArray(parsed) ? (parsed as string[]).join(' ') : '';
    insert.run(ep.id, ep.content, tagsText);
  }

  const semantics = db.prepare('SELECT id, content FROM semantics').all() as ContentRow[];
  const insertSem = db.prepare('INSERT OR IGNORE INTO fts_semantics(id, content) VALUES (?, ?)');
  for (const sem of semantics) {
    insertSem.run(sem.id, sem.content);
  }

  const procedures = db.prepare('SELECT id, content FROM procedures').all() as ContentRow[];
  const insertProc = db.prepare('INSERT OR IGNORE INTO fts_procedures(id, content) VALUES (?, ?)');
  for (const proc of procedures) {
    insertProc.run(proc.id, proc.content);
  }
}

/**
 * Sanitize FTS5 query — escape special characters.
 */
export function sanitizeFTSQuery(query: string): string {
  return query
    .replace(/[^\p{L}\p{N}_]+/gu, ' ')
    .replace(/\bAND\b|\bOR\b|\bNOT\b|\bNEAR\b/gi, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .join(' ');
}
