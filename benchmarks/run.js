import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Audrey } from '../dist/src/audrey.js';
import { LOCAL_BENCHMARK_SUITES, FAMILY_ORDER } from './cases.js';
import { runBaselineScenario } from './baselines.js';
import { MEMORY_TRENDS, PUBLISHED_LEADERBOARD } from './reference-results.js';
import { writeBenchmarkArtifacts } from './report.js';

const SUITE_LABELS = new Map(LOCAL_BENCHMARK_SUITES.map(suite => [suite.id, suite.title]));
const ALL_SUITE_IDS = LOCAL_BENCHMARK_SUITES.map(suite => suite.id);

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
    suite: 'all',
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
    } else if (token === '--suite' && argv[i + 1]) {
      args.suite = argv[++i];
    }
  }

  return args;
}

function normalize(text) {
  return String(text || '').toLowerCase();
}

function normalizeSuiteSelection(value = 'all') {
  if (value === 'all') return [...ALL_SUITE_IDS];
  const selected = String(value)
    .split(',')
    .map(token => token.trim().toLowerCase())
    .filter(Boolean);

  const invalid = selected.filter(token => !ALL_SUITE_IDS.includes(token));
  if (invalid.length > 0) {
    throw new Error(`Unknown benchmark suite(s): ${invalid.join(', ')}. Valid: all, ${ALL_SUITE_IDS.join(', ')}`);
  }
  return [...new Set(selected)];
}

