import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Audrey, runAutopilotHook } from '../dist/src/index.js';
import { exactActionHistory, recentFailures } from '../dist/src/events.js';
import { forgetMemory, READ_ONLY_PROBE_RETIREMENT_MARKER } from '../dist/src/forget.js';
import { reembedAll } from '../dist/src/migrate.js';
import { createDatabase, closeDatabase } from '../dist/src/db.js';
import { encodeEpisode } from '../dist/src/encode.js';
import { createEmbeddingProvider } from '../dist/src/embedding.js';

const TEST_DIR = './test-read-only-guard-data';
const PROJECT = resolve(TEST_DIR, 'project');

function payload(event, overrides = {}) {
  return {
    hook_event_name: event,
    session_id: 'session-1',
    cwd: PROJECT,
    ...overrides,
  };
}

function bashPre(toolUseId, command) {
  return payload('PreToolUse', {
    tool_use_id: toolUseId,
    tool_name: 'Bash',
    tool_input: { command },
  });
}

function bashFailure(toolUseId, command, stderr) {
  return payload('PostToolUseFailure', {
    tool_use_id: toolUseId,
    tool_name: 'Bash',
    tool_input: { command },
    tool_response: { exit_code: 1, stderr },
    error: stderr,
  });
}

function failureEpisodes(audrey) {
  return audrey.db
    .prepare(
      `SELECT id, content, context, superseded_by FROM episodes
       WHERE source = 'tool-result' AND tags LIKE '%"tool-failure"%'`,
    )
    .all();
}

