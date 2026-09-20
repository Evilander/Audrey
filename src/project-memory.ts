import type { Audrey } from './audrey.js';
import type { CapsuleEntry, MemoryCapsule } from './capsule.js';
import { projectNamespace } from './project.js';

// Classification tags such as 'preference' do not imply shared scope. Only
// an explicit global-preference tag or autopilotScope marker bypasses isolation.
const GLOBAL_PREFERENCE_TAGS = new Set(['global-preference']);
type JsonRecord = Record<string, unknown>;

const text = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value : undefined;

function parsedRecord(value: string | null): JsonRecord {
  try {
    const parsed = JSON.parse(value ?? '{}') as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as JsonRecord)
      : {};
  } catch {
    return {};
  }
}

function stringList(value: string | null | undefined): string[] {
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === 'string')
      : [];
  } catch {
    return value
      .split(',')
      .map(item => item.trim())
      .filter(Boolean);
  }
}

function hasGlobalPreferenceTag(tags: readonly string[] | undefined): boolean {
  return Boolean(tags?.some(tag => GLOBAL_PREFERENCE_TAGS.has(tag.toLowerCase())));
}

export function contextBelongsToProject(context: JsonRecord, namespace: string): boolean {
  if (text(context.autopilotScope) === 'global') return true;
  const storedNamespace = text(context.projectNamespace);
  if (storedNamespace) return storedNamespace === namespace;
  const cwd = text(context.cwd);
  return cwd ? projectNamespace(cwd) === namespace : false;
}

export function memoryIdBelongsToProject(
  audrey: Audrey,
  memoryId: string,
  namespace: string,
  visited = new Set<string>(),
  agent = audrey.agent,
): boolean {
  if (visited.has(memoryId)) return false;
  visited.add(memoryId);

  const episode = audrey.db
    .prepare('SELECT context, tags FROM episodes WHERE id = ? AND agent = ?')
    .get(memoryId, agent) as { context: string | null; tags: string | null } | undefined;
  if (episode) {
    if (hasGlobalPreferenceTag(stringList(episode.tags))) return true;
    return contextBelongsToProject(parsedRecord(episode.context), namespace);
  }

  const event = audrey.db
    .prepare(
      'SELECT cwd FROM memory_events WHERE id = ? AND (actor_agent IS NULL OR actor_agent = ?)',
    )
    .get(memoryId, agent) as { cwd: string | null } | undefined;
  if (event) return Boolean(event.cwd && projectNamespace(event.cwd) === namespace);

  for (const table of ['semantics', 'procedures'] as const) {
    const derived = audrey.db
      .prepare(`SELECT evidence_episode_ids FROM ${table} WHERE id = ? AND agent = ?`)
      .get(memoryId, agent) as { evidence_episode_ids: string | null } | undefined;
    if (!derived) continue;
    const evidenceIds = stringList(derived.evidence_episode_ids);
    return (
      evidenceIds.length > 0 &&
      evidenceIds.every(id =>
        memoryIdBelongsToProject(audrey, id, namespace, new Set(visited), agent),
      )
    );
  }

  const contradiction = audrey.db
    .prepare('SELECT claim_a_id, claim_b_id FROM contradictions WHERE id = ?')
    .get(memoryId) as { claim_a_id: string; claim_b_id: string } | undefined;
  return Boolean(
    contradiction &&
    [contradiction.claim_a_id, contradiction.claim_b_id].every(id =>
      memoryIdBelongsToProject(audrey, id, namespace, new Set(visited), agent),
    ),
  );
}

function failureEntryBelongsToProject(
  audrey: Audrey,
  entry: CapsuleEntry,
  namespace: string,
  agent = audrey.agent,
): boolean {
  if (!entry.created_at) return false;
  const rows = audrey.db
    .prepare(
      `
    SELECT cwd FROM memory_events
    WHERE created_at = ? AND actor_agent = ? AND outcome = 'failed'
  `,
    )
    .all(entry.created_at, agent) as Array<{ cwd: string | null }>;
  return rows.some(row => Boolean(row.cwd && projectNamespace(row.cwd) === namespace));
}

export function entryBelongsToProject(
  audrey: Audrey,
  entry: CapsuleEntry,
  namespace: string,
  agent = audrey.agent,
): boolean {
  if (hasGlobalPreferenceTag(entry.tags)) return true;
  if (entry.memory_type === 'tool_failure') {
    return failureEntryBelongsToProject(audrey, entry, namespace, agent);
  }
  return memoryIdBelongsToProject(audrey, entry.memory_id, namespace, new Set(), agent);
}

interface ScopedCapsule {
  capsule: MemoryCapsule;
  evidenceIds: Set<string>;
  removedEntries: number;
}

export function scopeCapsuleToProject(
  audrey: Audrey,
  capsule: MemoryCapsule,
  namespace: string,
): ScopedCapsule {
  const sections: MemoryCapsule['sections'] = {
    must_follow: [],
    project_facts: [],
    user_preferences: [],
    procedures: [],
    risks: [],
    recent_changes: [],
    contradictions: [],
    uncertain_or_disputed: [],
  };
  const evidenceIds = new Set<string>();
  let removedEntries = 0;
  let usedChars = 0;

  for (const section of Object.keys(capsule.sections) as Array<keyof MemoryCapsule['sections']>) {
    for (const entry of capsule.sections[section]) {
      if (!entryBelongsToProject(audrey, entry, namespace)) {
        removedEntries += 1;
        continue;
      }
      sections[section].push(entry);
      evidenceIds.add(entry.memory_id);
      for (const id of entry.evidence ?? []) evidenceIds.add(id);
      usedChars += entry.content.length + (entry.recommended_action?.length ?? 0);
    }
  }

  return {
    capsule: {
      ...capsule,
      used_chars: usedChars,
      sections,
      evidence_ids: [...evidenceIds],
    },
    evidenceIds,
    removedEntries,
  };
}
