import { describe, it, expect, afterEach } from 'vitest';
import { createDatabase, closeDatabase } from '../dist/src/db.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('v0.8.0 schema', () => {
  let db, dataDir;

  afterEach(() => {
    if (db) closeDatabase(db);
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
  });

  it('episodes table has context column', () => {
    dataDir = mkdtempSync(join(tmpdir(), 'audrey-'));
    ({ db } = createDatabase(dataDir, { dimensions: 64 }));
    const info = db.pragma('table_info(episodes)');
    const col = info.find(c => c.name === 'context');
    expect(col).toBeDefined();
    expect(col.dflt_value).toBe("'{}'");
  });

  it('context column defaults to empty JSON object', () => {
    dataDir = mkdtempSync(join(tmpdir(), 'audrey-'));
    ({ db } = createDatabase(dataDir, { dimensions: 64 }));
    db.prepare(`
      INSERT INTO episodes (id, content, source, source_reliability, created_at)
      VALUES ('test-1', 'test', 'direct-observation', 0.95, '2026-01-01T00:00:00Z')
    `).run();
    const row = db.prepare('SELECT context FROM episodes WHERE id = ?').get('test-1');
    expect(row.context).toBe('{}');
  });
});