describe('read-only shell commands and Guard', () => {
  let audrey;

  beforeEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
    mkdirSync(join(PROJECT, '.git'), { recursive: true });
    audrey = new Audrey({
      dataDir: TEST_DIR,
      agent: 'claude-code',
      embedding: { provider: 'mock', dimensions: 8 },
    });
  });

  afterEach(async () => {
    await audrey.closeAsync();
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('skips Guard for a read-only command and records no receipt', async () => {
    const result = await runAutopilotHook(
      audrey,
      bashPre('ro-1', 'cd /repo && grep -n "export" src/index.ts | head -5'),
      { host: 'claude-code' },
    );
    expect(result.output).toEqual({});
    expect(result.receiptId).toBeUndefined();
    expect(audrey.countEvents({ eventType: 'PreToolUse' })).toBe(0);
  });

  it('still guards a side-effecting command', async () => {
    const result = await runAutopilotHook(audrey, bashPre('se-1', 'npm run deploy'), {
      host: 'claude-code',
    });
    expect(result.receiptId).toBeDefined();
    expect(audrey.countEvents({ eventType: 'PreToolUse' })).toBe(1);
  });

  it('does not learn a failure episode from a read-only probe', async () => {
    const command = 'grep -rn "no_such_symbol" src/';
    await runAutopilotHook(audrey, bashPre('probe-1', command), { host: 'claude-code' });
    const after = await runAutopilotHook(audrey, bashFailure('probe-1', command, ''), {
      host: 'claude-code',
    });
    expect(after.learnedFailureId).toBeUndefined();
    expect(failureEpisodes(audrey)).toHaveLength(0);

    const [event] = audrey.listEvents({ eventType: 'PostToolUseFailure' });
    expect(event.outcome).toBe('failed');
    expect(JSON.parse(event.metadata).read_only).toBe(true);
  });

  it('keeps read-only probe failures out of Guard failure signals', async () => {
    const command = 'ls nonexistent-dir';
    await runAutopilotHook(audrey, bashFailure('probe-2', command, 'No such file or directory'), {
      host: 'claude-code',
    });
    expect(recentFailures(audrey.db, { actorAgent: 'claude-code' })).toEqual([]);
    const [event] = audrey.listEvents({ eventType: 'PostToolUseFailure' });
    expect(event.outcome).toBe('failed');
    expect(event.action_key).toMatch(/^[a-f0-9]{64}$/);
    expect(
      exactActionHistory(audrey.db, { actionKey: event.action_key, actorAgent: 'claude-code' }),
    ).toEqual([]);

    // A real failure through the same path still counts.
    await runAutopilotHook(audrey, bashPre('real-1', 'npm run deploy'), { host: 'claude-code' });
    await runAutopilotHook(audrey, bashFailure('real-1', 'npm run deploy', 'STRIPE_KEY unset'), {
      host: 'claude-code',
    });
    expect(recentFailures(audrey.db, { actorAgent: 'claude-code' })).toHaveLength(1);
  });

  it('records the verb signatures of a learned failure', async () => {
    await runAutopilotHook(audrey, bashPre('sig-1', 'cd /repo && npm run deploy -- --prod'), {
      host: 'claude-code',
    });
    const after = await runAutopilotHook(
      audrey,
      bashFailure('sig-1', 'cd /repo && npm run deploy -- --prod', 'STRIPE_KEY unset'),
      { host: 'claude-code' },
    );
    expect(after.learnedFailureId).toBeDefined();
    const [episode] = failureEpisodes(audrey);
    expect(JSON.parse(JSON.parse(episode.context).commandSignatures)).toEqual(['npm run deploy']);
  });

  it('surfaces a remembered failure only for an action that runs the same command', async () => {
    await runAutopilotHook(audrey, bashPre('cap-1', 'npm run deploy'), { host: 'claude-code' });
    await runAutopilotHook(audrey, bashFailure('cap-1', 'npm run deploy', 'STRIPE_KEY unset'), {
      host: 'claude-code',
    });
    const [episode] = failureEpisodes(audrey);
    // Age the episode past the confidence threshold that used to file it
    // under uncertain_or_disputed.
    audrey.db
      .prepare('UPDATE episodes SET created_at = ? WHERE id = ?')
      .run('2025-01-01T00:00:00.000Z', episode.id);

    const query = 'Tool failure: Bash failed while attempting: npm run deploy';
    const same = await audrey.capsule(query, {
      actionSignatures: ['npm run deploy'],
      recall: { minConfidence: 0 },
    });
    expect(same.sections.risks.map(entry => entry.memory_id)).toContain(episode.id);
    expect(same.sections.uncertain_or_disputed).toEqual([]);
    expect(same.sections.project_facts).toEqual([]);

    const other = await audrey.capsule(query, {
      actionSignatures: ['grep'],
      recall: { minConfidence: 0 },
    });
    expect(other.evidence_ids).not.toContain(episode.id);

    const prompt = await audrey.capsule(query, { recall: { minConfidence: 0 } });
    expect(prompt.sections.risks.map(entry => entry.memory_id)).toContain(episode.id);
    expect(prompt.sections.uncertain_or_disputed).toEqual([]);
  });

  it('parses the command out of a legacy failure episode that stored no signatures', async () => {
    const id = await audrey.encode({
      content:
        'Tool failure: Bash failed while attempting: input_chars=40 command=cd /repo && npm run deploy. Error: Exit code 1 STRIPE_KEY unset',
      source: 'tool-result',
      tags: ['autopilot', 'tool-failure', 'Bash'],
      context: { host: 'claude-code', tool: 'Bash' },
    });
    const query = 'Tool failure: Bash failed while attempting: npm run deploy';
    const same = await audrey.capsule(query, {
      actionSignatures: ['npm run deploy'],
      recall: { minConfidence: 0 },
    });
    expect(same.sections.risks.map(entry => entry.memory_id)).toContain(id);
    const other = await audrey.capsule(query, {
      actionSignatures: ['npm test'],
      recall: { minConfidence: 0 },
    });
    expect(other.evidence_ids).not.toContain(id);
  });

  it('explains a Guard caution with the matched signal, not only its id', async () => {
    await runAutopilotHook(audrey, bashPre('explain-1', 'npm run deploy'), { host: 'claude-code' });
    await runAutopilotHook(audrey, bashFailure('explain-1', 'npm run deploy', 'STRIPE_KEY unset'), {
      host: 'claude-code',
    });
    const result = await runAutopilotHook(audrey, bashPre('explain-2', 'npm run deploy -- --dry'), {
      host: 'claude-code',
    });
    const context = result.output.hookSpecificOutput?.additionalContext ?? '';
    expect(context).toMatch(/^Caution:/);
    expect(context).toContain('- recent_failure (medium):');
    expect(context).toContain('STRIPE_KEY unset');
  });
});

