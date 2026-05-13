import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeGuardBenchConformanceCard } from './create-conformance-card.mjs';
import { computeGuardBenchArtifactHashes, validateGuardBenchArtifacts } from './validate-guardbench-artifacts.mjs';
import { publicArtifactValue } from './public-paths.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const KNOWN_ADAPTERS = new Map([
  ['mem0', {
    name: 'mem0-platform',
    path: 'benchmarks/adapters/mem0-platform.mjs',
    requiredEnv: ['MEM0_API_KEY'],
  }],
  ['mem0-platform', {
    name: 'mem0-platform',
    path: 'benchmarks/adapters/mem0-platform.mjs',
    requiredEnv: ['MEM0_API_KEY'],
  }],
  ['zep', {
    name: 'zep-cloud',
    path: 'benchmarks/adapters/zep-cloud.mjs',
    requiredEnv: ['ZEP_API_KEY'],
  }],
  ['zep-cloud', {
    name: 'zep-cloud',
    path: 'benchmarks/adapters/zep-cloud.mjs',
    requiredEnv: ['ZEP_API_KEY'],
  }],
]);

export function parseExternalArgs(argv = process.argv.slice(2)) {
  const args = {
    adapter: 'mem0-platform',
    outDir: null,
    check: false,
    dryRun: false,
    json: false,
    minPassRate: null,
    allowMissingEnv: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === '--adapter' && argv[i + 1]) args.adapter = argv[++i];
    else if (token === '--out-dir' && argv[i + 1]) args.outDir = argv[++i];
    else if (token === '--check') args.check = true;
    else if (token === '--dry-run') args.dryRun = true;
    else if (token === '--json') args.json = true;
    else if (token === '--min-pass-rate' && argv[i + 1]) args.minPassRate = argv[++i];
    else if (token === '--allow-missing-env') args.allowMissingEnv = true;
    else if (token === '--help' || token === '-h') args.help = true;
    else throw new Error(`Unknown argument: ${token}`);
  }

  return args;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf-8'));
}

function adapterSpec(adapter) {
  const known = KNOWN_ADAPTERS.get(adapter);
  if (known) return known;

  const adapterPath = resolve(ROOT, adapter);
  return {
    name: basename(adapter).replace(/\.[cm]?js$/i, ''),
    path: adapterPath,
    requiredEnv: [],
  };
}

export function buildExternalGuardBenchRun(args = {}, env = process.env) {
  const spec = adapterSpec(args.adapter ?? 'mem0-platform');
  const adapterPath = resolve(ROOT, spec.path);
  const outDir = resolve(ROOT, args.outDir ?? `benchmarks/output/external/${spec.name}`);
  const missingEnv = spec.requiredEnv.filter(name => !env[name]);
  const command = [
    process.execPath,
    resolve(ROOT, 'benchmarks/guardbench.js'),
    '--adapter',
    adapterPath,
    '--out-dir',
    outDir,
  ];

  if (args.check) command.push('--check');
  if (args.json) command.push('--json');
  if (args.minPassRate != null) command.push('--min-pass-rate', String(args.minPassRate));
  const validationCommand = [
    process.execPath,
    resolve(ROOT, 'benchmarks/validate-guardbench-artifacts.mjs'),
    '--dir',
    outDir,
  ];

  return {
    adapter: spec.name,
    adapterPath,
    outDir,
    requiredEnv: spec.requiredEnv,
    missingEnv,
    command,
    validationCommand,
  };
}

export function evaluateAdapterConformance(summary, adapterName) {
  const failures = [];
  const externalSubjects = (summary.manifest?.subjects ?? []).filter(subject => subject.external);
  const resolvedAdapterName = summary.systemSummaries?.some(row => row.system === adapterName)
    ? adapterName
    : externalSubjects.length === 1
      ? externalSubjects[0].name
      : adapterName;
  const systemSummary = summary.systemSummaries?.find(row => row.system === resolvedAdapterName);
  if (!systemSummary) {
    failures.push(`Missing system summary for adapter ${resolvedAdapterName}`);
  }

  const expectedScenarios = summary.scenarios ?? summary.manifest?.scenarios?.length ?? 0;
  const adapterRows = (summary.cases ?? [])
    .flatMap(entry => entry.results ?? [])
    .filter(row => row.system === resolvedAdapterName);

  if (adapterRows.length !== expectedScenarios) {
    failures.push(`Adapter ${resolvedAdapterName} returned ${adapterRows.length}/${expectedScenarios} scenario rows`);
  }
  if (systemSummary && systemSummary.scenarios !== expectedScenarios) {
    failures.push(`Adapter ${resolvedAdapterName} system summary has ${systemSummary.scenarios}/${expectedScenarios} scenarios`);
  }
  if (systemSummary && systemSummary.redactionLeaks !== 0) {
    failures.push(`Adapter ${resolvedAdapterName} leaked ${systemSummary.redactionLeaks} seeded secret(s) in decision output`);
  }
  if (adapterRows.some(row => row.external !== true)) {
    failures.push(`Adapter ${resolvedAdapterName} rows are not marked external`);
  }

  return {
    ok: failures.length === 0,
    adapter: resolvedAdapterName,
    requestedAdapter: adapterName,
    scenarios: systemSummary?.scenarios ?? adapterRows.length,
    expectedScenarios,
    fullContractPassRate: systemSummary?.passRate ?? null,
    decisionAccuracy: systemSummary?.decisionAccuracy ?? null,
    redactionLeaks: systemSummary?.redactionLeaks ?? null,
    failures,
  };
}

