import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, rmSync, mkdirSync } from 'node:fs';
import { Audrey } from '../dist/src/index.js';

const TEST_DIR = './test-reflexes-data';

describe('Memory Reflexes', () => {
  let audrey;

  beforeEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
    audrey = new Audrey({
      dataDir: TEST_DIR,
      agent: 'reflex-test',
      embedding: { provider: 'mock', dimensions: 8 },
    });
  });

  afterEach(() => {
    audrey.close();
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  it('turns a repeated tool failure into a warning reflex', async () => {
    audrey.observeTool({
      event: 'PostToolUse',
      tool: 'npm test',
      outcome: 'failed',
      errorSummary: 'Vitest failed with spawn EPERM on this Windows host',
      cwd: process.cwd(),
    });

    const report = await audrey.reflexes('run npm test before release', {
      tool: 'npm test',
    });

    expect(report.decision).toBe('caution');
    expect(report.summary).toMatch(/memory reflex/i);
    expect(report.reflexes).toHaveLength(1);
    expect(report.reflexes[0].response_type).toBe('warn');
    expect(report.reflexes[0].trigger).toBe('Before using npm test');
    expect(report.reflexes[0].source).toBe('recent_failure');
    expect(report.preflight).toBeUndefined();
  });

  it('can include the underlying preflight report for explainability', async () => {
    await audrey.encode({
      content: 'Never deploy Audrey without checking the package tarball first.',
      source: 'direct-observation',
      tags: ['must-follow', 'release'],
    });

    const report = await audrey.reflexes('deploy Audrey release', {
      strict: true,
      includePreflight: true,
    });

    expect(report.decision).toBe('block');
    expect(report.reflexes.some(r => r.response_type === 'block')).toBe(true);
    expect(report.preflight.decision).toBe('block');
    expect(report.evidence_ids.length).toBeGreaterThan(0);
  });
});
