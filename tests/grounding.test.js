import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Audrey } from '../dist/src/index.js';
import {
  extractAnchorCandidates,
  verifyAnchor,
  recordAnchors,
  verifyAnchors,
  groundingForMemories,
  groundingModifier,
  describeBrokenGrounding,
  BROKEN_GROUNDING_MODIFIER,
} from '../dist/src/grounding.js';

describe('extractAnchorCandidates', () => {
  const values = (content, kind) =>
    extractAnchorCandidates(content)
      .filter(anchor => anchor.kind === kind)
      .map(anchor => anchor.value)
      .sort();

  it('extracts package script names behind a runner', () => {
    expect(values('run npm run deploy:prod after pnpm run build', 'npm_script')).toEqual([
      'build',
      'deploy:prod',
    ]);
    expect(values('yarn typecheck then bun test', 'npm_script')).toEqual(['test', 'typecheck']);
  });

  it('ignores runner builtins, which are not package scripts', () => {
    expect(values('npm install and npm publish then npm audit', 'npm_script')).toEqual([]);
  });

  it('ignores a bare word after "run" with no runner in front of it', () => {
    expect(values('let the tests run twice before merging', 'npm_script')).toEqual([]);
  });

  it('extracts repository-relative paths that carry a file extension', () => {
    expect(values('see src/redact.ts and ./scripts/deploy.mjs', 'path')).toEqual([
      'scripts/deploy.mjs',
      'src/redact.ts',
    ]);
  });

  it('normalizes Windows separators to one canonical form', () => {
    expect(values('open src\\lib\\parser.ts now', 'path')).toEqual(['src/lib/parser.ts']);
  });

  it('ignores prose, bare directories, escaping paths, and vendored trees', () => {
    expect(values('the ratio is 3/4 and we discussed it', 'path')).toEqual([]);
    expect(values('look in src/components for it', 'path')).toEqual([]);
    expect(values('check ../outside/repo.ts', 'path')).toEqual([]);
    expect(values('check docs/../../outside/repo.ts', 'path')).toEqual([]);
    expect(values('node_modules/typescript/lib/tsc.js is vendored', 'path')).toEqual([]);
  });

  it('ignores absolute paths, which are not repository-relative claims', () => {
    expect(values('/etc/hosts/config.json is global', 'path')).toEqual([]);
    expect(values('C:/Windows/system32/drivers.sys is global', 'path')).toEqual([]);
  });

  it('ignores URLs, which are not filesystem claims', () => {
    expect(
      values('see https://github.com/Evilander/Audrey/blob/master/src/redact.ts', 'path'),
    ).toEqual([]);
  });

  it('deduplicates repeated mentions of the same claim', () => {
    expect(values('src/a.ts and src/a.ts again, plus src/a.ts', 'path')).toEqual(['src/a.ts']);
  });
});

