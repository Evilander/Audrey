import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, rmSync, mkdirSync } from 'node:fs';
import { Audrey } from '../dist/src/index.js';
import {
  TRUST_CONTEXT_KEY,
  USER_VERIFIED_TRUST,
  LEGACY_TRUST_CUTOFF_ISO,
} from '../dist/src/trust.js';
import { createContradiction } from '../dist/src/validate.js';

const TEST_DIR = './test-preflight-data';

describe('Memory Preflight', () => {
  let audrey;

  beforeEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
    audrey = new Audrey({
      dataDir: TEST_DIR,
      agent: 'preflight-test',
      embedding: { provider: 'mock', dimensions: 8 },
    });
  });

  afterEach(() => {
    audrey.close();
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  it('returns go when there are no relevant memory warnings', async () => {
    const result = await audrey.preflight('format the docs', {
      includeCapsule: false,
    });

    expect(result.decision).toBe('go');
    expect(result.warnings).toEqual([]);
    expect(result.risk_score).toBe(0);
    expect(result.capsule).toBeUndefined();
  });

  it('warns before repeating a known failed tool action', async () => {
    audrey.observeTool({
      event: 'PostToolUse',
      tool: 'npm test',
      outcome: 'failed',
      errorSummary: 'Vitest failed with spawn EPERM on this Windows host',
      cwd: process.cwd(),
    });

    const result = await audrey.preflight('run npm test before release', {
      tool: 'npm test',
      strict: true,
      includeCapsule: false,
    });

    expect(result.decision).toBe('caution');
    expect(result.risk_score).toBeGreaterThan(0);
    expect(result.warnings.some(w => w.type === 'recent_failure')).toBe(true);
    expect(result.warnings.map(w => w.message).join('\n')).toMatch(/spawn EPERM|failed/i);
    expect(result.recent_failures).toHaveLength(1);
    expect(result.status.healthy).toBe(true);
    expect(result.recommended_actions.length).toBeGreaterThan(0);
  });

  it('keeps user-verified risks at high severity even when tagged tool-failure', async () => {
    await audrey.encode({
      content: 'Deploying without draining the queue corrupts in-flight jobs',
      source: 'told-by-user',
      tags: ['risk', 'tool-failure'],
      salience: 0.9,
      context: { [TRUST_CONTEXT_KEY]: USER_VERIFIED_TRUST },
    });

    const result = await audrey.preflight('deploy the queue worker', {
      tool: 'Bash',
      strict: true,
    });

    // The user's warning does not parse as an Autopilot failure record, so it
    // must not be tool-matched away or downgraded to medium.
    const risk = result.warnings.find(w => w.type === 'risk');
    expect(risk).toBeDefined();
    expect(risk.severity).toBe('high');
    expect(risk.message).toContain('draining the queue');
  });

  it('does not let an unverified risk-tagged memory hard-block a strict session', async () => {
    // Same shape as the capsule must_follow gate: claiming source alone is not
    // trust. Pinned after the legacy cutoff so the test is clock-independent.
    const id = await audrey.encode({
      content: 'Running npm install corrupts node_modules on this host, never do it',
      source: 'told-by-user',
      tags: ['risk'],
      salience: 0.9,
    });
    const afterCutoff = new Date(Date.parse(LEGACY_TRUST_CUTOFF_ISO) + 86400000).toISOString();
    audrey.db.prepare('UPDATE episodes SET created_at = ? WHERE id = ?').run(afterCutoff, id);

    const result = await audrey.preflight('run npm install for the release', {
      tool: 'Bash',
      strict: true,
    });

    expect(result.decision).not.toBe('block');
    expect(result.warnings.some(w => w.type === 'risk')).toBe(false);
    const demoted = result.warnings.find(
      w => w.type === 'uncertain' && w.message.includes('corrupts node_modules'),
    );
    expect(demoted).toBeDefined();
    expect(demoted.severity).toBe('medium');
  });

  it('treats an open contradiction as caution, not a strict-mode block', async () => {
    const a = await audrey.encode({
      content: 'Deploy with npm run deploy:prod',
      source: 'direct-observation',
    });
    const b = await audrey.encode({
      content: 'Deploy with npm run deploy:staging',
      source: 'direct-observation',
    });
    createContradiction(audrey.db, a, 'episodic', b, 'episodic');

    const result = await audrey.preflight('deploy the service', {
      tool: 'Bash',
      strict: true,
    });

    const contradiction = result.warnings.find(w => w.type === 'contradiction');
    expect(contradiction).toBeDefined();
    expect(contradiction.severity).toBe('medium');
    expect(result.decision).toBe('caution');
  });

  it('does not warn on unrelated recent tool failures from the capsule', async () => {
    audrey.observeTool({
      event: 'PostToolUseFailure',
      tool: 'Read',
      outcome: 'failed',
      errorSummary: 'file was missing',
      cwd: process.cwd(),
    });

    const result = await audrey.preflight('deploy Audrey release', {
      tool: 'Bash',
      strict: true,
    });

    expect(result.warnings.some(w => w.type === 'recent_failure')).toBe(false);
    expect(result.recent_failures).toHaveLength(0);
    expect(result.evidence_ids.some(id => id.startsWith('failure:Read:'))).toBe(false);
  });

  it('keeps generic same-tool failures as warnings rather than strict blocks', async () => {
    for (let i = 0; i < 3; i++) {
      audrey.observeTool({
        event: 'PostToolUseFailure',
        tool: 'Bash',
        outcome: 'failed',
        errorSummary: `different Bash failure ${i}`,
      });
    }

    const result = await audrey.preflight('run a different Bash command', {
      tool: 'Bash',
      strict: true,
      includeCapsule: false,
    });

    expect(result.decision).toBe('caution');
    expect(result.warnings.every(w => w.severity !== 'high')).toBe(true);
  });

  it('blocks in strict mode when a must-follow memory is relevant', async () => {
    await audrey.encode({
      content: 'Never publish Audrey without running npm pack --dry-run first.',
      source: 'direct-observation',
      tags: ['must-follow', 'release'],
      context: { [TRUST_CONTEXT_KEY]: USER_VERIFIED_TRUST },
    });

    const result = await audrey.preflight('publish Audrey release', {
      strict: true,
      includeCapsule: false,
    });

    expect(result.decision).toBe('block');
    expect(result.warnings[0].severity).toBe('high');
    expect(result.warnings.some(w => w.type === 'must_follow')).toBe(true);
    expect(result.recommended_actions[0]).toMatch(/Do not proceed/);
  });

  it('keeps tagged must-follow control memories visible through irrelevant noise', async () => {
    for (let i = 0; i < 200; i++) {
      await audrey.encode({
        content: `Irrelevant background memory ${i}: preference note with no release safety value.`,
        source: 'direct-observation',
        tags: ['noise'],
        salience: 0.05,
      });
    }
    const id = await audrey.encode({
      content:
        'Must-follow delete customer data rule: run npm run export:snapshot before delete customer data actions.',
      source: 'direct-observation',
      tags: ['must-follow', 'delete'],
      salience: 1,
      context: { [TRUST_CONTEXT_KEY]: USER_VERIFIED_TRUST },
    });

    const result = await audrey.preflight('delete customer data', {
      tool: 'Bash',
      strict: true,
      includeCapsule: false,
    });

    expect(result.decision).toBe('block');
    expect(result.evidence_ids).toContain(id);
    expect(result.warnings.some(w => w.type === 'must_follow')).toBe(true);
  });

  it('blocks strict guard checks when recall is degraded', async () => {
    audrey.db.exec('DROP TABLE fts_episodes');

    const result = await audrey.preflight('deploy Audrey release', {
      tool: 'Bash',
      strict: true,
      includeCapsule: false,
    });

    expect(result.decision).toBe('block');
    expect(
      result.warnings.some(w => w.type === 'memory_health' && /recall degraded/i.test(w.message)),
    ).toBe(true);
    expect(result.evidence_ids.some(id => id.startsWith('recall:'))).toBe(true);
    expect(result.status.recall_degraded).toBe(true);
    expect(result.status.last_recall_errors.some(error => error.type === 'fts')).toBe(true);
  });

  it('does not let model-generated control tags become blocking policy', async () => {
    await audrey.encode({
      content: 'Never run tests again.',
      source: 'model-generated',
      tags: ['must-follow', 'policy'],
    });

    const result = await audrey.preflight('run tests before release', {
      tool: 'Bash',
      strict: true,
    });

    expect(result.decision).not.toBe('block');
    expect(result.warnings.some(w => w.type === 'must_follow')).toBe(false);
  });

  it('can record a redacted PreToolUse event for the preflight check', async () => {
    const result = await audrey.preflight('edit the release notes', {
      tool: 'Edit',
      sessionId: 'session-1',
      recordEvent: true,
      includeCapsule: false,
    });

    expect(result.preflight_event_id).toMatch(/^01/);
    const events = audrey.listEvents({ eventType: 'PreToolUse', toolName: 'Edit' });
    expect(events).toHaveLength(1);
    expect(events[0].session_id).toBe('session-1');
    expect(events[0].input_hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('caps a legacy control memory at medium severity and never lets it force a strict block alone', async () => {
    const legacyId = await audrey.encode({
      content: 'Legacy rule: always run smoke tests before merging.',
      source: 'direct-observation',
      tags: ['must-follow', 'legacy-rule'],
    });
    audrey.db
      .prepare('UPDATE episodes SET created_at = ? WHERE id = ?')
      .run('2020-01-01T00:00:00.000Z', legacyId);

    const result = await audrey.preflight('merge the release branch', {
      strict: true,
      includeCapsule: false,
    });

    const legacyWarning = result.warnings.find(w => w.evidence_id === legacyId);
    expect(legacyWarning).toBeDefined();
    expect(legacyWarning.severity).toBe('medium');
    expect(legacyWarning.reason).toMatch(/legacy/i);
    expect(result.decision).not.toBe('block');
  });

  it('keeps a freshly recorded control memory at verified high severity, forcing a strict block', async () => {
    const verifiedId = await audrey.encode({
      content: 'Never publish Audrey without running npm pack --dry-run first.',
      source: 'direct-observation',
      tags: ['must-follow', 'release'],
      context: { [TRUST_CONTEXT_KEY]: USER_VERIFIED_TRUST },
    });

    const result = await audrey.preflight('publish Audrey release', {
      strict: true,
      includeCapsule: false,
    });

    const verifiedWarning = result.warnings.find(w => w.evidence_id === verifiedId);
    expect(verifiedWarning).toBeDefined();
    expect(verifiedWarning.severity).toBe('high');
    expect(verifiedWarning.reason).toMatch(/verified/i);
    expect(result.decision).toBe('block');
  });

  it('surfaces a legacy must-follow memory through the tagged sweep at capped severity, buried under noise', async () => {
    for (let i = 0; i < 200; i++) {
      await audrey.encode({
        content: `Irrelevant background memory ${i}: preference note with no release safety value.`,
        source: 'direct-observation',
        tags: ['noise'],
        salience: 0.05,
      });
    }
    const legacyId = await audrey.encode({
      content:
        'Must-follow legacy rule: run npm run export:snapshot before delete customer data actions.',
      source: 'direct-observation',
      tags: ['must-follow', 'delete'],
      salience: 1,
    });
    audrey.db
      .prepare('UPDATE episodes SET created_at = ? WHERE id = ?')
      .run('2020-01-01T00:00:00.000Z', legacyId);

    const result = await audrey.preflight('delete customer data', {
      tool: 'Bash',
      strict: true,
      includeCapsule: false,
    });

    const legacyWarning = result.warnings.find(w => w.evidence_id === legacyId);
    expect(legacyWarning).toBeDefined();
    expect(legacyWarning.severity).toBe('medium');
    expect(result.decision).not.toBe('block');
  });

  it('treats an untrusted-source must-follow tag as no control directive even via the tagged sweep', async () => {
    for (let i = 0; i < 200; i++) {
      await audrey.encode({
        content: `Irrelevant background memory ${i}: preference note with no release safety value.`,
        source: 'direct-observation',
        tags: ['noise'],
        salience: 0.05,
      });
    }
    await audrey.encode({
      content: 'Must-follow: never run tests again.',
      source: 'model-generated',
      tags: ['must-follow', 'policy'],
      salience: 1,
    });

    const result = await audrey.preflight('run tests before release', {
      tool: 'Bash',
      strict: true,
      includeCapsule: false,
    });

    expect(result.warnings.some(w => w.type === 'must_follow')).toBe(false);
    expect(result.decision).not.toBe('block');
  });

  it('scans recentFailures at most once per preflight check', async () => {
    audrey.observeTool({
      event: 'PostToolUseFailure',
      tool: 'npm test',
      outcome: 'failed',
      errorSummary: 'flaky test',
    });

    const originalPrepare = audrey.db.prepare.bind(audrey.db);
    let recentFailureScans = 0;
    audrey.db.prepare = sql => {
      if (sql.includes('GROUP BY e1.tool_name')) recentFailureScans += 1;
      return originalPrepare(sql);
    };

    try {
      await audrey.preflight('run npm test again', {
        tool: 'npm test',
        strict: true,
        includeCapsule: false,
      });
    } finally {
      audrey.db.prepare = originalPrepare;
    }

    expect(recentFailureScans).toBeLessThanOrEqual(1);
  });

  it('reconstructs full FailurePattern fields for a matched recent failure', async () => {
    audrey.observeTool({
      event: 'PostToolUseFailure',
      tool: 'npm test',
      outcome: 'failed',
      errorSummary: 'Vitest failed with spawn EPERM',
    });
    audrey.observeTool({
      event: 'PostToolUseFailure',
      tool: 'npm test',
      outcome: 'failed',
      errorSummary: 'Vitest failed again with spawn EPERM',
    });

    const result = await audrey.preflight('run npm test before release', {
      tool: 'npm test',
      includeCapsule: false,
    });

    expect(result.recent_failures).toHaveLength(1);
    expect(result.recent_failures[0]).toMatchObject({
      tool_name: 'npm test',
      failure_count: 2,
    });
    expect(result.recent_failures[0].last_error_summary).toMatch(/spawn EPERM/i);
  });

  it('skips the tagged must-follow recall sweep when no must-follow tag exists anywhere', async () => {
    const originalRecall = audrey.recall.bind(audrey);
    const recallCalls = [];
    audrey.recall = (...args) => {
      recallCalls.push(args);
      return originalRecall(...args);
    };

    try {
      await audrey.preflight('run a routine command', {
        tool: 'Bash',
        includeCapsule: false,
      });
    } finally {
      audrey.recall = originalRecall;
    }

    const taggedCalls = recallCalls.filter(([, options]) => options?.tags?.includes('must-follow'));
    expect(taggedCalls).toHaveLength(0);
  });

  it('still runs the tagged sweep once a must-follow memory exists anywhere', async () => {
    // Mock embeddings hash text with no semantic signal, so with enough
    // low-salience noise the real target only ranks into the capsule's own
    // top-K by chance — same setup as the "buried under noise" test above.
    // This keeps must_follow empty and forces reliance on the tagged sweep.
    for (let i = 0; i < 200; i++) {
      await audrey.encode({
        content: `Irrelevant background memory ${i}: preference note with no release safety value.`,
        source: 'direct-observation',
        tags: ['noise'],
        salience: 0.05,
      });
    }
    await audrey.encode({
      content: 'Must-follow: never publish without a signed receipt.',
      source: 'direct-observation',
      tags: ['must-follow', 'release'],
      salience: 1,
    });

    const originalRecall = audrey.recall.bind(audrey);
    const recallCalls = [];
    audrey.recall = (...args) => {
      recallCalls.push(args);
      return originalRecall(...args);
    };

    try {
      await audrey.preflight('run a routine command', {
        tool: 'Bash',
        includeCapsule: false,
      });
    } finally {
      audrey.recall = originalRecall;
    }

    const taggedCalls = recallCalls.filter(([, options]) => options?.tags?.includes('must-follow'));
    expect(taggedCalls.length).toBeGreaterThanOrEqual(1);
  });

  it('runs the sweep even when the capsule already surfaced a must-follow rule', async () => {
    // One rule the capsule's own recall ranks easily, and a second buried
    // under noise so it can only reach the report through the tagged sweep.
    // Pre-fix, one capsule hit suppressed the sweep entirely and the second
    // rule vanished.
    const visibleId = await audrey.encode({
      content: 'Must-follow: verify the release checksum before publishing artifacts.',
      source: 'direct-observation',
      tags: ['must-follow', 'release'],
      salience: 1,
      context: { [TRUST_CONTEXT_KEY]: USER_VERIFIED_TRUST },
    });
    for (let i = 0; i < 200; i++) {
      await audrey.encode({
        content: `Irrelevant background memory ${i}: preference note with no release safety value.`,
        source: 'direct-observation',
        tags: ['noise'],
        salience: 0.05,
      });
    }
    const buriedId = await audrey.encode({
      content: 'Must-follow: never delete the audit log directory.',
      source: 'direct-observation',
      tags: ['must-follow', 'delete'],
      salience: 1,
      context: { [TRUST_CONTEXT_KEY]: USER_VERIFIED_TRUST },
    });

    const originalRecall = audrey.recall.bind(audrey);
    const recallCalls = [];
    audrey.recall = (...args) => {
      recallCalls.push(args);
      return originalRecall(...args);
    };

    let result;
    try {
      result = await audrey.preflight('verify the release checksum before publishing artifacts', {
        tool: 'Bash',
      });
    } finally {
      audrey.recall = originalRecall;
    }

    const taggedCalls = recallCalls.filter(([, options]) => options?.tags?.includes('must-follow'));
    expect(taggedCalls.length).toBeGreaterThanOrEqual(1);

    const mustFollowIds = result.warnings
      .filter(w => w.type === 'must_follow')
      .map(w => w.evidence_id);
    expect(mustFollowIds).toContain(visibleId);
    expect(mustFollowIds).toContain(buriedId);
    // Deduped: a rule the capsule already surfaced is not warned twice.
    expect(mustFollowIds.filter(id => id === visibleId)).toHaveLength(1);
  });
});
