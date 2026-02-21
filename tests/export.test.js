import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Audrey } from '../src/index.js';
import { existsSync, rmSync } from 'node:fs';

const TEST_DIR = './test-export-data';

describe('export', () => {
  let audrey;

  beforeEach(async () => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    audrey = new Audrey({
      dataDir: TEST_DIR,
      embedding: { provider: 'mock', dimensions: 8 },
    });
    await audrey.encode({ content: 'Memory one', source: 'told-by-user', tags: ['a'] });
    await audrey.encode({ content: 'Memory two', source: 'direct-observation' });
  });

  afterEach(() => {
    audrey.close();
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  it('returns a snapshot with all tables', () => {
    const snapshot = audrey.export();
    expect(snapshot).toHaveProperty('version');
    expect(snapshot).toHaveProperty('exportedAt');
    expect(snapshot).toHaveProperty('episodes');
    expect(snapshot).toHaveProperty('semantics');
    expect(snapshot).toHaveProperty('procedures');
    expect(snapshot).toHaveProperty('causalLinks');
    expect(snapshot).toHaveProperty('contradictions');
    expect(snapshot).toHaveProperty('consolidationRuns');
    expect(snapshot).toHaveProperty('config');
  });

  it('includes all episodes', () => {
    const snapshot = audrey.export();
    expect(snapshot.episodes.length).toBe(2);
    expect(snapshot.episodes[0]).toHaveProperty('id');
    expect(snapshot.episodes[0]).toHaveProperty('content');
    expect(snapshot.episodes[0]).toHaveProperty('source');
  });

  it('excludes raw embedding blobs', () => {
    const snapshot = audrey.export();
    for (const ep of snapshot.episodes) {
      expect(ep).not.toHaveProperty('embedding');
    }
  });

  it('preserves tags as arrays', () => {
    const snapshot = audrey.export();
    const tagged = snapshot.episodes.find(e => e.content === 'Memory one');
    expect(tagged.tags).toEqual(['a']);
  });

  it('produces valid JSON', () => {
    const snapshot = audrey.export();
    const json = JSON.stringify(snapshot);
    const parsed = JSON.parse(json);
    expect(parsed.episodes.length).toBe(2);
  });
});