describe('grounding against a project', () => {
  let project;
  let audrey;

  const script = name => `node scripts/${name}.mjs`;

  const writePackage = scripts =>
    writeFileSync(
      join(project, 'package.json'),
      JSON.stringify({ name: 'fixture', scripts }, null, 2),
    );

  beforeEach(() => {
    project = mkdtempSync(join(tmpdir(), 'audrey-grounding-'));
    mkdirSync(join(project, '.git'), { recursive: true });
    mkdirSync(join(project, 'scripts'), { recursive: true });
    writePackage({ 'deploy:prod': script('deploy'), test: 'vitest' });
    writeFileSync(join(project, 'scripts/deploy.mjs'), '// deploy');
    audrey = new Audrey({
      dataDir: join(project, '.audrey'),
      agent: 'grounding-test',
      embedding: { provider: 'mock', dimensions: 8 },
    });
  });

  afterEach(() => {
    audrey?.close();
    rmSync(project, { recursive: true, force: true });
  });

  const anchors = () =>
    audrey.db.prepare('SELECT kind, value, state FROM memory_anchors ORDER BY kind, value').all();

  const encode = async content => {
    const id = await audrey.encode({ content, source: 'told-by-user', context: { cwd: project } });
    await audrey.drainPostEncodeQueue();
    return id;
  };

  it('verifyAnchor judges each kind against the real project', () => {
    expect(verifyAnchor({ kind: 'path', value: 'scripts/deploy.mjs' }, project)).toBe(true);
    expect(verifyAnchor({ kind: 'path', value: 'scripts/missing.mjs' }, project)).toBe(false);
    expect(verifyAnchor({ kind: 'npm_script', value: 'deploy:prod' }, project)).toBe(true);
    expect(verifyAnchor({ kind: 'npm_script', value: 'nope' }, project)).toBe(false);
  });

  it('reports unknown rather than broken when the project cannot be read', () => {
    // A checkout that moved must not discredit the memories describing it.
    expect(verifyAnchor({ kind: 'path', value: 'a/b.ts' }, join(project, 'gone'))).toBeNull();
    expect(verifyAnchor({ kind: 'npm_script', value: 'test' }, join(project, 'gone'))).toBeNull();
  });

  it('does not treat a path through a junction escaping the project as intact', ctx => {
    // A link inside the project pointing outside it: the lexical containment
    // check passes, but the canonical target is not in the project, so the
    // anchor must not become an existence probe (or a truth claim) about
    // foreign paths.
    const outside = mkdtempSync(join(tmpdir(), 'audrey-grounding-outside-'));
    try {
      writeFileSync(join(outside, 'loot.txt'), 'outside file');
      try {
        symlinkSync(outside, join(project, 'jx'), 'junction');
      } catch {
        // A runner that forbids link creation cannot exercise this path;
        // skip loudly instead of reporting a pass with zero assertions.
        ctx.skip();
        return;
      }
      expect(verifyAnchor({ kind: 'path', value: 'jx/loot.txt' }, project)).toBe(false);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('records only the claims that verify when the memory is written', async () => {
    await encode(
      'Ship with npm run deploy:prod, which runs scripts/deploy.mjs. Someday add src/imaginary.ts.',
    );
    expect(anchors()).toEqual([
      { kind: 'npm_script', value: 'deploy:prod', state: 'intact' },
      { kind: 'path', value: 'scripts/deploy.mjs', state: 'intact' },
    ]);
  });

  it('records nothing for a memory whose claims were never true', async () => {
    await encode('We should probably run npm run nonexistent and edit src/nowhere/file.ts.');
    expect(anchors()).toEqual([]);
  });

  it('marks an anchor broken once the world stops matching it', async () => {
    const id = await encode('Ship with npm run deploy:prod, which runs scripts/deploy.mjs.');
    rmSync(join(project, 'scripts/deploy.mjs'));
    writePackage({ test: 'vitest' });

    const report = verifyAnchors(audrey.db, { projectRoot: project });
    expect(report.checked).toBe(2);
    expect(report.broken).toBe(2);
    expect(report.newlyBroken.map(entry => entry.value).sort()).toEqual([
      'deploy:prod',
      'scripts/deploy.mjs',
    ]);
    expect(report.newlyBroken.every(entry => entry.memoryId === id)).toBe(true);
  });

  it('does not report the same break twice on a later sweep', async () => {
    await encode('Ship with npm run deploy:prod.');
    writePackage({ test: 'vitest' });
    expect(verifyAnchors(audrey.db, { projectRoot: project }).newlyBroken).toHaveLength(1);
    expect(verifyAnchors(audrey.db, { projectRoot: project }).newlyBroken).toHaveLength(0);
  });

  it('repairs a broken anchor when what it names comes back', async () => {
    await encode('Ship with scripts/deploy.mjs.');
    rmSync(join(project, 'scripts/deploy.mjs'));
    expect(verifyAnchors(audrey.db, { projectRoot: project }).broken).toBe(1);

    writeFileSync(join(project, 'scripts/deploy.mjs'), '// restored');
    const repaired = verifyAnchors(audrey.db, { projectRoot: project });
    expect(repaired.repaired).toBe(1);
    expect(repaired.broken).toBe(0);
    expect(anchors()[0].state).toBe('intact');
  });

  it('leaves anchors untouched when the project is gone rather than condemning them', async () => {
    await encode('Ship with scripts/deploy.mjs.');
    const report = verifyAnchors(audrey.db, { projectRoot: join(project, 'moved-away') });
    expect(report.checked).toBe(0);
    expect(anchors()[0].state).toBe('intact');
  });

  it('labels and demotes a broken memory on recall without deleting it', async () => {
    await encode('Ship the release with npm run deploy:prod every time.');
    writePackage({ test: 'vitest' });
    verifyAnchors(audrey.db, { projectRoot: project });

    const results = await audrey.recall('release deploy', { limit: 5 });
    const broken = results.find(entry => entry.grounding === 'broken');
    expect(broken).toBeDefined();
    expect(broken.content).toContain('deploy:prod');
    expect(broken.groundingNote).toContain('deploy:prod');
    expect(broken.groundingNote).toContain('no longer exists');
  });

  it('leaves an unanchored memory unlabelled rather than calling it verified', async () => {
    await encode('The team prefers short pull requests.');
    const results = await audrey.recall('pull requests', { limit: 5 });
    expect(results.length).toBeGreaterThan(0);
    expect(results.every(entry => entry.grounding === undefined)).toBe(true);
  });

  it('demotes a memory once it breaks, so ranking reflects the change', async () => {
    // Measured against the same memory before and after the break rather
    // than against a competing one: relative order depends on the embedding
    // provider, while the penalty applied to score is what grounding owns.
    await encode('Deploy runbook: run npm run deploy:prod for the release.');
    const before = (await audrey.recall('deploy runbook release', { limit: 5 }))[0];
    expect(before.grounding).toBe('grounded');

    writePackage({ test: 'vitest' });
    verifyAnchors(audrey.db, { projectRoot: project });

    const after = (await audrey.recall('deploy runbook release', { limit: 5 }))[0];
    expect(after.id).toBe(before.id);
    expect(after.grounding).toBe('broken');
    // Age decay advances between the two recalls, so compare to the
    // precision that distinguishes a 0.5x penalty, not to the last bit.
    expect(after.score).toBeCloseTo(before.score * BROKEN_GROUNDING_MODIFIER, 6);
    expect(after.confidence).toBeCloseTo(before.confidence * BROKEN_GROUNDING_MODIFIER, 6);
  });

  it('exposes the same sweep through audrey.ground()', async () => {
    await encode('Ship with npm run deploy:prod.');
    writePackage({ test: 'vitest' });
    expect(audrey.ground({ projectRoot: project }).broken).toBe(1);
  });

  it('does not record duplicate anchors when the same claim is encoded twice', async () => {
    await encode('Ship with scripts/deploy.mjs.');
    const first = anchors().length;
    await encode('Ship with scripts/deploy.mjs.');
    // Distinct memories, so distinct anchor rows; the unique index only
    // collapses repeats of one claim for one memory in one project.
    expect(anchors().length).toBe(first * 2);
  });
});

describe('grounding reporting helpers', () => {
  it('scales confidence down for broken memories only', () => {
    expect(groundingModifier('broken')).toBe(BROKEN_GROUNDING_MODIFIER);
    expect(groundingModifier('grounded')).toBe(1);
    expect(groundingModifier(undefined)).toBe(1);
  });

  it('agrees in number with what it describes', () => {
    expect(
      describeBrokenGrounding({
        state: 'broken',
        brokenAnchors: [{ kind: 'path', value: 'a.ts' }],
      }),
    ).toBe('References a.ts, which no longer exists in this project.');
    expect(
      describeBrokenGrounding({
        state: 'broken',
        brokenAnchors: [
          { kind: 'path', value: 'a.ts' },
          { kind: 'npm_script', value: 'build' },
        ],
      }),
    ).toBe('References a.ts, script "build", which no longer exist in this project.');
  });

  it('summarizes rather than listing every broken claim', () => {
    const brokenAnchors = ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts'].map(value => ({
      kind: 'path',
      value,
    }));
    expect(describeBrokenGrounding({ state: 'broken', brokenAnchors })).toContain('and 2 more');
  });

  it('returns nothing to say when there is nothing broken', () => {
    expect(describeBrokenGrounding({ state: 'grounded', brokenAnchors: [] })).toBe('');
  });
});

describe('grounding storage edges', () => {
  let project;
  let audrey;

  beforeEach(() => {
    project = mkdtempSync(join(tmpdir(), 'audrey-grounding-edge-'));
    mkdirSync(join(project, '.git'), { recursive: true });
    audrey = new Audrey({
      dataDir: join(project, '.audrey'),
      agent: 'edge',
      embedding: { provider: 'mock', dimensions: 8 },
    });
  });

  afterEach(() => {
    audrey?.close();
    rmSync(project, { recursive: true, force: true });
  });

  it('records nothing when there is no project root to check against', () => {
    expect(
      recordAnchors(audrey.db, {
        memoryId: 'm1',
        memoryType: 'episodic',
        agent: 'edge',
        content: 'see src/a.ts',
        projectRoot: '',
      }),
    ).toBe(0);
  });

  it('returns an empty report and no query for an empty id list', () => {
    expect(groundingForMemories(audrey.db, []).size).toBe(0);
  });

  it('reports zero for a store that has no anchors at all', () => {
    expect(verifyAnchors(audrey.db, { projectRoot: project })).toEqual({
      checked: 0,
      intact: 0,
      broken: 0,
      repaired: 0,
      newlyBroken: [],
    });
  });
});
