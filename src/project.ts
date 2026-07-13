/**
 * Project identity for scoping memory signals.
 *
 * A "project" is the git repository containing a working directory (falling
 * back to the directory itself when no .git is found). Namespaces hash the
 * canonical root so paths never leak into stored context values.
 */

import { createHash } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

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

export function projectRoot(cwd: string): string {
  let current = canonicalDirectory(cwd);
  while (true) {
    if (existsSync(join(current, '.git'))) return current;
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
