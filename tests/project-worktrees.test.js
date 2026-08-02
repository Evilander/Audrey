import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { canonicalDirectory, projectNamespace, projectRoot } from '../dist/src/project.js';

const TEST_DIR = resolve('.tmp-vitest', 'project-worktrees');

function gitDir(repoDir) {
  return join(repoDir, '.git');
}

function makeMainRepo(name, worktreeNames = []) {
  const repoDir = join(TEST_DIR, name);
  mkdirSync(gitDir(repoDir), { recursive: true });
  for (const worktreeName of worktreeNames) {
    mkdirSync(join(gitDir(repoDir), 'worktrees', worktreeName), { recursive: true });
  }
  return repoDir;
}

function makeWorktreeGitFile(name, pointer) {
  const worktreeDir = join(TEST_DIR, name);
  mkdirSync(worktreeDir, { recursive: true });
  writeFileSync(gitDir(worktreeDir), `gitdir: ${pointer}\n`, 'utf8');
  return worktreeDir;
}

beforeEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
  mkdirSync(TEST_DIR, { recursive: true });
});

afterEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('projectRoot / projectNamespace worktree resolution', () => {
  it('is unaffected when .git is a plain directory (normal repo)', () => {
    const repoDir = makeMainRepo('plain-repo');
    expect(projectRoot(repoDir)).toBe(canonicalDirectory(repoDir));
  });

  it('resolves a linked worktree to its main repository root via an absolute gitdir pointer', () => {
    const mainRepo = makeMainRepo('main-repo', ['wt1']);
    const worktree = makeWorktreeGitFile(
      'worktree-absolute',
      join(gitDir(mainRepo), 'worktrees', 'wt1'),
    );

    expect(projectRoot(worktree)).toBe(canonicalDirectory(mainRepo));
    expect(projectNamespace(worktree)).toBe(projectNamespace(mainRepo));
  });

  it('resolves a linked worktree via a relative gitdir pointer', () => {
    const mainRepo = makeMainRepo('main-repo', ['wt2']);
    const worktree = makeWorktreeGitFile('worktree-relative', '../main-repo/.git/worktrees/wt2');

    expect(projectRoot(worktree)).toBe(canonicalDirectory(mainRepo));
    expect(projectNamespace(worktree)).toBe(projectNamespace(mainRepo));
  });

  it('resolves a linked worktree via a backslash-style relative gitdir pointer', () => {
    const mainRepo = makeMainRepo('main-repo', ['wt3']);
    const worktree = makeWorktreeGitFile(
      'worktree-backslash',
      '..\\main-repo\\.git\\worktrees\\wt3',
    );

    expect(projectRoot(worktree)).toBe(canonicalDirectory(mainRepo));
    expect(projectNamespace(worktree)).toBe(projectNamespace(mainRepo));
  });

  it('gives two sibling worktrees of the same repository the same namespace', () => {
    const mainRepo = makeMainRepo('main-repo', ['wt-a', 'wt-b']);
    const worktreeA = makeWorktreeGitFile(
      'worktree-a',
      join(gitDir(mainRepo), 'worktrees', 'wt-a'),
    );
    const worktreeB = makeWorktreeGitFile(
      'worktree-b',
      join(gitDir(mainRepo), 'worktrees', 'wt-b'),
    );

    expect(projectNamespace(worktreeA)).toBe(projectNamespace(worktreeB));
  });

  it('falls back to per-directory scoping for a malformed .git file', () => {
    const mainRepo = makeMainRepo('main-repo');
    const worktree = join(TEST_DIR, 'worktree-malformed');
    mkdirSync(worktree, { recursive: true });
    writeFileSync(gitDir(worktree), 'this is not a gitdir pointer\n', 'utf8');

    expect(existsSync(gitDir(worktree))).toBe(true);
    expect(projectRoot(worktree)).toBe(canonicalDirectory(worktree));
    expect(projectNamespace(worktree)).not.toBe(projectNamespace(mainRepo));
  });

  it('falls back to per-directory scoping when the gitdir target no longer exists', () => {
    const mainRepo = makeMainRepo('main-repo');
    const worktree = makeWorktreeGitFile(
      'worktree-stale',
      join(TEST_DIR, 'deleted-repo', '.git', 'worktrees', 'ghost'),
    );

    expect(projectRoot(worktree)).toBe(canonicalDirectory(worktree));
    expect(projectNamespace(worktree)).not.toBe(projectNamespace(mainRepo));
  });

  it('falls back to per-directory scoping for a plain (non-worktree) gitdir pointer', () => {
    const mainRepo = makeMainRepo('main-repo');
    const submoduleStore = join(mainRepo, '.git', 'modules', 'sub');
    mkdirSync(submoduleStore, { recursive: true });
    const submodule = makeWorktreeGitFile('submodule', submoduleStore);

    expect(projectRoot(submodule)).toBe(canonicalDirectory(submodule));
    expect(projectNamespace(submodule)).not.toBe(projectNamespace(mainRepo));
  });
});
