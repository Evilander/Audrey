import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Audrey } from '../dist/src/index.js';
import { createContradiction } from '../dist/src/validate.js';
import { recentFailures } from '../dist/src/events.js';

async function insertSemantic(brain, id, content, agent) {
  const vector = await brain.embeddingProvider.embed(content);
  const buffer = brain.embeddingProvider.vectorToBuffer(vector);
  brain.db
    .prepare(
      `
    INSERT INTO semantics (
      id, content, agent, embedding, state, evidence_episode_ids,
      evidence_count, supporting_count, source_type_diversity,
      created_at, interference_count, salience
    ) VALUES (?, ?, ?, ?, 'active', '[]', 1, 1, 1, ?, 0, 0.5)
  `,
    )
    .run(id, content, agent, buffer, new Date().toISOString());
  brain.db
    .prepare('INSERT INTO vec_semantics(id, agent, embedding, state) VALUES (?, ?, ?, ?)')
    .run(id, agent, buffer, 'active');
}

function insertEpisode(brain, id, content, agent) {
  brain.db
    .prepare(
      `
    INSERT INTO episodes (
      id, content, source, agent, source_reliability, created_at
    ) VALUES (?, ?, 'direct-observation', ?, 0.95, ?)
  `,
    )
    .run(id, content, agent, new Date().toISOString());
}

function insertProcedure(brain, id, content, agent) {
  brain.db
    .prepare(
      `
    INSERT INTO procedures (
      id, content, agent, state, success_count, failure_count,
      retrieval_count, salience, created_at
    ) VALUES (?, ?, ?, 'active', 3, 0, 2, 0.8, ?)
  `,
    )
    .run(id, content, agent, new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString());
}

