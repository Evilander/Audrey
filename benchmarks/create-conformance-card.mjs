import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { computeGuardBenchArtifactHashes, validateGuardBenchArtifacts } from './validate-guardbench-artifacts.mjs';
import { publicArtifactValue, publicPath } from './public-paths.mjs';

const CARD_FILE = 'guardbench-conformance-card.json';
const METADATA_FILE = 'external-run-metadata.json';

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf-8'));
}

function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function findExternalSubject(summary, requestedAdapter) {
  const externalSubjects = (summary.manifest?.subjects ?? []).filter(subject => subject.external);
  if (requestedAdapter) {
    const requested = externalSubjects.find(subject => subject.name === requestedAdapter || subject.id === requestedAdapter);
    if (requested) return requested;
  }
  return externalSubjects.length === 1 ? externalSubjects[0] : null;
}

function findSystemSummary(summary, metadata) {
  const requested = metadata?.adapterConformance?.adapter ?? metadata?.adapter;
  if (requested) {
    const direct = summary.systemSummaries?.find(row => row.system === requested);
    if (direct) return direct;
  }
  const externalSubject = findExternalSubject(summary, requested);
  if (externalSubject) {
    return summary.systemSummaries?.find(row => row.system === externalSubject.name) ?? null;
  }
  const audreyGuard = summary.systemSummaries?.find(row => row.system === 'Audrey Guard');
  if (audreyGuard) return audreyGuard;
  return null;
}

export function buildGuardBenchConformanceCard(options = {}) {
  const dir = resolve(options.dir ?? 'benchmarks/output');
  const summary = readJson(join(dir, 'guardbench-summary.json'));
  const metadataPath = join(dir, METADATA_FILE);
  const metadata = existsSync(metadataPath) ? readJson(metadataPath) : null;
  const validation = validateGuardBenchArtifacts({ dir });
  const systemSummary = findSystemSummary(summary, metadata);
  const externalSubject = findExternalSubject(summary, systemSummary?.system ?? metadata?.adapter);
  const artifactHashes = computeGuardBenchArtifactHashes(dir);

  return {
    schemaVersion: '1.0.0',
    suite: 'GuardBench conformance card',
    generatedAt: new Date().toISOString(),
    sourceDir: publicPath(dir),
    manifestVersion: summary.manifest?.manifestVersion ?? null,
    suiteId: summary.manifest?.suiteId ?? null,
    subject: {
      name: systemSummary?.system ?? metadata?.adapterConformance?.adapter ?? metadata?.adapter ?? 'unknown',
      requestedAdapter: metadata?.adapterConformance?.requestedAdapter ?? metadata?.adapter ?? null,
      external: Boolean(externalSubject?.external ?? metadata),
    },
    run: {
      status: metadata?.status ?? (validation.ok ? 'validated' : 'invalid'),
      startedAt: metadata?.startedAt ?? null,
      completedAt: metadata?.completedAt ?? null,
      command: publicArtifactValue(metadata?.command ?? null),
      validationCommand: publicArtifactValue(metadata?.validationCommand ?? null),
    },
    score: {
      scenarios: systemSummary?.scenarios ?? summary.scenarios ?? 0,
      fullContractPassed: systemSummary?.passed ?? null,
      fullContractPassRate: systemSummary?.passRate ?? null,
      decisionAccuracy: systemSummary?.decisionAccuracy ?? null,
      evidenceRecall: systemSummary?.evidenceRecall ?? null,
      redactionLeaks: systemSummary?.redactionLeaks ?? null,
      latency: systemSummary?.latency ?? null,
    },
    conformance: {
      ok: Boolean(metadata?.adapterConformance?.ok ?? validation.ok),
      failures: metadata?.adapterConformance?.failures ?? validation.failures,
      artifactValidationOk: validation.ok,
      artifactValidationFailures: validation.failures,
    },
    integrity: {
      artifactHashes,
      externalRunMetadataHash: existsSync(metadataPath) ? sha256File(metadataPath) : null,
    },
    provenance: summary.provenance,
  };
}

export function writeGuardBenchConformanceCard(options = {}) {
  const dir = resolve(options.dir ?? 'benchmarks/output');
  const card = buildGuardBenchConformanceCard({ dir });
  const path = join(dir, CARD_FILE);
  writeFileSync(path, `${JSON.stringify(card, null, 2)}\n`, 'utf-8');
  return { path, card };
}

function parseArgs(argv = process.argv.slice(2)) {
  const args = { dir: 'benchmarks/output', json: false };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if ((token === '--dir' || token === '--out-dir') && argv[i + 1]) args.dir = argv[++i];
    else if (token === '--json') args.json = true;
    else if (token === '--help' || token === '-h') args.help = true;
    else throw new Error(`Unknown argument: ${token}`);
  }
  return args;
}

function usage() {
  return [
    'Usage: node benchmarks/create-conformance-card.mjs [--dir benchmarks/output] [--json]',
    '',
    'Writes guardbench-conformance-card.json for a validated GuardBench output bundle.',
  ].join('\n');
}

async function main() {
  const args = parseArgs();
  if (args.help) {
    console.log(usage());
    return;
  }
  const result = writeGuardBenchConformanceCard(args);
  if (args.json) console.log(JSON.stringify({ path: result.path, card: result.card }, null, 2));
  else console.log(`GuardBench conformance card: ${result.path}`);
  if (!result.card.conformance.artifactValidationOk) process.exit(1);
}

if (process.argv[1] && resolve(process.argv[1]).endsWith('create-conformance-card.mjs')) {
  main().catch(error => {
    console.error(error.stack ?? error.message);
    process.exit(1);
  });
}
