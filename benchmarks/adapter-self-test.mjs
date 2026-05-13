import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadExternalAdapters, runGuardBench } from './guardbench.js';
import { evaluateAdapterConformance } from './run-external-guardbench.mjs';
import { validateSchema } from './validate-guardbench-artifacts.mjs';
import { publicPath } from './public-paths.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_ADAPTER = 'benchmarks/adapters/example-allow.mjs';
const DEFAULT_OUT = 'benchmarks/output/adapter-self-test/guardbench-adapter-self-test.json';
const DEFAULT_SCHEMA = 'benchmarks/schemas/guardbench-adapter-self-test.schema.json';
const RESULT_FIELDS = [
  'decision',
  'riskScore',
  'evidenceIds',
  'recommendedActions',
  'summary',
  'recallErrors',
];

export function parseAdapterSelfTestArgs(argv = process.argv.slice(2)) {
  const args = {
    adapter: DEFAULT_ADAPTER,
    out: DEFAULT_OUT,
    json: false,
    noWrite: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === '--adapter' && argv[i + 1]) args.adapter = argv[++i];
    else if (token === '--out' && argv[i + 1]) args.out = argv[++i];
    else if (token === '--json') args.json = true;
    else if (token === '--no-write') args.noWrite = true;
    else if (token === '--help' || token === '-h') args.help = true;
    else throw new Error(`Unknown argument: ${token}`);
  }

  return args;
}

function usage() {
  return `Usage: node benchmarks/adapter-self-test.mjs [options]

Options:
  --adapter <path>   ESM GuardBench adapter path. Default: ${DEFAULT_ADAPTER}.
  --out <path>       JSON report path. Default: ${DEFAULT_OUT}.
  --json             Print the full JSON report.
  --no-write         Do not write the JSON report.
`;
}

function systemSummary(report, adapterName) {
  return report.systemSummaries.find(row => row.system === adapterName) ?? null;
}

function scoreFromReport(report, adapterName) {
  const summary = systemSummary(report, adapterName);
  return {
    scenarios: summary?.scenarios ?? 0,
    fullContractPassRate: summary?.passRate ?? null,
    decisionAccuracy: summary?.decisionAccuracy ?? null,
    evidenceRecall: summary?.evidenceRecall ?? null,
    redactionLeaks: summary?.redactionLeaks ?? null,
    latency: summary?.latency ?? null,
  };
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf-8'));
}

export function validateAdapterSelfTestReport(report, options = {}) {
  const schemaPath = resolve(ROOT, options.schema ?? DEFAULT_SCHEMA);
  const schema = options.schemaObject ?? readJson(schemaPath);
  return validateSchema(report, schema, 'guardbench-adapter-self-test');
}

export async function runGuardBenchAdapterSelfTest(options = {}) {
  const adapterPath = resolve(ROOT, options.adapterPath ?? options.adapter ?? DEFAULT_ADAPTER);
  if (!existsSync(adapterPath)) {
    throw new Error(`GuardBench adapter not found: ${adapterPath}`);
  }

  const adapters = await loadExternalAdapters([adapterPath]);
  if (adapters.length !== 1) {
    throw new Error(`GuardBench adapter self-test expected 1 adapter, got ${adapters.length}`);
  }

  const [adapter] = adapters;
  const report = await runGuardBench({ externalAdapters: adapters });
  const conformance = evaluateAdapterConformance(report, adapter.name);
  const score = scoreFromReport(report, conformance.adapter);
  const selfTest = {
    schemaVersion: '1.0.0',
    suite: 'GuardBench adapter self-test',
    generatedAt: new Date().toISOString(),
    ok: conformance.ok,
    adapter: {
      name: adapter.name,
      path: publicPath(adapterPath),
      moduleFile: basename(adapterPath),
      description: adapter.description ?? null,
    },
    conformance,
    score,
    contract: {
      expectedAnswersWithheld: true,
      lowScoreAllowed: true,
      requiredScenarioRows: report.scenarios,
      requiredResultFields: RESULT_FIELDS,
      redactionLeakTolerance: 0,
    },
    failures: conformance.failures,
  };
  const schemaErrors = validateAdapterSelfTestReport(selfTest);
  if (schemaErrors.length > 0) {
    throw new Error(`GuardBench adapter self-test schema validation failed: ${schemaErrors.join('; ')}`);
  }

  if (options.out && options.write !== false) {
    const outPath = resolve(ROOT, options.out);
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, `${JSON.stringify(selfTest, null, 2)}\n`, 'utf-8');
    selfTest.outPath = publicPath(outPath);
  }

  return selfTest;
}

async function main() {
  const args = parseAdapterSelfTestArgs();
  if (args.help) {
    console.log(usage());
    return;
  }

  const result = await runGuardBenchAdapterSelfTest({
    adapter: args.adapter,
    out: args.noWrite ? null : args.out,
    write: !args.noWrite,
  });

  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
  } else if (result.ok) {
    console.log(`GuardBench adapter self-test passed: ${result.adapter.name}`);
    console.log(`Contract rows: ${result.conformance.scenarios}/${result.conformance.expectedScenarios}`);
    console.log(`Full-contract score: ${(result.score.fullContractPassRate * 100).toFixed(1)}%`);
    console.log(`Decision accuracy: ${(result.score.decisionAccuracy * 100).toFixed(1)}%`);
    if (result.outPath) console.log(`Self-test report: ${result.outPath}`);
  } else {
    console.error(`GuardBench adapter self-test failed: ${result.adapter.name}`);
    for (const failure of result.failures) console.error(`- ${failure}`);
  }

  process.exitCode = result.ok ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(error.message);
    process.exit(1);
  });
}
