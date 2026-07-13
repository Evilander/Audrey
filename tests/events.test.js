import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createDatabase, closeDatabase } from '../dist/src/db.js';
import {
  insertEvent,
  listEvents,
  countEvents,
  recentFailures,
  deleteEventsBefore,
} from '../dist/src/events.js';
import { existsSync, rmSync, mkdirSync } from 'node:fs';

const TEST_DIR = './test-events-data';

describe('memory_events CRUD', () => {
  let db;

  beforeEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
    mkdirSync(TEST_DIR, { recursive: true });
    ({ db } = createDatabase(TEST_DIR, { dimensions: 8 }));
  });

  afterEach(() => {
    closeDatabase(db);
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('inserts a minimal event and returns a row with generated id', () => {
    const event = insertEvent(db, {
      eventType: 'PostToolUse',
      source: 'tool-trace',
      toolName: 'Bash',
    });
    expect(event.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(event.event_type).toBe('PostToolUse');
    expect(event.source).toBe('tool-trace');
    expect(event.tool_name).toBe('Bash');
    expect(event.redaction_state).toBe('unreviewed');
    expect(event.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('round-trips metadata as JSON string', () => {
    insertEvent(db, {
      eventType: 'PostToolUse',
      source: 'tool-trace',
      toolName: 'Edit',
      metadata: { file: 'src/app.ts', lines_changed: 12 },
    });
    const [event] = listEvents(db, { toolName: 'Edit' });
    expect(event.metadata).toBe('{"file":"src/app.ts","lines_changed":12}');
  });

  it('filters by sessionId, toolName, outcome, since', () => {
    insertEvent(db, {
      eventType: 'PostToolUse',
      source: 'tool-trace',
      toolName: 'Bash',
      sessionId: 'S1',
      outcome: 'succeeded',
    });
    insertEvent(db, {
      eventType: 'PostToolUse',
      source: 'tool-trace',
      toolName: 'Bash',
      sessionId: 'S1',
      outcome: 'failed',
    });
    insertEvent(db, {
      eventType: 'PostToolUse',
      source: 'tool-trace',
      toolName: 'Edit',
      sessionId: 'S2',
      outcome: 'succeeded',
    });

    expect(listEvents(db, { sessionId: 'S1' })).toHaveLength(2);
    expect(listEvents(db, { sessionId: 'S2' })).toHaveLength(1);
    expect(listEvents(db, { toolName: 'Bash' })).toHaveLength(2);
    expect(listEvents(db, { outcome: 'failed' })).toHaveLength(1);
    expect(countEvents(db, { outcome: 'succeeded' })).toBe(2);
  });

  it('recentFailures groups failures by tool with most recent error', () => {
    insertEvent(db, {
      eventType: 'PostToolUse',
      source: 'tool-trace',
      toolName: 'Bash',
      outcome: 'succeeded',
      createdAt: '2026-04-19T12:00:00Z',
    });
    insertEvent(db, {
      eventType: 'PostToolUseFailure',
      source: 'tool-trace',
      toolName: 'Bash',
      outcome: 'failed',
      errorSummary: 'old error',
      createdAt: '2026-04-20T10:00:00Z',
    });
    insertEvent(db, {
      eventType: 'PostToolUseFailure',
      source: 'tool-trace',
      toolName: 'Bash',
      outcome: 'failed',
      errorSummary: 'newer error',
      createdAt: '2026-04-22T10:00:00Z',
    });
    insertEvent(db, {
      eventType: 'PostToolUseFailure',
      source: 'tool-trace',
      toolName: 'Edit',
      outcome: 'failed',
      errorSummary: 'edit failed',
      createdAt: '2026-04-21T10:00:00Z',
    });

    const failures = recentFailures(db, { since: '2026-04-19T00:00:00Z' });
    expect(failures).toHaveLength(2);
    const bash = failures.find(f => f.tool_name === 'Bash');
    expect(bash?.failure_count).toBe(2);
    expect(bash?.last_error_summary).toBe('newer error');
    expect(bash?.last_succeeded_at).toBe('2026-04-19T12:00:00Z');
    expect(failures[0].tool_name).toBe('Bash'); // most recent first
  });

  it('recentFailures extinguishes a streak once the tool succeeds after it', () => {
    insertEvent(db, {
      eventType: 'PostToolUseFailure',
      source: 'tool-trace',
      toolName: 'Bash',
      outcome: 'failed',
      errorSummary: 'lint loop',
      createdAt: '2026-04-20T10:00:00Z',
    });
    insertEvent(db, {
      eventType: 'PostToolUse',
      source: 'tool-trace',
      toolName: 'Bash',
      outcome: 'succeeded',
      createdAt: '2026-04-20T11:00:00Z',
    });

    expect(recentFailures(db, { since: '2026-04-19T00:00:00Z' })).toHaveLength(0);

    const resolved = recentFailures(db, {
      since: '2026-04-19T00:00:00Z',
      includeResolved: true,
    });
    expect(resolved).toHaveLength(1);
    expect(resolved[0].last_succeeded_at).toBe('2026-04-20T11:00:00Z');
  });

  it('recentFailures counts only failures after the most recent success', () => {
    const events = [
      ['failed', '2026-04-20T08:00:00Z'],
      ['succeeded', '2026-04-20T09:00:00Z'],
      ['failed', '2026-04-20T10:00:00Z'],
      ['failed', '2026-04-20T11:00:00Z'],
    ];
    for (const [outcome, createdAt] of events) {
      insertEvent(db, {
        eventType: outcome === 'failed' ? 'PostToolUseFailure' : 'PostToolUse',
        source: 'tool-trace',
        toolName: 'Bash',
        outcome,
        errorSummary: outcome === 'failed' ? `error at ${createdAt}` : undefined,
        createdAt,
      });
    }

    const failures = recentFailures(db, { since: '2026-04-19T00:00:00Z' });
    expect(failures).toHaveLength(1);
    expect(failures[0].failure_count).toBe(2);
    expect(failures[0].last_succeeded_at).toBe('2026-04-20T09:00:00Z');
  });

  it('recentFailures scopes to the project when cwd is provided', () => {
    // Distinct .git markers keep the fixtures from resolving up to this
    // repository's own project root.
    const projectA = `${TEST_DIR}/project-a`;
    const projectB = `${TEST_DIR}/project-b`;
    for (const dir of [projectA, projectB]) mkdirSync(`${dir}/.git`, { recursive: true });

    insertEvent(db, {
      eventType: 'PostToolUseFailure',
      source: 'tool-trace',
      toolName: 'Bash',
      outcome: 'failed',
      errorSummary: 'failure in project A',
      cwd: projectA,
      createdAt: '2026-04-20T10:00:00Z',
    });
    insertEvent(db, {
      eventType: 'PostToolUseFailure',
      source: 'tool-trace',
      toolName: 'Edit',
      outcome: 'failed',
      errorSummary: 'failure without cwd',
      createdAt: '2026-04-20T10:30:00Z',
    });

    const inB = recentFailures(db, { since: '2026-04-19T00:00:00Z', cwd: projectB });
    // Project A's Bash failure is foreign; the cwd-less Edit failure cannot
    // be proven foreign and stays.
    expect(inB.map(f => f.tool_name)).toEqual(['Edit']);

    const inA = recentFailures(db, { since: '2026-04-19T00:00:00Z', cwd: projectA });
    expect(inA.map(f => f.tool_name).sort()).toEqual(['Bash', 'Edit']);
  });

  it('recentFailures does not let a success in another project extinguish a local streak', () => {
    const projectA = `${TEST_DIR}/project-a`;
    const projectB = `${TEST_DIR}/project-b`;
    for (const dir of [projectA, projectB]) mkdirSync(`${dir}/.git`, { recursive: true });

    insertEvent(db, {
      eventType: 'PostToolUseFailure',
      source: 'tool-trace',
      toolName: 'Bash',
      outcome: 'failed',
      errorSummary: 'still broken here',
      cwd: projectA,
      createdAt: '2026-04-20T10:00:00Z',
    });
    insertEvent(db, {
      eventType: 'PostToolUse',
      source: 'tool-trace',
      toolName: 'Bash',
      outcome: 'succeeded',
      cwd: projectB,
      createdAt: '2026-04-20T11:00:00Z',
    });

    const inA = recentFailures(db, { since: '2026-04-19T00:00:00Z', cwd: projectA });
    expect(inA).toHaveLength(1);
    expect(inA[0].last_succeeded_at).toBeNull();

    // Without a cwd filter the cross-project success does resolve the streak.
    expect(recentFailures(db, { since: '2026-04-19T00:00:00Z' })).toHaveLength(0);
  });

  it('deleteEventsBefore removes events older than cutoff', () => {
    insertEvent(db, {
      eventType: 'PostToolUse',
      source: 'tool-trace',
      toolName: 'Bash',
      createdAt: '2026-01-01T00:00:00Z',
    });
    insertEvent(db, {
      eventType: 'PostToolUse',
      source: 'tool-trace',
      toolName: 'Bash',
      createdAt: '2026-04-22T00:00:00Z',
    });
    const deleted = deleteEventsBefore(db, '2026-02-01T00:00:00Z');
    expect(deleted).toBe(1);
    expect(countEvents(db)).toBe(1);
  });

  it('respects limit clamp', () => {
    for (let i = 0; i < 5; i++) {
      insertEvent(db, { eventType: 'PostToolUse', source: 'tool-trace', toolName: 'Bash' });
    }
    expect(listEvents(db, { limit: 3 })).toHaveLength(3);
    expect(listEvents(db, { limit: 9999 })).toHaveLength(5);
  });

  it('persists fileFingerprints as JSON array', () => {
    insertEvent(db, {
      eventType: 'PostToolUse',
      source: 'tool-trace',
      toolName: 'Edit',
      fileFingerprints: ['src/app.ts|42|1234|abc', 'src/db.ts|100|5678|def'],
    });
    const [event] = listEvents(db);
    expect(JSON.parse(event.file_fingerprints)).toEqual([
      'src/app.ts|42|1234|abc',
      'src/db.ts|100|5678|def',
    ]);
  });
});