describe('read-only probe retirement', () => {
  const dataDir = './test-probe-retirement-data';
  let db;
  let provider;

  beforeEach(() => {
    if (existsSync(dataDir)) rmSync(dataDir, { recursive: true, force: true });
    mkdirSync(dataDir, { recursive: true });
    provider = createEmbeddingProvider({ provider: 'mock', dimensions: 8 });
    ({ db } = createDatabase(dataDir, { dimensions: 8 }));
  });

  afterEach(() => {
    closeDatabase(db);
    if (existsSync(dataDir)) rmSync(dataDir, { recursive: true, force: true });
  });

  async function seedFailure(command, error = 'Exit code 1') {
    return encodeEpisode(db, provider, {
      content: `Tool failure: Bash failed while attempting: input_chars=${command.length + 14} command=${command}. Error: ${error}`,
      source: 'tool-result',
      tags: ['autopilot', 'tool-failure', 'Bash'],
      context: { host: 'claude-code', tool: 'Bash' },
      agent: 'claude-code',
    });
  }

  it('retires legacy probe failures once and leaves real failures alone', async () => {
    const probe = await seedFailure('cd /repo && grep -n "zzz" src/a.ts');
    const missing = await seedFailure('ls agents/review/ 2>&1', 'No such file or directory');
    const real = await seedFailure('cd /repo && npm run deploy', 'STRIPE_KEY unset');
    const flattened = await seedFailure('grep foo file rm -rf build');
    const withSubst = await seedFailure('sed -n "$(grep -n x f)p" f', 'unknown command');
    closeDatabase(db);

    const audrey = new Audrey({
      dataDir,
      agent: 'claude-code',
      embedding: { provider: 'mock', dimensions: 8 },
    });
    try {
      const rows = Object.fromEntries(
        audrey.db
          .prepare('SELECT id, superseded_by FROM episodes')
          .all()
          .map(row => [row.id, row.superseded_by]),
      );
      expect(rows[probe]).toBe(READ_ONLY_PROBE_RETIREMENT_MARKER);
      expect(rows[missing]).toBe(READ_ONLY_PROBE_RETIREMENT_MARKER);
      expect(rows[real]).toBeNull();
      expect(rows[flattened]).toBeNull();
      expect(rows[withSubst]).toBeNull();

      const vecIds = new Set(
        audrey.db
          .prepare('SELECT id FROM vec_episodes')
          .all()
          .map(row => row.id),
      );
      expect(vecIds.has(probe)).toBe(false);
      expect(vecIds.has(real)).toBe(true);

      const status = audrey.memoryStatus();
      expect(status.healthy).toBe(true);
      expect(status.episodes).toBe(3);
      expect(status.vec_episodes).toBe(3);

      const recalled = await audrey.recall('grep zzz src', { limit: 10, minConfidence: 0 });
      expect(recalled.map(result => result.id)).not.toContain(probe);
      expect(
        audrey.db
          .prepare(
            "SELECT value FROM audrey_config WHERE key = 'read_only_probe_failures_retired_at'",
          )
          .get(),
      ).toBeDefined();
    } finally {
      await audrey.closeAsync();
    }
  });
});

