import Database from 'better-sqlite3';
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join, normalize, relative } from 'node:path';
import { ulid } from 'ulid';
import type { MemoryType } from './types.js';
import { isContainedIn } from './utils.js';

/**
 * Grounding — checking whether a memory is still true, not just still recent.
 *
 * Confidence already answers "is this well-sourced, recent, reinforced, and
 * uncontradicted?" Nothing answered "does the thing this memory describes
 * still exist?" A procedure that says to deploy with `npm run deploy:prod`
 * holds its confidence forever after that script is deleted — and every
 * recall of it raises confidence further, because retrieval counts as
 * reinforcement. Stale memory is worse than absent memory: Guard states it
 * with evidence attached, so the agent follows it into a wall.
 *
 * An anchor is a claim inside a memory that can be checked against the
 * project it describes: a repository-relative path, or a package script
 * name. Anchors are only recorded when they verify at the moment the memory
 * is written. That is what makes the signal trustworthy — a claim that never
 * resolved is a guess about someone's typo, while a claim that resolved once
 * and no longer does is the world having changed underneath a memory that
 * still asserts it. Only the second kind is worth telling anyone about.
 *
 * Broken anchors never delete or rewrite a memory. They lower its confidence
 * and attach a plain statement of what no longer exists, leaving the memory
 * legible and the judgement with the reader. Memory is evidence, not
 * authority — including Audrey's own evidence about its memory.
 */

export type AnchorKind = 'path' | 'npm_script';
export type AnchorState = 'intact' | 'broken';
export type GroundingState = 'grounded' | 'broken';

export interface AnchorCandidate {
  kind: AnchorKind;
  value: string;
}

export interface MemoryGrounding {
  state: GroundingState;
  brokenAnchors: Array<{ kind: AnchorKind; value: string }>;
}

export interface GroundingReport {
  checked: number;
  intact: number;
  broken: number;
  repaired: number;
  newlyBroken: Array<{ memoryId: string; kind: AnchorKind; value: string }>;
}

/**
 * Multiplier applied to a memory carrying at least one broken anchor. Chosen
 * to push a broken memory below the default recall floor without erasing it:
 * it should stop leading the agent by default while staying inspectable, and
 * still able to outrank noise if it is the only thing that matches.
 */
export const BROKEN_GROUNDING_MODIFIER = 0.5;

/** Directory names whose contents are not the project's own source. */
const IGNORED_PATH_SEGMENTS = new Set(['node_modules', '.git', 'dist', 'build', 'coverage']);

/**
 * `npm run build`, `pnpm run test:watch`, `yarn deploy:prod`. The runner is
 * required: a bare word after "run" in prose is not a script name.
 */
const SCRIPT_PATTERN = /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?([a-zA-Z][\w:.-]{0,63})\b/g;

/**
 * A repository-relative path with a real file extension. The extension is
 * what keeps this from matching ordinary prose containing a slash, and the
 * leading anchor keeps it from matching URLs — those are checked separately
 * and rejected, since an http(s) path is not a filesystem claim.
 */
const PATH_PATTERN =
  /(?<![\w:/\\.-])((?:\.{1,2}\/)?[\w.-]+(?:[/\\][\w.-]+)+\.[a-zA-Z][\w]{0,5})\b/g;

/** Script names that are runner builtins rather than package scripts. */
const RUNNER_BUILTINS = new Set([
  'install',
  'i',
  'add',
  'remove',
  'update',
  'audit',
  'publish',
  'pack',
  'link',
  'init',
  'exec',
  'dlx',
  'create',
  'why',
  'list',
  'ls',
  'outdated',
  'login',
  'logout',
  'view',
  'run',
]);

