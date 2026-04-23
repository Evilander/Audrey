import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Audrey } from '../dist/src/index.js';
import { existsSync, rmSync, mkdirSync } from 'node:fs';

const TEST_DIR = './test-capsule-data';

function allEntries(capsule) {
  return [
    ...capsule.sections.must_follow,
    ...capsule.sections.project_facts,
    ...capsule.sections.user_preferences,
    ...capsule.sections.procedures,
    ...capsule.sections.risks,
    ...capsule.sections.recent_changes,
    ...capsule.sections.contradictions,
    ...capsule.sections.uncertain_or_disputed,
  ];
}

describe('MemoryCapsule', () => {
  let audrey;

  beforeEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
    mkdirSync(TEST_DIR, { recursive: true });
    audrey = new Audrey({
      dataDir: TEST_DIR,
      agent: 'capsule-test',
      embedding: { provider: 'mock', dimensions: 8 },
    });
  });

  afterEach(() => {
    audrey.close();
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('returns a capsule with all nine sections present (possibly empty)', async () => {
    const capsule = await audrey.capsule('anything');
    expect(capsule.sections).toHaveProperty('must_follow');
    expect(capsule.sections).toHaveProperty('project_facts');
    expect(capsule.sections).toHaveProperty('user_preferences');
    expect(capsule.sections).toHaveProperty('procedures');
    expect(capsule.sections).toHaveProperty('risks');
    expect(capsule.sections).toHaveProperty('recent_changes');
    expect(capsule.sections).toHaveProperty('contradictions');
    expect(capsule.sections).toHaveProperty('uncertain_or_disputed');
    expect(capsule.evidence_ids).toEqual([]);
    expect(capsule.policy.mode).toBe('balanced');
    expect(typeof capsule.budget_chars).toBe('number');
    expect(capsule.generated_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('routes a tagged must-follow memory into must_follow', async () => {
    await audrey.encode({
      content: 'Never store secrets, PAN, or credentials in Audrey memory.',
      source: 'direct-observation',
      tags: ['must-follow', 'policy'],
    });
    const capsule = await audrey.capsule('secrets');
    expect(capsule.sections.must_follow).toHaveLength(1);
    expect(capsule.sections.must_follow[0].reason).toContain('must-follow');
    expect(capsule.sections.must_follow[0].tags).toContain('must-follow');
  });

  it('routes told-by-user preferences into user_preferences', async () => {
    await audrey.encode({
      content: 'User prefers local-first, auditable memory for Audrey.',
      source: 'told-by-user',
      tags: ['preference'],
    });
    const capsule = await audrey.capsule('how should memory work');
    expect(capsule.sections.user_preferences).toHaveLength(1);
    expect(capsule.sections.user_preferences[0].reason).toMatch(/user|preference/i);
  });

  it('routes recent-failure tool events into risks via memory_events', async () => {
    audrey.observeTool({
      event: 'PostToolUseFailure',
      tool: 'Bash',
      outcome: 'failed',
      errorSummary: 'Tests failed because sqlite extension was not loaded',
    });
    const capsule = await audrey.capsule('run npm test');
    const risk = capsule.sections.risks.find(r => r.memory_type === 'tool_failure');
    expect(risk).toBeDefined();
    expect(risk.content).toContain('Bash failed');
    expect(risk.recommended_action).toBeDefined();
  });

  it('routes procedural memories into procedures', async () => {
    await audrey.encode({
      content: 'Reproducing the flake requires running the suite twice in a row.',
      source: 'direct-observation',
      tags: ['procedure', 'testing'],
    });
    const capsule = await audrey.capsule('flaky test');
    const hit = allEntries(capsule).find(e => e.content.includes('flake'));
    expect(hit).toBeDefined();
    const allProcedures = capsule.sections.procedures;
    expect(allProcedures.some(e => e.content.includes('flake'))).toBe(true);
  });

  it('includes memories in recent_changes when inside the window', async () => {
    await audrey.encode({
      content: 'Benchmark target shifted from LongMemEval to LoCoMo this week.',
      source: 'direct-observation',
      tags: ['benchmark'],
    });
    const capsule = await audrey.capsule('benchmark');
    expect(capsule.sections.recent_changes.length).toBeGreaterThanOrEqual(1);
    const recent = capsule.sections.recent_changes[0];
    expect(recent.reason).toMatch(/recent/i);
  });

  it('respects the token budget and marks truncated=true when overflow occurs', async () => {
    // Encode many similar memories to produce a lot of candidates.
    const longText = 'An Audrey fact about Stripe payment processing that is deliberately long so each memory consumes many chars of the budget. '.repeat(6);
    for (let i = 0; i < 8; i++) {
      await audrey.encode({
        content: `${longText} — variant ${i}`,
        source: 'direct-observation',
        tags: ['stripe'],
      });
    }
    const small = await audrey.capsule('stripe', { budgetChars: 400 });
    expect(small.budget_chars).toBe(400);
    expect(small.used_chars).toBeLessThanOrEqual(400);
    expect(small.truncated).toBe(true);

    const large = await audrey.capsule('stripe', { budgetChars: 100000 });
    expect(large.truncated).toBe(false);
  });

  it('every entry carries an explainability reason', async () => {
    await audrey.encode({ content: 'Stripe API returns 429 when the rate limit is exceeded.', source: 'direct-observation', tags: ['stripe'] });
    await audrey.encode({ content: 'Always back up the DB before running a destructive migration.', source: 'direct-observation', tags: ['must-follow', 'migration'] });
    const capsule = await audrey.capsule('stripe migration');
    for (const entry of allEntries(capsule)) {
      expect(entry.reason).toBeTruthy();
      expect(entry.memory_id).toBeTruthy();
    }
  });

  it('honors include_risks=false and include_contradictions=false', async () => {
    audrey.observeTool({
      event: 'PostToolUseFailure',
      tool: 'Bash',
      outcome: 'failed',
      errorSummary: 'failed again',
    });
    const capsule = await audrey.capsule('test', { includeRisks: false, includeContradictions: false });
    expect(capsule.sections.risks).toHaveLength(0);
    expect(capsule.sections.contradictions).toHaveLength(0);
  });

  it('evidence_ids collects every referenced memory id', async () => {
    await audrey.encode({ content: 'Rule about rate limits', source: 'direct-observation', tags: ['must-follow'] });
    const capsule = await audrey.capsule('rate limits');
    expect(capsule.evidence_ids.length).toBeGreaterThan(0);
    expect(capsule.sections.must_follow[0]).toBeDefined();
    expect(capsule.evidence_ids).toContain(capsule.sections.must_follow[0].memory_id);
  });

  it('emits "capsule" event', async () => {
    const received = [];
    audrey.on('capsule', c => received.push(c));
    await audrey.capsule('anything');
    expect(received).toHaveLength(1);
    expect(received[0].query).toBe('anything');
  });
});
