import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, rmSync } from 'node:fs';
import { assertBenchmarkGuardrails, runBenchmarkCli, runBenchmarkSuite } from '../benchmarks/run.js';

const OUTPUT_DIR = './test-benchmark-output';

afterEach(() => {
  if (existsSync(OUTPUT_DIR)) {
    rmSync(OUTPUT_DIR, { recursive: true, force: true });
  }
  if (existsSync('./benchmarks/.tmp')) {
    rmSync('./benchmarks/.tmp', { recursive: true, force: true });
  }
});

describe('benchmark suite', () => {
  it('produces local and published benchmark summaries', async () => {
    const summary = await runBenchmarkSuite({ provider: 'mock', dimensions: 64 });

    expect(summary.local.overall.length).toBeGreaterThanOrEqual(4);
    expect(summary.local.overall[0].system).toBe('Audrey');
    expect(summary.external.leaderboard[0].system).toBe('MIRIX');
    expect(summary.local.cases.some(testCase => testCase.id === 'procedural-learning')).toBe(true);
  });

  it('writes JSON, HTML, and SVG artifacts', async () => {
    const lines = [];
    const { artifacts } = await runBenchmarkCli({
      argv: ['--out-dir', OUTPUT_DIR],
      out: line => lines.push(line),
    });

    expect(existsSync(artifacts.json)).toBe(true);
    expect(existsSync(artifacts.html)).toBe(true);
    expect(existsSync(artifacts.localChart)).toBe(true);
    expect(existsSync(artifacts.externalChart)).toBe(true);
    expect(lines.join('\n')).toContain('Audrey benchmark complete.');
  });

  it('writes committed README chart assets when requested', async () => {
    const { artifacts } = await runBenchmarkCli({
      argv: ['--out-dir', OUTPUT_DIR, '--readme-assets-dir', `${OUTPUT_DIR}/readme-assets`],
      out: () => {},
    });

    expect(existsSync(artifacts.readmeAssets.localChart)).toBe(true);
    expect(existsSync(artifacts.readmeAssets.externalChart)).toBe(true);
  });

  it('enforces benchmark regression guardrails', async () => {
    const summary = await runBenchmarkSuite({ provider: 'mock', dimensions: 64 });

    expect(() => assertBenchmarkGuardrails(summary)).not.toThrow();
    expect(() => assertBenchmarkGuardrails(summary, { minAudreyScore: 101 })).toThrow(/Benchmark regression gate failed/);
  });
});
