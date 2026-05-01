import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Audrey } from '../dist/src/index.js';
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

  it('preserves episode agent identity', async () => {
    if (existsSync('./test-import-agent-src')) rmSync('./test-import-agent-src', { recursive: true, force: true });
    if (existsSync('./test-import-agent-dest')) rmSync('./test-import-agent-dest', { recursive: true, force: true });
    const agentSource = new Audrey({
      dataDir: './test-import-agent-src',
      agent: 'agent-alpha',
      embedding: { provider: 'mock', dimensions: 8 },
    });
    await agentSource.encode({ content: 'Agent-owned memory', source: 'direct-observation' });

    const snapshot = agentSource.export();
    const agentDest = new Audrey({
      dataDir: './test-import-agent-dest',
      embedding: { provider: 'mock', dimensions: 8 },
    });
    await agentDest.import(snapshot);

    const ep = agentDest.db.prepare("SELECT agent FROM episodes WHERE content = 'Agent-owned memory'").get();
    expect(ep.agent).toBe('agent-alpha');

    agentSource.close();
    agentDest.close();
    rmSync('./test-import-agent-src', { recursive: true, force: true });
    rmSync('./test-import-agent-dest', { recursive: true, force: true });
  });

  it('preserves consolidated memory agent identity', async () => {
    if (existsSync('./test-import-consolidated-agent-src')) rmSync('./test-import-consolidated-agent-src', { recursive: true, force: true });
    if (existsSync('./test-import-consolidated-agent-dest')) rmSync('./test-import-consolidated-agent-dest', { recursive: true, force: true });
    const agentSource = new Audrey({
      dataDir: './test-import-consolidated-agent-src',
      agent: 'agent-alpha',
      embedding: { provider: 'mock', dimensions: 8 },
    });
    await agentSource.encode({ content: 'Consolidated agent marker', source: 'direct-observation' });
    await agentSource.encode({ content: 'Consolidated agent marker', source: 'tool-result' });
    await agentSource.encode({ content: 'Consolidated agent marker', source: 'told-by-user' });
    await agentSource.consolidate({
      minClusterSize: 3,
      similarityThreshold: 0.99,
      extractPrinciple: () => ({ content: 'Agent-owned consolidated semantic', type: 'semantic' }),
    });

    const snapshot = agentSource.export();
    const agentDest = new Audrey({
      dataDir: './test-import-consolidated-agent-dest',
      embedding: { provider: 'mock', dimensions: 8 },
    });
    await agentDest.import(snapshot);

    const sem = agentDest.db.prepare("SELECT agent FROM semantics WHERE content = 'Agent-owned consolidated semantic'").get();
    expect(sem.agent).toBe('agent-alpha');

    agentSource.close();
    agentDest.close();
    rmSync('./test-import-consolidated-agent-src', { recursive: true, force: true });
    rmSync('./test-import-consolidated-agent-dest', { recursive: true, force: true });
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

  it('rejects imported episode content above the production limit', async () => {
    const snapshot = source.export();
    const unsafeSnapshot = JSON.parse(JSON.stringify(snapshot));
    unsafeSnapshot.episodes[0].content = 'x'.repeat(50001);
    dest = new Audrey({
      dataDir: IMPORT_DIR,
      embedding: { provider: 'mock', dimensions: 8 },
    });

    await expect(dest.import(unsafeSnapshot)).rejects.toThrow(/content|maximum|too big/i);
  });

  it('rejects malformed private flags during import', async () => {
    const snapshot = source.export();
    const unsafeSnapshot = JSON.parse(JSON.stringify(snapshot));
    unsafeSnapshot.episodes[0].private = 2;
    dest = new Audrey({
      dataDir: IMPORT_DIR,
      embedding: { provider: 'mock', dimensions: 8 },
    });

    await expect(dest.import(unsafeSnapshot)).rejects.toThrow(/private|invalid/i);
  });

  it('round-trips context and affect through export/import', async () => {
    const ctxSource = new Audrey({
      dataDir: './test-import-ctx-src',
      embedding: { provider: 'mock', dimensions: 8 },
    });
    await ctxSource.encode({
      content: 'Frustrating auth bug',
      source: 'direct-observation',
      context: { task: 'debugging', domain: 'auth' },
      affect: { valence: -0.5, arousal: 0.8, label: 'frustration' },
    });

    const snapshot = ctxSource.export();
    const ctxDest = new Audrey({
      dataDir: './test-import-ctx-dest',
      embedding: { provider: 'mock', dimensions: 8 },
    });
    await ctxDest.import(snapshot);

    const ep = ctxDest.db.prepare("SELECT context, affect FROM episodes WHERE content = 'Frustrating auth bug'").get();
    expect(JSON.parse(ep.context)).toEqual({ task: 'debugging', domain: 'auth' });
    expect(JSON.parse(ep.affect)).toEqual({ valence: -0.5, arousal: 0.8, label: 'frustration' });

    ctxSource.close();
    ctxDest.close();
    rmSync('./test-import-ctx-src', { recursive: true });
    rmSync('./test-import-ctx-dest', { recursive: true });
  });

  it('round-trips interference_count and salience on semantics', async () => {
    await source.encode({ content: 'Export test one', source: 'tool-result' });
    await source.consolidate({ minClusterSize: 2, similarityThreshold: 0.5 });

    const snapshot = source.export();
    const sem = snapshot.semantics?.[0];
    if (sem) {
      expect(sem).toHaveProperty('interference_count');
      expect(sem).toHaveProperty('salience');
    }

    dest = new Audrey({
      dataDir: IMPORT_DIR,
      embedding: { provider: 'mock', dimensions: 8 },
    });
    await dest.import(snapshot);
    const stats = dest.introspect();
    expect(stats.semantic).toBeGreaterThanOrEqual(1);

    const importedSem = dest.db.prepare('SELECT interference_count, salience FROM semantics LIMIT 1').get();
    if (importedSem) {
      expect(importedSem.interference_count).toBeDefined();
      expect(importedSem.salience).toBeDefined();
    }
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
