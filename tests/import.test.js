import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Audrey } from '../src/index.js';
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
