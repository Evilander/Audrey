/**
 * Project identity for scoping memory signals.
 *
 * A "project" is the git repository containing a working directory (falling
 * back to the directory itself when no .git is found). Namespaces hash the
 * canonical root so paths never leak into stored context values. Linked
 * worktrees resolve to their shared repository root rather than their own
 * checkout, so must-follow rules, failure streaks, and project facts learned
 * in one worktree surface in its siblings.
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function canonicalDirectory(value: string): string {
  const absolute = resolve(value);
  try {
    return realpathSync(absolute).replace(/^\\\\\?\\/, '');
  } catch {
    return absolute;
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

const GITDIR_POINTER_PATTERN = /^gitdir:\s*(.+?)\s*$/;

/**
 * A worktree's `.git` is a file containing `gitdir: <path to
 * .git/worktrees/<name>>` rather than a directory, so it resolves to a
 * different path per worktree unless unwound back to the shared `.git` all
 * worktrees of one repository point into. Returns undefined — falling back
 * to today's per-worktree behavior — on anything unparseable: a malformed
 * pointer file, one whose target no longer exists, or a plain (non-worktree)
 * gitdir pointer with no `worktrees/<name>` segment to unwind.
 */
function resolveWorktreeCommonDir(gitFilePath: string, worktreeDir: string): string | undefined {
  let raw: string;
  try {
    raw = readFileSync(gitFilePath, 'utf8');
  } catch {
    return undefined;
  }

  const pointer = raw
    .split(/\r?\n/)
    .map(line => line.match(GITDIR_POINTER_PATTERN)?.[1])
    .find((match): match is string => Boolean(match));
  if (!pointer) return undefined;

  const gitDir = isAbsolute(pointer) ? pointer : resolve(worktreeDir, pointer);
  if (!existsSync(gitDir)) return undefined;

  const normalized = gitDir.replace(/\\/g, '/');
  const worktreesIndex = normalized.lastIndexOf('/worktrees/');
  if (worktreesIndex === -1) return undefined;
  return normalized.slice(0, worktreesIndex);
}

export function projectRoot(cwd: string): string {
  let current = canonicalDirectory(cwd);
  while (true) {
    const gitPath = join(current, '.git');
    if (existsSync(gitPath)) {
      if (isDirectory(gitPath)) return current;
      const commonDir = resolveWorktreeCommonDir(gitPath, current);
      return commonDir ? canonicalDirectory(dirname(commonDir)) : current;
    }
    const parent = dirname(current);
    if (parent === current) return canonicalDirectory(cwd);
    current = parent;
  }
}

export function projectNamespace(cwd: string): string {
  const root = projectRoot(cwd).replace(/\\/g, '/');
  const stableRoot = process.platform === 'win32' ? root.toLowerCase() : root;
  return `project:${sha256(stableRoot)}`;
}

/**
 * Namespace lookups walk the filesystem (realpath + .git discovery), so batch
 * callers should reuse one cache per operation instead of recomputing for
 * every event row.
 */
export function namespaceMatcher(cwd: string): (candidate: string) => boolean {
  const target = projectNamespace(cwd);
  const cache = new Map<string, boolean>();
  return (candidate: string) => {
    let match = cache.get(candidate);
    if (match === undefined) {
      match = projectNamespace(candidate) === target;
      cache.set(candidate, match);
    }
    return match;
  };
}
