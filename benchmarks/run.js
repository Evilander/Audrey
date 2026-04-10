import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Audrey } from '../dist/src/audrey.js';
import { BENCHMARK_CASES, FAMILY_ORDER } from './cases.js';
import { runKeywordRecencyBaseline, runRecentWindowBaseline, runVectorOnlyBaseline } from './baselines.js';
import { MEMORY_TRENDS, PUBLISHED_LEADERBOARD } from './reference-results.js';
import { writeBenchmarkArtifacts } from './report.js';

function parseArgs(argv = process.argv.slice(2)) {
  const args = {
    provider: 'mock',
    dimensions: 64,
    outDir: resolve('benchmarks/output'),
    jsonOnly: false,
    check: false,
    minAudreyScore: 80,
    minAudreyPassRate: 75,
    minMarginOverBaseline: 15,
    readmeAssetsDir: null,
  };

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === '--provider' && argv[i + 1]) {
      args.provider = argv[++i];
      if (args.provider === 'local') args.dimensions = 384;
      if (args.provider === 'openai') args.dimensions = 1536;
      if (args.provider === 'gemini') args.dimensions = 3072;
    } else if (token === '--dimensions' && argv[i + 1]) {
      args.dimensions = Number.parseInt(argv[++i], 10);
    } else if (token === '--out-dir' && argv[i + 1]) {
      args.outDir = resolve(argv[++i]);
    } else if (token === '--json') {
      args.jsonOnly = true;
    } else if (token === '--check') {
      args.check = true;
    } else if (token === '--min-audrey-score' && argv[i + 1]) {
      args.minAudreyScore = Number.parseFloat(argv[++i]);
    } else if (token === '--min-audrey-pass-rate' && argv[i + 1]) {
      args.minAudreyPassRate = Number.parseFloat(argv[++i]);
    } else if (token === '--min-margin-over-baseline' && argv[i + 1]) {
      args.minMarginOverBaseline = Number.parseFloat(argv[++i]);
    } else if (token === '--readme-assets-dir' && argv[i + 1]) {
      args.readmeAssetsDir = resolve(argv[++i]);
    }
  }

  return args;
}

function normalize(text) {
  return String(text || '').toLowerCase();
}

function summarizeResults(results) {
  if (!results.length) return 'no retrieval';
  return results
    .slice(0, 2)
    .map(result => result.content.slice(0, 72))
    .join(' | ');
}

function evaluateCase(benchmarkCase, results) {
  const normalizedContents = results.map(result => normalize(result.content));
  const expected = (benchmarkCase.expectAny || []).map(normalize);
  const forbidden = (benchmarkCase.forbid || []).map(normalize);
  const firstMatchIndex = expected.length === 0
    ? -1
    : normalizedContents.findIndex(content => expected.some(expectation => content.includes(expectation)));
  const firstForbiddenIndex = normalizedContents.findIndex(content => forbidden.some(blocked => content.includes(blocked)));
  const matched = firstMatchIndex !== -1;
  const leakedForbidden = firstForbiddenIndex !== -1;

  if (benchmarkCase.expectNone) {
    const score = leakedForbidden ? 0 : results.length === 0 ? 1 : 0.5;
    return {
      passed: score === 1,
      score,
      summary: leakedForbidden ? 'leaked restricted content' : results.length === 0 ? 'correct abstention' : 'no leak, but retrieved tangential context',
    };
  }

  let score = 0;
  if (matched && !leakedForbidden) {
    score = 1;
  } else if (matched && leakedForbidden) {
    score = firstForbiddenIndex > firstMatchIndex ? 0.5 : 0;
  }

  return {
    passed: score === 1,
    score,
    summary: matched
      ? leakedForbidden
        ? firstForbiddenIndex > firstMatchIndex
          ? 'retrieved expected evidence, but conflicting evidence still appeared later'
          : 'blocked content outranked the correct answer'
        : 'retrieved expected evidence'
      : 'missed target evidence',
  };
}

async function seedCase(brain, benchmarkCase) {
  const ids = [];
  for (let index = 0; index < benchmarkCase.memory.length; index++) {
    const memory = benchmarkCase.memory[index];
    const supersedes = Number.isInteger(memory.supersedesIndex) ? ids[memory.supersedesIndex] : undefined;
    const id = await brain.encode({
      content: memory.content,
      source: memory.source,
      tags: memory.tags,
      context: memory.context,
      affect: memory.affect,
      private: memory.private,
      salience: memory.salience,
      supersedes,
    });

    if (memory.createdAt) {
      brain.db.prepare('UPDATE episodes SET created_at = ? WHERE id = ?').run(memory.createdAt, id);
    }

    ids.push(id);
  }

  if (benchmarkCase.consolidate) {
    await brain.consolidate({
      minClusterSize: benchmarkCase.consolidate.minClusterSize,
      similarityThreshold: benchmarkCase.consolidate.similarityThreshold,
      extractPrinciple: () => benchmarkCase.consolidate.principle,
    });
  }
}

