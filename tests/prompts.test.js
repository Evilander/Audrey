import { describe, it, expect } from 'vitest';
import {
  buildPrincipleExtractionPrompt,
  buildContradictionDetectionPrompt,
  buildCausalArticulationPrompt,
  buildContextResolutionPrompt,
} from '../src/prompts.js';

describe('buildPrincipleExtractionPrompt', () => {
  it('returns a messages array with system and user roles', () => {
    const episodes = [
      { content: 'Stripe returned 429 at 100 req/s', source: 'direct-observation', created_at: '2026-01-01T00:00:00Z', tags: '["stripe"]' },
      { content: 'Stripe returned 429 at 120 req/s', source: 'tool-result', created_at: '2026-01-02T00:00:00Z', tags: '["stripe"]' },
      { content: 'Stripe rate limit hit again', source: 'told-by-user', created_at: '2026-01-03T00:00:00Z', tags: null },
    ];
    const messages = buildPrincipleExtractionPrompt(episodes);

    expect(messages.length).toBe(2);
    expect(messages[0].role).toBe('system');
    expect(messages[0].content).toContain('principleExtraction');
    expect(messages[1].role).toBe('user');
    expect(messages[1].content).toContain('Stripe returned 429');
    expect(messages[1].content).toContain('direct-observation');
  });

  it('includes all episode contents in user message', () => {
    const episodes = [
      { content: 'Episode A', source: 'inference', created_at: '2026-01-01T00:00:00Z', tags: null },
      { content: 'Episode B', source: 'model-generated', created_at: '2026-01-02T00:00:00Z', tags: null },
    ];
    const messages = buildPrincipleExtractionPrompt(episodes);
    expect(messages[1].content).toContain('Episode A');
    expect(messages[1].content).toContain('Episode B');
  });
});

describe('buildContradictionDetectionPrompt', () => {
  it('returns messages array with both claims', () => {
    const messages = buildContradictionDetectionPrompt(
      'Rate limit is 100 req/s',
      'Rate limit is 25 req/s',
    );
    expect(messages.length).toBe(2);
    expect(messages[0].content).toContain('contradictionDetection');
    expect(messages[1].content).toContain('100 req/s');
    expect(messages[1].content).toContain('25 req/s');
  });
});

describe('buildCausalArticulationPrompt', () => {
  it('returns messages with cause and effect', () => {
    const cause = { content: 'Batch processing started', source: 'direct-observation' };
    const effect = { content: 'Rate limit hit', source: 'direct-observation' };
    const messages = buildCausalArticulationPrompt(cause, effect);
    expect(messages.length).toBe(2);
    expect(messages[0].content).toContain('causalArticulation');
    expect(messages[1].content).toContain('Batch processing started');
    expect(messages[1].content).toContain('Rate limit hit');
  });
});

describe('buildContextResolutionPrompt', () => {
  it('returns messages with both claims and context', () => {
    const messages = buildContextResolutionPrompt(
      'Limit is 100 req/s',
      'Limit is 25 req/s',
      'Testing different API key modes',
    );
    expect(messages.length).toBe(2);
    expect(messages[0].content).toContain('contextResolution');
    expect(messages[1].content).toContain('100 req/s');
    expect(messages[1].content).toContain('25 req/s');
    expect(messages[1].content).toContain('API key modes');
  });

  it('works without additional context', () => {
    const messages = buildContextResolutionPrompt(
      'Claim A', 'Claim B',
    );
    expect(messages.length).toBe(2);
    expect(messages[1].content).toContain('Claim A');
  });
});