function usage() {
  return `Usage: node benchmarks/run-external-guardbench.mjs [options]

Options:
  --adapter <name|path>       Adapter alias or ESM adapter path. Default: mem0-platform.
  --out-dir <path>            Output directory. Default: benchmarks/output/external/<adapter>.
  --check                     Fail if Audrey Guard pass rate is below the threshold.
  --min-pass-rate <percent>   GuardBench pass-rate threshold for --check.
  --json                      Forward JSON output from GuardBench.
  --dry-run                   Print the resolved command and metadata without running.
  --allow-missing-env         Permit running even when known runtime env vars are absent.
`;
}

export function writeExternalRunMetadata(path, metadata) {
  mkdirSync(path, { recursive: true });
  const file = resolve(path, 'external-run-metadata.json');
  writeFileSync(file, `${JSON.stringify(publicArtifactValue(metadata), null, 2)}\n`, 'utf-8');
  return file;
}

async function main() {
  const args = parseExternalArgs();
  if (args.help) {
    console.log(usage());
    return;
  }

  const run = buildExternalGuardBenchRun(args);
  const startedAt = new Date().toISOString();
  const metadata = {
    suite: 'GuardBench external adapter run',
    startedAt,
    adapter: run.adapter,
    adapterPath: run.adapterPath,
    outDir: run.outDir,
    requiredEnv: run.requiredEnv,
    missingEnv: run.missingEnv,
    command: run.command,
    validationCommand: run.validationCommand,
    dryRun: args.dryRun,
  };

  if (!existsSync(run.adapterPath)) {
    throw new Error(`Adapter not found: ${run.adapterPath}`);
  }

  if (run.missingEnv.length && !args.allowMissingEnv && !args.dryRun) {
    metadata.status = 'blocked';
    metadata.blockReason = `Missing runtime environment: ${run.missingEnv.join(', ')}`;
    const metadataPath = writeExternalRunMetadata(run.outDir, metadata);
    throw new Error(`${metadata.blockReason}. Metadata written to ${metadataPath}`);
  }

  if (args.dryRun) {
    metadata.status = run.missingEnv.length ? 'dry-run-missing-env' : 'dry-run-ready';
    const metadataPath = writeExternalRunMetadata(run.outDir, metadata);
    if (args.json) {
      console.log(JSON.stringify({ ...metadata, metadataPath }, null, 2));
    } else {
      console.log(`External GuardBench dry run: ${run.adapter}`);
      console.log(`Command: ${run.command.map(part => JSON.stringify(part)).join(' ')}`);
      console.log(`Metadata: ${metadataPath}`);
      if (run.missingEnv.length) console.log(`Missing runtime env: ${run.missingEnv.join(', ')}`);
    }
    return;
  }

  writeExternalRunMetadata(run.outDir, { ...metadata, status: 'running' });
  const child = spawnSync(run.command[0], run.command.slice(1), {
    cwd: ROOT,
    env: process.env,
    stdio: 'inherit',
  });
  const validation = validateGuardBenchArtifacts({ dir: run.outDir });
  let adapterConformance = {
    ok: false,
    adapter: run.adapter,
    failures: ['GuardBench summary was not available for adapter conformance evaluation'],
  };
  if (child.status === 0) {
    try {
      const summary = readJson(resolve(run.outDir, 'guardbench-summary.json'));
      adapterConformance = evaluateAdapterConformance(summary, run.adapter);
    } catch (error) {
      adapterConformance = {
        ok: false,
        adapter: run.adapter,
        failures: [error.message],
      };
    }
  }
  if (validation.ok) {
    console.log(`External GuardBench artifact validation passed: ${run.outDir}`);
  } else {
    console.error('External GuardBench artifact validation failed:');
    for (const failure of validation.failures) console.error(`- ${failure}`);
  }
  if (adapterConformance.ok) {
    console.log(`External GuardBench adapter conformance passed: ${adapterConformance.adapter}`);
  } else {
    console.error('External GuardBench adapter conformance failed:');
    for (const failure of adapterConformance.failures) console.error(`- ${failure}`);
  }
  const completed = {
    ...metadata,
    completedAt: new Date().toISOString(),
    status: child.status === 0 && validation.ok && adapterConformance.ok ? 'passed' : 'failed',
    exitCode: child.status,
    signal: child.signal,
    artifactHashes: child.status === 0 ? computeGuardBenchArtifactHashes(run.outDir) : undefined,
    artifactValidation: validation,
    adapterConformance,
  };
  const metadataPath = writeExternalRunMetadata(run.outDir, completed);
  const card = child.status === 0 ? writeGuardBenchConformanceCard({ dir: run.outDir }) : null;
  console.log(`External GuardBench metadata: ${metadataPath}`);
  if (card) console.log(`External GuardBench conformance card: ${card.path}`);
  process.exitCode = child.status === 0 && validation.ok && adapterConformance.ok ? 0 : (child.status ?? 1);
}

if (process.argv[1] && process.argv[1].endsWith('run-external-guardbench.mjs')) {
  main().catch(err => {
    console.error(err.message);
    process.exit(1);
  });
}