async function runAudreyCase(benchmarkCase, providerConfig) {
  const tempRoot = resolve('benchmarks/.tmp');
  mkdirSync(tempRoot, { recursive: true });
  const tempDir = mkdtempSync(join(tempRoot, 'audrey-bench-'));
  const brain = new Audrey({
    dataDir: tempDir,
    agent: `benchmark-${benchmarkCase.id}`,
    embedding: providerConfig,
  });

  try {
    if (typeof brain.embeddingProvider.ready === 'function') {
      await brain.embeddingProvider.ready();
    }
    await seedCase(brain, benchmarkCase);
    return await brain.recall(benchmarkCase.query, {
      limit: 5,
      minConfidence: 0.05,
      ...benchmarkCase.options,
    });
  } finally {
    brain.close();
    rmSync(tempDir, { recursive: true, force: true });
  }
}

async function runSystemsForCase(benchmarkCase, providerConfig) {
  const systems = [
    { system: 'Audrey', run: () => runAudreyCase(benchmarkCase, providerConfig) },
    { system: 'Vector Only', run: () => runVectorOnlyBaseline(benchmarkCase, providerConfig) },
    { system: 'Keyword + Recency', run: () => Promise.resolve(runKeywordRecencyBaseline(benchmarkCase)) },
    { system: 'Recent Window', run: () => Promise.resolve(runRecentWindowBaseline(benchmarkCase)) },
  ];

  const results = [];
  for (const system of systems) {
    const started = Date.now();
    const items = await system.run();
    const evaluation = evaluateCase(benchmarkCase, items);
    results.push({
      system: system.system,
      durationMs: Date.now() - started,
      passed: evaluation.passed,
      score: evaluation.score,
      summary: evaluation.summary,
      topResults: items.slice(0, 3).map(item => item.content),
      retrievalSummary: summarizeResults(items),
    });
  }

  return results;
}

function summarizeLocalResults(caseResults) {
  const systems = new Map();
  for (const caseResult of caseResults) {
    for (const result of caseResult.results) {
      if (!systems.has(result.system)) {
        systems.set(result.system, {
          system: result.system,
          totalScore: 0,
          passCount: 0,
          totalCases: 0,
          durationMs: 0,
        });
      }
      const summary = systems.get(result.system);
      summary.totalScore += result.score;
      summary.passCount += result.passed ? 1 : 0;
      summary.totalCases += 1;
      summary.durationMs += result.durationMs;
    }
  }

  return [...systems.values()]
    .map(system => ({
      system: system.system,
      scorePercent: (system.totalScore / system.totalCases) * 100,
      passRate: (system.passCount / system.totalCases) * 100,
      avgDurationMs: system.durationMs / system.totalCases,
    }))
    .sort((a, b) => b.scorePercent - a.scorePercent);
}

function summarizeByFamily(caseResults) {
  const families = new Map();
  for (const family of FAMILY_ORDER) {
    families.set(family, { family, systems: {} });
  }

  for (const caseResult of caseResults) {
    const entry = families.get(caseResult.family) || { family: caseResult.family, systems: {} };
    for (const result of caseResult.results) {
      entry.systems[result.system] = result.score;
    }
    families.set(caseResult.family, entry);
  }

  return [...families.values()];
}

export function assertBenchmarkGuardrails(summary, options = {}) {
  const settings = {
    minAudreyScore: options.minAudreyScore ?? 80,
    minAudreyPassRate: options.minAudreyPassRate ?? 75,
    minMarginOverBaseline: options.minMarginOverBaseline ?? 15,
  };
  const audrey = summary.local.overall.find(row => row.system === 'Audrey');
  if (!audrey) {
    throw new Error('Audrey results were missing from the local benchmark summary.');
  }

  const strongestBaseline = summary.local.overall
    .filter(row => row.system !== 'Audrey')
    .sort((a, b) => b.scorePercent - a.scorePercent)[0];
  const failures = [];

  if (audrey.scorePercent < settings.minAudreyScore) {
    failures.push(
      `Audrey score ${audrey.scorePercent.toFixed(1)}% fell below ${settings.minAudreyScore.toFixed(1)}%.`
    );
  }

  if (audrey.passRate < settings.minAudreyPassRate) {
    failures.push(
      `Audrey pass rate ${audrey.passRate.toFixed(1)}% fell below ${settings.minAudreyPassRate.toFixed(1)}%.`
    );
  }

  if (strongestBaseline) {
    const margin = audrey.scorePercent - strongestBaseline.scorePercent;
    if (margin < settings.minMarginOverBaseline) {
      failures.push(
        `Audrey beat ${strongestBaseline.system} by ${margin.toFixed(1)} points, below the required `
        + `${settings.minMarginOverBaseline.toFixed(1)}-point margin.`
      );
    }
  }

  if (failures.length) {
    throw new Error(`Benchmark regression gate failed:\n- ${failures.join('\n- ')}`);
  }

  return {
    audrey,
    strongestBaseline,
    marginOverBaseline: strongestBaseline ? audrey.scorePercent - strongestBaseline.scorePercent : null,
    thresholds: settings,
  };
}