describe('vector index mirrors live rows', () => {
  let audrey;

  beforeEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
    mkdirSync(TEST_DIR, { recursive: true });
    audrey = new Audrey({
      dataDir: TEST_DIR,
      agent: 'claude-code',
      embedding: { provider: 'mock', dimensions: 8 },
    });
  });

  afterEach(async () => {
    await audrey.closeAsync();
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('stays healthy after a soft forget', async () => {
    const keep = await audrey.encode({ content: 'kept memory', source: 'told-by-user' });
    const drop = await audrey.encode({ content: 'dropped memory', source: 'told-by-user' });
    expect(audrey.memoryStatus().healthy).toBe(true);
    forgetMemory(audrey.db, drop);
    const status = audrey.memoryStatus();
    expect(status.healthy).toBe(true);
    expect(status.reembed_recommended).toBe(false);
    expect(status.episodes).toBe(1);
    expect(status.searchable_episodes).toBe(1);
    expect(status.vec_episodes).toBe(1);
    expect(
      audrey.db
        .prepare('SELECT id FROM vec_episodes')
        .all()
        .map(row => row.id),
    ).toEqual([keep]);
  });

  it('keeps superseded rows out of the index across a full re-embed', async () => {
    await audrey.encode({ content: 'kept memory', source: 'told-by-user' });
    const drop = await audrey.encode({ content: 'dropped memory', source: 'told-by-user' });
    forgetMemory(audrey.db, drop);
    await reembedAll(audrey.db, audrey.embeddingProvider);
    expect(audrey.memoryStatus().healthy).toBe(true);
    expect(audrey.db.prepare('SELECT COUNT(*) AS c FROM vec_episodes').get().c).toBe(1);
    // The dead row still carries a current embedding for a later restore.
    const row = audrey.db.prepare('SELECT embedding FROM episodes WHERE id = ?').get(drop);
    expect(row.embedding).not.toBeNull();
  });

  it('treats a surplus dead vector as a re-embed recommendation, not a broken index', async () => {
    await audrey.encode({ content: 'kept memory', source: 'told-by-user' });
    const drop = await audrey.encode({ content: 'dropped memory', source: 'told-by-user' });
    // An older writer superseding a row without touching its vector.
    audrey.db.prepare("UPDATE episodes SET superseded_by = 'forgotten' WHERE id = ?").run(drop);
    const status = audrey.memoryStatus();
    expect(status.healthy).toBe(true);
    expect(status.reembed_recommended).toBe(true);
    expect(status.vec_episodes).toBe(2);
    expect(status.episodes).toBe(1);
  });

  it('reports a missing vector as unhealthy', async () => {
    const id = await audrey.encode({ content: 'kept memory', source: 'told-by-user' });
    audrey.db.prepare('DELETE FROM vec_episodes WHERE id = ?').run(id);
    const status = audrey.memoryStatus();
    expect(status.healthy).toBe(false);
    expect(status.reembed_recommended).toBe(true);
  });

  it('repairs a store whose index still holds dead rows on first open', async () => {
    await audrey.encode({ content: 'kept memory', source: 'told-by-user' });
    const drop = await audrey.encode({ content: 'dropped memory', source: 'told-by-user' });
    audrey.db.prepare("UPDATE episodes SET superseded_by = 'forgotten' WHERE id = ?").run(drop);
    audrey.db.prepare("DELETE FROM audrey_config WHERE key = 'vec_index_reconciled_at'").run();
    await audrey.closeAsync();

    audrey = new Audrey({
      dataDir: TEST_DIR,
      agent: 'claude-code',
      embedding: { provider: 'mock', dimensions: 8 },
    });
    expect(audrey.memoryStatus().reembed_recommended).toBe(false);
    expect(audrey.db.prepare('SELECT COUNT(*) AS c FROM vec_episodes').get().c).toBe(1);
  });

  it('clears surplus dead vectors in the maintenance sweep', async () => {
    await audrey.encode({ content: 'kept memory', source: 'told-by-user' });
    const drop = await audrey.encode({ content: 'dropped memory', source: 'told-by-user' });
    audrey.db.prepare("UPDATE episodes SET superseded_by = 'forgotten' WHERE id = ?").run(drop);
    expect(audrey.memoryStatus().reembed_recommended).toBe(true);

    await runAutopilotHook(
      audrey,
      { hook_event_name: 'Stop', session_id: 'session-1', cwd: PROJECT },
      { host: 'claude-code' },
    );
    expect(audrey.memoryStatus().reembed_recommended).toBe(false);
    expect(audrey.db.prepare('SELECT COUNT(*) AS c FROM vec_episodes').get().c).toBe(1);
  });
});