describe('shared-store agent isolation', () => {
  let dataDir;
  let alpha;
  let beta;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'audrey-agent-isolation-'));
    alpha = new Audrey({
      dataDir,
      agent: 'agent-alpha',
      embedding: { provider: 'mock', dimensions: 8 },
    });
    beta = new Audrey({
      dataDir,
      agent: 'agent-beta',
      embedding: { provider: 'mock', dimensions: 8 },
    });
  });

  afterEach(async () => {
    await alpha.closeAsync();
    await beta.closeAsync();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('keeps post-encode reinforcement and interference within the episode agent', async () => {
    const content = 'Deploy only after the release verification gate passes';
    await insertSemantic(alpha, 'sem-alpha', content, 'agent-alpha');
    await insertSemantic(beta, 'sem-beta', content, 'agent-beta');

    await alpha.encode({
      content,
      source: 'direct-observation',
      waitForConsolidation: true,
    });

    const alphaRow = alpha.db
      .prepare(
        `
      SELECT supporting_count, interference_count
      FROM semantics WHERE id = 'sem-alpha'
    `,
      )
      .get();
    const betaRow = beta.db
      .prepare(
        `
      SELECT supporting_count, interference_count
      FROM semantics WHERE id = 'sem-beta'
    `,
      )
      .get();

    expect(alphaRow).toMatchObject({ supporting_count: 2, interference_count: 1 });
    expect(betaRow).toMatchObject({ supporting_count: 1, interference_count: 0 });
  });

  it('does not emit resonance from another agent episode', async () => {
    const content = 'A frustrating deployment rollback failed at the final step';
    await beta.encode({
      content,
      source: 'direct-observation',
      affect: { valence: -0.8, arousal: 0.9 },
      waitForConsolidation: true,
    });

    const resonanceEvents = [];
    alpha.on('resonance', event => resonanceEvents.push(event));
    await alpha.encode({
      content,
      source: 'direct-observation',
      affect: { valence: -0.8, arousal: 0.9 },
      waitForConsolidation: true,
    });

    expect(resonanceEvents).toEqual([]);
  });

  it('scopes recent failures by actor and exposes them only in shared capsules', async () => {
    beta.observeTool({
      event: 'PostToolUseFailure',
      tool: 'Bash',
      outcome: 'failed',
      errorSummary: 'beta-only deploy failure',
    });

    expect(recentFailures(alpha.db, { actorAgent: 'agent-alpha' })).toEqual([]);
    expect(recentFailures(beta.db, { actorAgent: 'agent-beta' })).toHaveLength(1);

    const alphaCapsule = await alpha.capsule('deploy');
    const betaCapsule = await beta.capsule('deploy');
    const sharedCapsule = await alpha.capsule('deploy', { scope: 'shared' });
    const sharedPreflight = await alpha.preflight('deploy with Bash', {
      scope: 'shared',
      tool: 'Bash',
    });

    expect(alphaCapsule.sections.risks).toEqual([]);
    expect(betaCapsule.sections.risks).toHaveLength(1);
    expect(sharedCapsule.sections.risks).toHaveLength(1);
    expect(sharedCapsule.sections.risks[0].content).toContain('beta-only deploy failure');
    expect(sharedPreflight.recent_failures).toHaveLength(1);
  });

  it('shows only complete same-agent contradictions for the requested scope', async () => {
    await insertSemantic(beta, 'sem-beta-claim', 'Beta deployment policy', 'agent-beta');
    insertEpisode(beta, 'ep-beta-claim', 'Beta deployment exception', 'agent-beta');
    insertEpisode(alpha, 'ep-alpha-claim', 'Alpha deployment exception', 'agent-alpha');

    const betaContradiction = createContradiction(
      beta.db,
      'sem-beta-claim',
      'semantic',
      'ep-beta-claim',
      'episodic',
    );
    const crossAgentContradiction = createContradiction(
      beta.db,
      'sem-beta-claim',
      'semantic',
      'ep-alpha-claim',
      'episodic',
    );
    const orphanContradiction = createContradiction(
      beta.db,
      'sem-beta-claim',
      'semantic',
      'missing-legacy-claim',
      'episodic',
    );

    const alphaCapsule = await alpha.capsule('deployment policy');
    const betaCapsule = await beta.capsule('deployment policy');
    const sharedCapsule = await alpha.capsule('deployment policy', { scope: 'shared' });

    expect(alphaCapsule.sections.contradictions).toEqual([]);
    expect(betaCapsule.sections.contradictions.map(entry => entry.memory_id)).toEqual([
      betaContradiction,
    ]);
    expect(sharedCapsule.sections.contradictions.map(entry => entry.memory_id)).toContain(
      betaContradiction,
    );
    expect(sharedCapsule.sections.contradictions.map(entry => entry.memory_id)).not.toContain(
      crossAgentContradiction,
    );
    expect(sharedCapsule.sections.contradictions.map(entry => entry.memory_id)).not.toContain(
      orphanContradiction,
    );
  });

  it('does not promote another agent memory into project rules', () => {
    insertProcedure(alpha, 'proc-alpha', 'Run alpha release checks before deploy', 'agent-alpha');
    insertProcedure(beta, 'proc-beta', 'Run beta emergency rollout procedure', 'agent-beta');

    expect(
      alpha.findPromotionCandidates({ minEvidence: 2 }).map(candidate => candidate.memory_id),
    ).toEqual(['proc-alpha']);
    expect(
      beta.findPromotionCandidates({ minEvidence: 2 }).map(candidate => candidate.memory_id),
    ).toEqual(['proc-beta']);
  });

  it('rejects blank ownership instead of falling back to an unscoped query', async () => {
    expect(
      () =>
        new Audrey({
          dataDir,
          agent: '   ',
          embedding: { provider: 'mock', dimensions: 8 },
        }),
    ).toThrow(/agent must be a non-empty string/i);

    await expect(
      alpha.encode({
        content: 'blank owners are invalid',
        source: 'direct-observation',
        agent: '   ',
      }),
    ).rejects.toThrow(/agent must be a non-empty string/i);
  });

  it('keeps dream decay within the requested agent', async () => {
    await insertSemantic(alpha, 'sem-alpha-decay', 'Alpha aging principle', 'agent-alpha');
    await insertSemantic(beta, 'sem-beta-decay', 'Beta aging principle', 'agent-beta');

    await alpha.dream({ minClusterSize: 100, dormantThreshold: 1 });

    const alphaState = alpha.db
      .prepare("SELECT state FROM semantics WHERE id = 'sem-alpha-decay'")
      .get().state;
    const betaState = beta.db
      .prepare("SELECT state FROM semantics WHERE id = 'sem-beta-decay'")
      .get().state;
    expect(alphaState).toBe('dormant');
    expect(betaState).toBe('active');
  });

  it('does not resolve another agent contradiction', async () => {
    await insertSemantic(beta, 'sem-beta-resolution', 'Beta release policy', 'agent-beta');
    insertEpisode(beta, 'ep-beta-resolution', 'Beta release exception', 'agent-beta');
    const contradictionId = createContradiction(
      beta.db,
      'sem-beta-resolution',
      'semantic',
      'ep-beta-resolution',
      'episodic',
    );
    alpha.llmProvider = {
      json: async () => ({ resolution: 'a_wins', explanation: 'test' }),
    };

    await expect(alpha.resolveTruth(contradictionId)).rejects.toThrow(/contradiction not found/i);
    expect(
      alpha.db.prepare('SELECT state FROM contradictions WHERE id = ?').get(contradictionId).state,
    ).toBe('open');
  });
});