export async function runBenchmarkSuite(options = {}) {
  const providerConfig = {
    provider: options.provider || 'mock',
    dimensions: options.dimensions || 64,
  };

  const caseResults = [];
  for (const benchmarkCase of BENCHMARK_CASES) {
    const results = await runSystemsForCase(benchmarkCase, providerConfig);
    caseResults.push({
      id: benchmarkCase.id,
      title: benchmarkCase.title,
      family: benchmarkCase.family,
      description: benchmarkCase.description,
      query: benchmarkCase.query,
      results,
    });
  }

  const localOverall = summarizeLocalResults(caseResults);
  const localByFamily = summarizeByFamily(caseResults);

  return {
    generatedAt: new Date().toISOString(),
    command: `node benchmarks/run.js --provider ${providerConfig.provider} --dimensions ${providerConfig.dimensions}`,
    config: providerConfig,
    methodology: {
      localBenchmark: 'LongMemEval-inspired synthetic capability suite plus privacy and abstention checks',
      externalLeaderboard: 'Published LoCoMo scores from official papers and project blogs',
    },
    local: {
      overall: localOverall,
      byFamily: localByFamily,
      cases: caseResults,
    },
    external: {
      benchmark: 'LoCoMo',
      leaderboard: [...PUBLISHED_LEADERBOARD].sort((a, b) => b.score - a.score),
    },
    trends: MEMORY_TRENDS,
  };
}

export async function runBenchmarkCli({ argv = process.argv.slice(2), out = console.log } = {}) {
  const args = parseArgs(argv);
  const summary = await runBenchmarkSuite(args);
  const artifacts = writeBenchmarkArtifacts({
    outputDir: args.outDir,
    summary,
    localOverall: summary.local.overall,
    externalOverall: summary.external.leaderboard,
    trends: summary.trends,
    readmeAssetsDir: args.readmeAssetsDir,
  });
  const gate = args.check
    ? assertBenchmarkGuardrails(summary, {
      minAudreyScore: args.minAudreyScore,
      minAudreyPassRate: args.minAudreyPassRate,
      minMarginOverBaseline: args.minMarginOverBaseline,
    })
    : null;

  if (args.jsonOnly) {
    out(JSON.stringify({ summary, artifacts, gate }, null, 2));
    return { summary, artifacts, gate };
  }

  const lines = [];
  lines.push('Audrey benchmark complete.');
  lines.push('');
  for (const row of summary.local.overall) {
    lines.push(
      `${row.system}: ${row.scorePercent.toFixed(1)}% score, ${row.passRate.toFixed(1)}% pass rate, `
      + `${row.avgDurationMs.toFixed(1)} ms avg/case`
    );
  }
  lines.push('');
  lines.push(`JSON report: ${artifacts.json}`);
  lines.push(`HTML report: ${artifacts.html}`);
  lines.push(`Local chart: ${artifacts.localChart}`);
  lines.push(`Published chart: ${artifacts.externalChart}`);
  if (artifacts.readmeAssets) {
    lines.push(`README local chart: ${artifacts.readmeAssets.localChart}`);
    lines.push(`README published chart: ${artifacts.readmeAssets.externalChart}`);
  }
  if (gate) {
    const baselineLabel = gate.strongestBaseline
      ? `${gate.strongestBaseline.system} by ${gate.marginOverBaseline.toFixed(1)} points`
      : 'all local baselines';
    lines.push('');
    lines.push(`Regression gate passed: Audrey stayed above ${gate.thresholds.minAudreyScore.toFixed(1)}% and ahead of ${baselineLabel}.`);
  }

  out(lines.join('\n'));
  return { summary, artifacts, gate };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  runBenchmarkCli().catch(err => {
    console.error('[audrey] benchmark failed:', err);
    process.exitCode = 1;
  });
}