function normalizeRelativePath(raw: string): string | null {
  const unified = raw.replace(/\\/g, '/').replace(/^\.\//, '');
  if (!unified) return null;
  if (isAbsolute(unified) || /^[A-Za-z]:\//.test(unified)) return null;
  const segments = unified.split('/');
  // Any '..' segment, not only a leading one: 'docs/../../x' escapes too.
  if (segments.includes('..')) return null;
  if (segments.some(segment => IGNORED_PATH_SEGMENTS.has(segment))) return null;
  return unified;
}

/**
 * Pulls checkable claims out of memory content. Extraction is deliberately
 * narrow: a claim that cannot be checked cheaply and unambiguously is better
 * left unanchored than turned into a signal nobody can trust.
 */
export function extractAnchorCandidates(content: string): AnchorCandidate[] {
  const found = new Map<string, AnchorCandidate>();
  if (!content) return [];

  for (const match of content.matchAll(SCRIPT_PATTERN)) {
    const name = match[1];
    if (!name || RUNNER_BUILTINS.has(name)) continue;
    found.set(`npm_script:${name}`, { kind: 'npm_script', value: name });
  }

  for (const match of content.matchAll(PATH_PATTERN)) {
    const raw = match[1];
    if (!raw) continue;
    const value = normalizeRelativePath(raw);
    if (!value) continue;
    found.set(`path:${value}`, { kind: 'path', value });
  }

  return [...found.values()];
}

/** Reads a project's package scripts once per verification pass. */
function packageScripts(projectRoot: string, cache: Map<string, Set<string>>): Set<string> {
  const cached = cache.get(projectRoot);
  if (cached) return cached;
  let names = new Set<string>();
  try {
    const parsed = JSON.parse(readFileSync(join(projectRoot, 'package.json'), 'utf8')) as {
      scripts?: Record<string, unknown>;
    };
    if (parsed.scripts && typeof parsed.scripts === 'object') {
      names = new Set(Object.keys(parsed.scripts));
    }
  } catch {
    // No package.json, or unreadable: script anchors cannot be judged here.
    // verifyAnchor treats that as unknown rather than broken.
  }
  cache.set(projectRoot, names);
  return names;
}

/**
 * Returns true when the claim holds, false when it demonstrably does not,
 * and null when it cannot be judged — an unreadable project, or a store
 * whose project no longer exists on this machine. Unknown is never treated
 * as broken: a memory must not be discredited because the checkout moved.
 */
export function verifyAnchor(
  anchor: AnchorCandidate,
  projectRoot: string,
  cache: Map<string, Set<string>> = new Map(),
): boolean | null {
  if (!projectRoot || !existsSync(projectRoot)) return null;
  if (anchor.kind === 'path') {
    const target = normalize(join(projectRoot, anchor.value));
    // Anchors recorded or imported before the '..' segment check existed
    // must not become an existence probe outside the project.
    const rel = relative(projectRoot, target);
    if (rel.startsWith('..') || isAbsolute(rel)) return false;
    if (!existsSync(target)) return false;
    // The lexical check above cannot see a junction or symlink inside the
    // project pointing elsewhere; re-judge on canonical paths.
    return isContainedIn(projectRoot, target);
  }
  const scripts = packageScripts(projectRoot, cache);
  if (scripts.size === 0) return null;
  return scripts.has(anchor.value);
}

export interface RecordAnchorsInput {
  memoryId: string;
  memoryType: MemoryType;
  agent: string;
  content: string;
  projectRoot: string;
  now?: Date;
}

/**
 * Records the anchors in a memory's content that verify right now. Anchors
 * that do not verify at write time are dropped rather than stored as broken:
 * see the module comment — only a claim that was once true carries
 * information when it later stops being true.
 */
export function recordAnchors(db: Database.Database, input: RecordAnchorsInput): number {
  const { memoryId, memoryType, agent, content, projectRoot } = input;
  if (!projectRoot) return 0;
  const candidates = extractAnchorCandidates(content);
  if (candidates.length === 0) return 0;

  const timestamp = (input.now ?? new Date()).toISOString();
  const cache = new Map<string, Set<string>>();
  const verified = candidates.filter(candidate => verifyAnchor(candidate, projectRoot, cache));
  if (verified.length === 0) return 0;

  const insert = db.prepare(`
    INSERT OR IGNORE INTO memory_anchors
      (id, memory_id, memory_type, agent, project_root, kind, value, state, created_at, last_verified_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'intact', ?, ?)
  `);
  const write = db.transaction(() => {
    for (const anchor of verified) {
      insert.run(
        ulid(),
        memoryId,
        memoryType,
        agent,
        projectRoot,
        anchor.kind,
        anchor.value,
        timestamp,
        timestamp,
      );
    }
  });
  write();
  return verified.length;
}

interface AnchorRow {
  id: string;
  memory_id: string;
  project_root: string;
  kind: AnchorKind;
  value: string;
  state: AnchorState;
}

export interface VerifyAnchorsOptions {
  agent?: string;
  projectRoot?: string;
  limit?: number;
  now?: Date;
}

/**
 * Re-checks stored anchors against the current state of their project and
 * moves them between intact and broken. Repair is symmetric: a path that
 * comes back — a reverted delete, a restored checkout — clears the broken
 * state, so a transient absence does not permanently discredit a memory.
 */
export function verifyAnchors(
  db: Database.Database,
  options: VerifyAnchorsOptions = {},
): GroundingReport {
  const report: GroundingReport = {
    checked: 0,
    intact: 0,
    broken: 0,
    repaired: 0,
    newlyBroken: [],
  };
  const limit = options.limit ?? 2000;
  const filters: string[] = [];
  const params: unknown[] = [];
  if (options.agent) {
    filters.push('agent = ?');
    params.push(options.agent);
  }
  if (options.projectRoot) {
    filters.push('project_root = ?');
    params.push(options.projectRoot);
  }
  const where = filters.length > 0 ? `WHERE ${filters.join(' AND ')}` : '';
  const rows = db
    .prepare(
      `SELECT id, memory_id, project_root, kind, value, state
       FROM memory_anchors ${where}
       ORDER BY last_verified_at IS NULL DESC, last_verified_at ASC
       LIMIT ?`,
    )
    .all(...params, limit) as AnchorRow[];
  if (rows.length === 0) return report;

  const timestamp = (options.now ?? new Date()).toISOString();
  const cache = new Map<string, Set<string>>();
  const markIntact = db.prepare(
    `UPDATE memory_anchors SET state = 'intact', last_verified_at = ?, broken_at = NULL WHERE id = ?`,
  );
  const markBroken = db.prepare(
    `UPDATE memory_anchors SET state = 'broken', last_verified_at = ?, broken_at = ? WHERE id = ?`,
  );

  const run = db.transaction(() => {
    for (const row of rows) {
      const result = verifyAnchor({ kind: row.kind, value: row.value }, row.project_root, cache);
      // Unknown leaves the row exactly as it was, including its previous
      // verification time, so it stays at the front of the queue.
      if (result === null) continue;
      report.checked += 1;
      if (result) {
        report.intact += 1;
        if (row.state === 'broken') report.repaired += 1;
        markIntact.run(timestamp, row.id);
      } else {
        report.broken += 1;
        if (row.state !== 'broken') {
          report.newlyBroken.push({ memoryId: row.memory_id, kind: row.kind, value: row.value });
        }
        markBroken.run(timestamp, timestamp, row.id);
      }
    }
  });
  run();
  return report;
}

/**
 * Grounding for a set of memory ids, for callers that already hold recall
 * results and need to annotate them. Returns entries only for memories that
 * actually carry anchors, so an unanchored memory stays unlabelled rather
 * than being presented as verified.
 */
export function groundingForMemories(
  db: Database.Database,
  memoryIds: string[],
): Map<string, MemoryGrounding> {
  const grounding = new Map<string, MemoryGrounding>();
  if (memoryIds.length === 0) return grounding;
  const placeholders = memoryIds.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT memory_id, kind, value, state
       FROM memory_anchors WHERE memory_id IN (${placeholders})`,
    )
    .all(...memoryIds) as Array<{
    memory_id: string;
    kind: AnchorKind;
    value: string;
    state: AnchorState;
  }>;

  for (const row of rows) {
    const entry = grounding.get(row.memory_id) ?? { state: 'grounded', brokenAnchors: [] };
    if (row.state === 'broken') {
      entry.state = 'broken';
      entry.brokenAnchors.push({ kind: row.kind, value: row.value });
    }
    grounding.set(row.memory_id, entry);
  }
  return grounding;
}

/** Confidence multiplier for a memory's grounding state. */
export function groundingModifier(state: GroundingState | undefined): number {
  return state === 'broken' ? BROKEN_GROUNDING_MODIFIER : 1;
}

/** One-line, human-readable statement of what a memory still asserts. */
export function describeBrokenGrounding(grounding: MemoryGrounding): string {
  const described = grounding.brokenAnchors
    .slice(0, 3)
    .map(anchor => (anchor.kind === 'npm_script' ? `script "${anchor.value}"` : anchor.value));
  if (described.length === 0) return '';
  const remaining = grounding.brokenAnchors.length - described.length;
  const tail = remaining > 0 ? `, and ${remaining} more` : '';
  const verb = grounding.brokenAnchors.length === 1 ? 'no longer exists' : 'no longer exist';
  return `References ${described.join(', ')}${tail}, which ${verb} in this project.`;
}
