import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { addCausalLink, getCausalChain, articulateCausalLink } from '../src/causal.js';
import { createDatabase, closeDatabase } from '../src/db.js';
import { MockLLMProvider } from '../src/llm.js';
import { existsSync, rmSync, mkdirSync } from 'node:fs';

const TEST_DIR = './test-causal-data';

describe('addCausalLink', () => {
  let db;

  beforeEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
    db = createDatabase(TEST_DIR);
  });

  afterEach(() => {
    closeDatabase(db);
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  it('inserts a causal link into the database', () => {
    const id = addCausalLink(db, {
      causeId: 'ep-1',
      effectId: 'ep-2',
      linkType: 'causal',
      mechanism: 'Batch processing overwhelmed the rate limit',
      confidence: 0.9,
    });
    expect(typeof id).toBe('string');
    const row = db.prepare('SELECT * FROM causal_links WHERE id = ?').get(id);
    expect(row.cause_id).toBe('ep-1');
    expect(row.effect_id).toBe('ep-2');
    expect(row.link_type).toBe('causal');
    expect(row.mechanism).toBe('Batch processing overwhelmed the rate limit');
    expect(row.confidence).toBe(0.9);
  });

  it('defaults link_type to causal', () => {
    const id = addCausalLink(db, {
      causeId: 'ep-1',
      effectId: 'ep-2',
      mechanism: 'Direct cause',
      confidence: 0.8,
    });
    const row = db.prepare('SELECT link_type FROM causal_links WHERE id = ?').get(id);
    expect(row.link_type).toBe('causal');
  });
});

describe('getCausalChain', () => {
  let db;

  beforeEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
    db = createDatabase(TEST_DIR);
  });

  afterEach(() => {
    closeDatabase(db);
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  it('returns direct effects of a cause', () => {
    addCausalLink(db, { causeId: 'ep-1', effectId: 'ep-2', mechanism: 'A->B', confidence: 0.9 });
    addCausalLink(db, { causeId: 'ep-1', effectId: 'ep-3', mechanism: 'A->C', confidence: 0.8 });
    const chain = getCausalChain(db, 'ep-1');
    expect(chain.length).toBe(2);
    expect(chain.map(l => l.effect_id).sort()).toEqual(['ep-2', 'ep-3']);
  });

  it('follows transitive chains (A->B->C)', () => {
    addCausalLink(db, { causeId: 'ep-1', effectId: 'ep-2', mechanism: 'A->B', confidence: 0.9 });
    addCausalLink(db, { causeId: 'ep-2', effectId: 'ep-3', mechanism: 'B->C', confidence: 0.8 });
    const chain = getCausalChain(db, 'ep-1', { depth: 3 });
    expect(chain.length).toBe(2);
    expect(chain[0].effect_id).toBe('ep-2');
    expect(chain[1].effect_id).toBe('ep-3');
  });

  it('returns empty array for node with no effects', () => {
    const chain = getCausalChain(db, 'nonexistent');
    expect(chain).toEqual([]);
  });

  it('limits traversal depth', () => {
    addCausalLink(db, { causeId: 'a', effectId: 'b', mechanism: 'a->b', confidence: 0.9 });
    addCausalLink(db, { causeId: 'b', effectId: 'c', mechanism: 'b->c', confidence: 0.8 });
    addCausalLink(db, { causeId: 'c', effectId: 'd', mechanism: 'c->d', confidence: 0.7 });
    const chain = getCausalChain(db, 'a', { depth: 2 });
    expect(chain.length).toBe(2);
    expect(chain.map(l => l.effect_id)).toEqual(['b', 'c']);
  });
});

describe('articulateCausalLink', () => {
  let db, llm;

  beforeEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
    db = createDatabase(TEST_DIR);
    llm = new MockLLMProvider({
      responses: {
        causalArticulation: {
          mechanism: 'Batch processing sends too many requests simultaneously',
          linkType: 'causal',
          confidence: 0.9,
          spurious: false,
        },
      },
    });
  });

  afterEach(() => {
    closeDatabase(db);
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  it('calls LLM to articulate mechanism and inserts link', async () => {
    const cause = { id: 'ep-1', content: 'Batch job started', source: 'direct-observation' };
    const effect = { id: 'ep-2', content: 'Rate limit hit', source: 'direct-observation' };
    const result = await articulateCausalLink(db, llm, cause, effect);
    expect(result.linkId).toBeDefined();
    expect(result.mechanism).toBe('Batch processing sends too many requests simultaneously');
    expect(result.linkType).toBe('causal');
    expect(result.spurious).toBe(false);

    const row = db.prepare('SELECT * FROM causal_links WHERE id = ?').get(result.linkId);
    expect(row.mechanism).toContain('Batch processing');
  });

  it('does not insert link when LLM flags as spurious', async () => {
    const spuriousLlm = new MockLLMProvider({
      responses: {
        causalArticulation: {
          mechanism: 'No clear mechanism',
          linkType: 'temporal',
          confidence: 0.2,
          spurious: true,
        },
      },
    });
    const cause = { id: 'ep-1', content: 'Coffee consumed', source: 'direct-observation' };
    const effect = { id: 'ep-2', content: 'Server went down', source: 'tool-result' };
    const result = await articulateCausalLink(db, spuriousLlm, cause, effect);
    expect(result.spurious).toBe(true);
    expect(result.linkId).toBeNull();

    const count = db.prepare('SELECT COUNT(*) as c FROM causal_links').get().c;
    expect(count).toBe(0);
  });
});