function selectedSuitesOrThrow(suiteIds) {
  const suites = LOCAL_BENCHMARK_SUITES.filter(suite => suiteIds.includes(suite.id));
  if (suites.length === 0) {
    throw new Error('No benchmark suites selected.');
  }
  return suites;
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
  const required = (benchmarkCase.expectAll || []).map(normalize);
  const forbidden = (benchmarkCase.forbid || []).map(normalize);
  const firstMatchIndex = expected.length === 0
    ? -1
    : normalizedContents.findIndex(content => expected.some(expectation => content.includes(expectation)));
  const firstForbiddenIndex = normalizedContents.findIndex(content => forbidden.some(blocked => content.includes(blocked)));
  const matched = firstMatchIndex !== -1;
  const requiredMatches = required.filter(expectation => normalizedContents.some(content => content.includes(expectation)));
  const matchedRequired = required.length > 0 && requiredMatches.length === required.length;
  const leakedForbidden = firstForbiddenIndex !== -1;

  if (benchmarkCase.expectNone) {
    const score = leakedForbidden ? 0 : results.length === 0 ? 1 : 0.5;
    return {
      passed: score === 1,
      score,
      summary: leakedForbidden ? 'leaked restricted content' : results.length === 0 ? 'correct abstention' : 'no leak, but retrieved tangential context',
    };
  }

  if (required.length > 0) {
    const score = matchedRequired && !leakedForbidden
      ? 1
      : leakedForbidden
        ? 0
        : Math.min(0.5, requiredMatches.length / required.length);
    const missing = required.filter(expectation => !requiredMatches.includes(expectation));
    return {
      passed: score === 1,
      score,
      summary: matchedRequired
        ? 'matched all required signals'
        : missing.length > 0
          ? `missed required signal${missing.length === 1 ? '' : 's'}: ${missing.join(', ')}`
          : 'blocked content outranked the required signals',
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

async function seedRetrievalCase(brain, benchmarkCase) {
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
    await brain.waitForIdle();
    await brain.consolidate({
      minClusterSize: benchmarkCase.consolidate.minClusterSize,
      similarityThreshold: benchmarkCase.consolidate.similarityThreshold,
      extractPrinciple: () => benchmarkCase.consolidate.principle,
    });
  }
}

async function executeAudreyStep(brain, step, refs) {
  if (step.type === 'encode') {
    const supersedes = step.supersedesRef ? refs.get(step.supersedesRef) : undefined;
    const id = await brain.encode({
      ...step.memory,
      supersedes,
    });
    if (step.saveAs) {
      refs.set(step.saveAs, id);
    }
    return;
  }

  if (step.type === 'forgetByQuery') {
    await brain.waitForIdle();
    await brain.forgetByQuery(step.query, step.options || {});
    return;
  }

  if (step.type === 'consolidate') {
    await brain.waitForIdle();
    await brain.consolidate({
      minClusterSize: step.minClusterSize,
      similarityThreshold: step.similarityThreshold,
      extractPrinciple: () => step.principle,
    });
    return;
  }

  throw new Error(`Unsupported Audrey benchmark step: ${step.type}`);
}

async function seedOperationsCase(brain, benchmarkCase) {
  const refs = new Map();
  for (const step of benchmarkCase.steps || []) {
    await executeAudreyStep(brain, step, refs);
  }
}

async function executeGuardStep(brain, step, refs) {
  if (step.type === 'encode' || step.type === 'forgetByQuery' || step.type === 'consolidate') {
    await executeAudreyStep(brain, step, refs);
    return;
  }

  if (step.type === 'guardCycle') {
    const before = await brain.beforeAction(step.action, {
      tool: step.tool,
      strict: Boolean(step.strict),
      includeCapsule: step.includeCapsule ?? false,
    });
    if (step.saveReceiptAs) {
      refs.set(step.saveReceiptAs, before.receipt_id);
    }
    brain.afterAction({
      receiptId: before.receipt_id,
      tool: step.tool,
      outcome: step.outcome ?? 'unknown',
      errorSummary: step.errorSummary,
    });
    return;
  }

  throw new Error(`Unsupported guard benchmark step: ${step.type}`);
}

async function seedGuardCase(brain, benchmarkCase) {
  const refs = new Map();
  for (const step of benchmarkCase.steps || []) {
    await executeGuardStep(brain, step, refs);
  }
}

function guardDecisionRows(decision) {
  const rows = [{
    id: decision.receipt_id,
    content: `decision:${decision.decision} verdict:${decision.verdict} risk:${decision.risk_score} ${decision.summary}`,
    type: 'guard_decision',
    score: 1,
  }];

  for (const [index, warning] of decision.warnings.entries()) {
    rows.push({
      id: warning.evidence_id || `${decision.receipt_id}:warning:${index}`,
      content: `warning:${warning.type} severity:${warning.severity} ${warning.message} ${warning.recommended_action || ''}`,
      type: 'guard_warning',
      score: 0.95 - index * 0.01,
    });
  }

  for (const [index, reflex] of decision.reflexes.entries()) {
    rows.push({
      id: reflex.id || `${decision.receipt_id}:reflex:${index}`,
      content: `reflex:${reflex.response_type} source:${reflex.source} severity:${reflex.severity} ${reflex.response}`,
      type: 'guard_reflex',
      score: 0.85 - index * 0.01,
    });
  }

  return rows;
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

    if (benchmarkCase.kind === 'operations') {
      await seedOperationsCase(brain, benchmarkCase);
    } else if (benchmarkCase.kind === 'guard') {
      await seedGuardCase(brain, benchmarkCase);
    } else {
      await seedRetrievalCase(brain, benchmarkCase);
    }

    await brain.waitForIdle();
    if (benchmarkCase.kind === 'guard') {
      const decision = await brain.beforeAction(benchmarkCase.action, {
        tool: benchmarkCase.tool,
        strict: Boolean(benchmarkCase.strict),
        includeCapsule: benchmarkCase.includeCapsule ?? false,
      });
      return guardDecisionRows(decision);
    }

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

async function runBaselineCase(system, benchmarkCase, providerConfig) {
  if (benchmarkCase.kind === 'guard') {
    return [{
      id: `${system.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-guard-baseline`,
      content: 'decision:go verdict:clear summary:retrieval-only baseline has no before-action guard controller',
      type: 'guard_decision',
      score: 0,
    }];
  }

  return runBaselineScenario(system, benchmarkCase, providerConfig, 5);
}

async function runSystemsForCase(benchmarkCase, providerConfig) {
  const systems = [
    { system: 'Audrey', run: () => runAudreyCase(benchmarkCase, providerConfig) },
    { system: 'Vector Only', run: () => runBaselineCase('Vector Only', benchmarkCase, providerConfig) },
    { system: 'Keyword + Recency', run: () => runBaselineCase('Keyword + Recency', benchmarkCase, providerConfig) },
    { system: 'Recent Window', run: () => runBaselineCase('Recent Window', benchmarkCase, providerConfig) },
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
      scorePercent: system.totalCases === 0 ? 0 : (system.totalScore / system.totalCases) * 100,
      passRate: system.totalCases === 0 ? 0 : (system.passCount / system.totalCases) * 100,
      avgDurationMs: system.totalCases === 0 ? 0 : system.durationMs / system.totalCases,
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

  return [...families.values()].filter(entry => Object.keys(entry.systems).length > 0);
}

function summarizeSuites(caseResults, suites) {
  return suites.map(suite => {
    const suiteCases = caseResults.filter(caseResult => caseResult.suite === suite.id);
    return {
      id: suite.id,
      title: suite.title,
      description: suite.description,
      comparableToBaselines: suite.comparableToBaselines !== false,
      overall: summarizeLocalResults(suiteCases),
      byFamily: summarizeByFamily(suiteCases),
      cases: suiteCases,
    };
  });
}

function commandForSummary(providerConfig, suiteIds) {
  const suiteArg = suiteIds.length === ALL_SUITE_IDS.length ? '' : ` --suite ${suiteIds.join(',')}`;
  return `node benchmarks/run.js --provider ${providerConfig.provider} --dimensions ${providerConfig.dimensions}${suiteArg}`;
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
  const suiteIds = normalizeSuiteSelection(options.suite || 'all');
  const selectedSuites = selectedSuitesOrThrow(suiteIds);

  const caseResults = [];
  for (const suite of selectedSuites) {
    for (const benchmarkCase of suite.cases) {
      const results = await runSystemsForCase(benchmarkCase, providerConfig);
      caseResults.push({
        id: benchmarkCase.id,
        suite: benchmarkCase.suite,
        title: benchmarkCase.title,
        family: benchmarkCase.family,
        description: benchmarkCase.description,
        query: benchmarkCase.query,
        action: benchmarkCase.action,
        tool: benchmarkCase.tool,
        comparable_to_baselines: suite.comparableToBaselines !== false,
        results,
      });
    }
  }

  const comparableCaseResults = caseResults.filter(caseResult => caseResult.comparable_to_baselines);
  const overallCaseResults = comparableCaseResults.length > 0 ? comparableCaseResults : caseResults;
  const overallScope = comparableCaseResults.length > 0 ? 'comparable_suites' : 'selected_suites';
  const overallSuiteIds = [...new Set(overallCaseResults.map(caseResult => caseResult.suite))];
  const localOverall = summarizeLocalResults(overallCaseResults);
  const localByFamily = summarizeByFamily(overallCaseResults);
  const localSuites = summarizeSuites(caseResults, selectedSuites);

  return {
    generatedAt: new Date().toISOString(),
    command: commandForSummary(providerConfig, suiteIds),
    config: {
      ...providerConfig,
      suites: suiteIds,
    },
    methodology: {
      localBenchmark: 'LongMemEval-inspired retrieval benchmark plus operation-level lifecycle and agent guard-loop benchmarks',
      retrievalBenchmark: 'Information extraction, updates, reasoning, procedural learning, privacy, abstention, and conflict handling',
      operationsBenchmark: 'Update, overwrite, delete, merge, and abstention behavior after lifecycle operations',
      guardBenchmark: 'Memory-before-action controller behavior: receipts, learned tool-failure cautions, and strict blocking reflexes',
      externalLeaderboard: 'Published LoCoMo scores from official papers and project blogs',
    },
    local: {
      overall: localOverall,
      overall_scope: overallScope,
      overall_suite_ids: overallSuiteIds,
      byFamily: localByFamily,
      suites: localSuites,
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
    localSuites: summary.local.suites,
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
  lines.push(`Suites: ${summary.config.suites.map(suiteId => SUITE_LABELS.get(suiteId) || suiteId).join(', ')}`);
  for (const row of summary.local.overall) {
    lines.push(
      `${row.system}: ${row.scorePercent.toFixed(1)}% score, ${row.passRate.toFixed(1)}% pass rate, `
      + `${row.avgDurationMs.toFixed(1)} ms avg/case`
    );
  }
  lines.push('');
  for (const suite of summary.local.suites) {
    const audrey = suite.overall.find(row => row.system === 'Audrey');
    lines.push(`${suite.title}: Audrey ${audrey?.scorePercent.toFixed(1) ?? '0.0'}%`);
  }
  lines.push('');
  lines.push(`JSON report: ${artifacts.json}`);
  lines.push(`HTML report: ${artifacts.html}`);
  lines.push(`Local chart: ${artifacts.localChart}`);
  if (artifacts.suiteCharts.length > 0) {
    for (const suiteChart of artifacts.suiteCharts) {
      lines.push(`${suiteChart.title}: ${suiteChart.path}`);
    }
  }
  lines.push(`Published chart: ${artifacts.externalChart}`);
  if (artifacts.readmeAssets) {
    lines.push(`README local chart: ${artifacts.readmeAssets.localChart}`);
    if (artifacts.readmeAssets.operationsChart) {
      lines.push(`README operations chart: ${artifacts.readmeAssets.operationsChart}`);
    }
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
