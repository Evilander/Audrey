import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { assertBenchmarkGuardrails, runBenchmarkCli, runBenchmarkSuite } from '../benchmarks/run.js';
import { resolveAudreyVersion } from '../benchmarks/perf-snapshot.js';

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
  it('resolves package version for direct perf snapshots', () => {
    const previous = process.env.npm_package_version;
    delete process.env.npm_package_version;

    try {
      const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
      expect(resolveAudreyVersion()).toBe(pkg.version);
    } finally {
      if (previous === undefined) {
        delete process.env.npm_package_version;
      } else {
        process.env.npm_package_version = previous;
      }
    }
  });

  it('produces local and published benchmark summaries', async () => {
    const summary = await runBenchmarkSuite({ provider: 'mock', dimensions: 64 });

    expect(summary.local.overall.length).toBeGreaterThanOrEqual(4);
    expect(summary.local.overall[0].system).toBe('Audrey');
    expect(summary.local.overall_scope).toBe('comparable_suites');
    expect(summary.local.overall_suite_ids).toEqual(['retrieval', 'operations']);
    expect(summary.local.suites.map(suite => suite.id)).toEqual(['retrieval', 'operations', 'guard']);
    expect(summary.external.leaderboard[0].system).toBe('MIRIX');
    expect(summary.local.cases.some(testCase => testCase.id === 'procedural-learning')).toBe(true);
    expect(summary.local.cases.some(testCase => testCase.id === 'operation-semantic-merge')).toBe(true);
    expect(summary.local.cases.some(testCase => testCase.id === 'guard-recent-tool-failure')).toBe(true);
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
    expect(artifacts.suiteCharts.some(chart => chart.id === 'operations')).toBe(true);
    expect(lines.join('\n')).toContain('Audrey benchmark complete.');
    expect(lines.join('\n')).toContain('Scope: comparable_suites');
    expect(lines.join('\n')).toMatch(/Cases: \d+ total/);
  });

  it('writes committed README chart assets when requested', async () => {
    const { artifacts } = await runBenchmarkCli({
      argv: ['--out-dir', OUTPUT_DIR, '--readme-assets-dir', `${OUTPUT_DIR}/readme-assets`],
      out: () => {},
    });

    expect(existsSync(artifacts.readmeAssets.localChart)).toBe(true);
    expect(existsSync(artifacts.readmeAssets.operationsChart)).toBe(true);
    expect(existsSync(artifacts.readmeAssets.externalChart)).toBe(true);
  });

  it('can run only the operations suite', async () => {
    const summary = await runBenchmarkSuite({ provider: 'mock', dimensions: 64, suite: 'operations' });

    expect(summary.config.suites).toEqual(['operations']);
    expect(summary.local.suites).toHaveLength(1);
    expect(summary.local.suites[0].id).toBe('operations');
    expect(summary.local.cases.every(testCase => testCase.suite === 'operations')).toBe(true);
  });

  it('scores the Audrey Guard closed-loop controller as its own benchmark suite', async () => {
    const summary = await runBenchmarkSuite({ provider: 'mock', dimensions: 64, suite: 'guard' });

    expect(summary.config.suites).toEqual(['guard']);
    expect(summary.local.overall_scope).toBe('selected_suites');
    expect(summary.local.overall_suite_ids).toEqual(['guard']);
    expect(summary.local.suites).toHaveLength(1);
    expect(summary.local.suites[0].id).toBe('guard');
    expect(summary.local.cases.map(testCase => testCase.id)).toEqual([
      'guard-recent-tool-failure',
      'guard-strict-must-follow',
      'guard-rejects-replayed-outcome',
      'guard-rejects-non-guard-receipt',
    ]);

    const audrey = summary.local.overall.find(row => row.system === 'Audrey');
    expect(audrey?.scorePercent).toBe(100);
    expect(audrey?.passRate).toBe(100);

    const strongestBaseline = summary.local.overall.find(row => row.system !== 'Audrey');
    expect(strongestBaseline?.scorePercent).toBe(0);

    for (const caseResult of summary.local.cases) {
      const audreyResult = caseResult.results.find(result => result.system === 'Audrey');
      expect(audreyResult?.passed).toBe(true);
      const topResults = audreyResult?.topResults.join('\n') ?? '';
      if (caseResult.id.includes('rejects')) {
        expect(topResults).toContain('guard_hardened:');
      } else {
        expect(topResults).toMatch(/decision:(caution|block)/);
        expect(topResults).toMatch(/reflex:(warn|block)/);
      }
    }
  });

  it('enforces benchmark regression guardrails', async () => {
    const summary = await runBenchmarkSuite({ provider: 'mock', dimensions: 64 });

    expect(() => assertBenchmarkGuardrails(summary)).not.toThrow();
    expect(() => assertBenchmarkGuardrails(summary, { minAudreyScore: 101 })).toThrow(/Benchmark regression gate failed/);
  });
});
