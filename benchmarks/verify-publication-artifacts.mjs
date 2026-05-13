import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateAdapterRegistry } from './validate-adapter-registry.mjs';
import { validateAdapterModuleFile } from './validate-adapter-module.mjs';
import { validateAdapterSelfTestFile } from './validate-adapter-self-test.mjs';
import { validateExternalAdapterDryRunMatrix } from './dry-run-external-adapters.mjs';
import { validateExternalEvidenceReport } from './verify-external-evidence.mjs';
import { validateGuardBenchArtifacts, validateSchema } from './validate-guardbench-artifacts.mjs';
import { verifyGuardBenchSubmissionBundle } from './verify-submission-bundle.mjs';
import { containsLocalPath, findLocalPathLeaks, publicPath, walkFiles } from './public-paths.mjs';

const DEFAULT_ADAPTER = 'benchmarks/adapters/example-allow.mjs';
const DEFAULT_ARTIFACTS_DIR = 'benchmarks/output';
const DEFAULT_BUNDLE_DIR = 'benchmarks/output/submission-bundle';
const DEFAULT_EXTERNAL_DRY_RUN = 'benchmarks/output/external/guardbench-external-dry-run.json';
const DEFAULT_EXTERNAL_EVIDENCE = 'benchmarks/output/external/guardbench-external-evidence.json';
const DEFAULT_LEADERBOARD = 'benchmarks/output/leaderboard/guardbench-leaderboard.json';
const DEFAULT_SCHEMA = 'benchmarks/schemas/guardbench-publication-verification.schema.json';

export function parsePublicationVerifierArgs(argv = process.argv.slice(2)) {
  const args = {
    adapter: DEFAULT_ADAPTER,
    artifactsDir: DEFAULT_ARTIFACTS_DIR,
    bundleDir: DEFAULT_BUNDLE_DIR,
    externalDryRun: DEFAULT_EXTERNAL_DRY_RUN,
    externalEvidence: DEFAULT_EXTERNAL_EVIDENCE,
    leaderboard: DEFAULT_LEADERBOARD,
    json: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === '--adapter' && argv[i + 1]) args.adapter = argv[++i];
    else if ((token === '--artifacts-dir' || token === '--dir') && argv[i + 1]) args.artifactsDir = argv[++i];
    else if ((token === '--bundle-dir' || token === '--bundle') && argv[i + 1]) args.bundleDir = argv[++i];
    else if (token === '--external-dry-run' && argv[i + 1]) args.externalDryRun = argv[++i];
    else if (token === '--external-evidence' && argv[i + 1]) args.externalEvidence = argv[++i];
    else if (token === '--leaderboard' && argv[i + 1]) args.leaderboard = argv[++i];
    else if (token === '--json') args.json = true;
    else if (token === '--help' || token === '-h') args.help = true;
    else throw new Error(`Unknown argument: ${token}`);
  }

  return args;
}

function usage() {
  return `Usage: node benchmarks/verify-publication-artifacts.mjs [options]

Options:
  --adapter <path>        Default adapter module. Default: ${DEFAULT_ADAPTER}.
  --artifacts-dir <path>  GuardBench output artifact directory. Default: ${DEFAULT_ARTIFACTS_DIR}.
  --bundle-dir <path>     GuardBench submission bundle. Default: ${DEFAULT_BUNDLE_DIR}.
  --external-dry-run <path> GuardBench external adapter dry-run matrix. Default: ${DEFAULT_EXTERNAL_DRY_RUN}.
  --external-evidence <path> GuardBench external live-evidence verification report. Default: ${DEFAULT_EXTERNAL_EVIDENCE}.
  --leaderboard <path>    GuardBench leaderboard JSON. Default: ${DEFAULT_LEADERBOARD}.
  --json                  Print the machine-readable verification report.
`;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf-8'));
}

function checkLeaderboard(path) {
  const leaderboardPath = resolve(path);
  const failures = [];
  let leaderboard = null;

  if (!existsSync(leaderboardPath)) {
    failures.push(`Missing GuardBench leaderboard: ${leaderboardPath}`);
  } else {
    try {
      leaderboard = readJson(leaderboardPath);
      const schema = readJson('benchmarks/schemas/guardbench-leaderboard.schema.json');
      failures.push(...validateSchema(leaderboard, schema, 'guardbench-leaderboard'));
      if (!leaderboard.rows?.some(row => row.verification?.ok === true)) {
        failures.push('GuardBench leaderboard has no verified rows');
      }
    } catch (error) {
      failures.push(error.message);
    }
  }

  return {
    ok: failures.length === 0,
    path: publicPath(leaderboardPath),
    rows: leaderboard?.rows?.length ?? 0,
    failures,
  };
}

function checkExternalDryRun(path) {
  const matrixPath = resolve(path);
  const failures = [];
  let matrix = null;

  if (!existsSync(matrixPath)) {
    failures.push(`Missing GuardBench external adapter dry-run matrix: ${matrixPath}`);
  } else {
    try {
      matrix = readJson(matrixPath);
      failures.push(...validateExternalAdapterDryRunMatrix(matrix));
      if (!matrix.adapters?.some(row => row.id === 'mem0-platform')) {
        failures.push('GuardBench external adapter dry-run matrix has no mem0-platform row');
      }
      if (!matrix.adapters?.some(row => row.id === 'zep-cloud')) {
        failures.push('GuardBench external adapter dry-run matrix has no zep-cloud row');
      }
    } catch (error) {
      failures.push(error.message);
    }
  }

  return {
    ok: failures.length === 0,
    path: publicPath(matrixPath),
    adapters: matrix?.adapters?.length ?? 0,
    missingEnv: matrix?.adapters?.flatMap(row => row.missingEnv ?? []) ?? [],
    failures,
  };
}

function checkExternalEvidence(path) {
  const reportPath = resolve(path);
  const failures = [];
  let evidence = null;

  if (!existsSync(reportPath)) {
    failures.push(`Missing GuardBench external evidence report: ${reportPath}`);
  } else {
    try {
      evidence = readJson(reportPath);
      failures.push(...validateExternalEvidenceReport(evidence));
      if (evidence.ok !== true) {
        failures.push('GuardBench external evidence report is not ok');
      }
      if (!evidence.adapters?.some(row => row.id === 'mem0-platform')) {
        failures.push('GuardBench external evidence report has no mem0-platform row');
      }
      if (!evidence.adapters?.some(row => row.id === 'zep-cloud')) {
        failures.push('GuardBench external evidence report has no zep-cloud row');
      }
    } catch (error) {
      failures.push(error.message);
    }
  }

  return {
    ok: failures.length === 0,
    path: publicPath(reportPath),
    adapters: evidence?.adapters?.length ?? 0,
    verified: evidence?.adapters?.filter(row => row.status === 'verified').length ?? 0,
    pending: evidence?.adapters?.filter(row => row.status === 'pending').length ?? 0,
    failures,
  };
}

function scanTextFile(path) {
  try {
    return containsLocalPath(readFileSync(path, 'utf-8'));
  } catch {
    return false;
  }
}

function checkLocalPathLeaks(options = {}) {
  const failures = [];
  const artifactsDir = resolve(options.artifactsDir ?? DEFAULT_ARTIFACTS_DIR);
  const bundleDir = resolve(options.bundleDir ?? DEFAULT_BUNDLE_DIR);
  const files = [
    join(artifactsDir, 'guardbench-manifest.json'),
    join(artifactsDir, 'guardbench-summary.json'),
    join(artifactsDir, 'guardbench-raw.json'),
    join(artifactsDir, 'guardbench-conformance-card.json'),
    join(artifactsDir, 'adapter-self-test', 'guardbench-adapter-self-test.json'),
    resolve(options.externalDryRun ?? DEFAULT_EXTERNAL_DRY_RUN),
    resolve(options.externalEvidence ?? DEFAULT_EXTERNAL_EVIDENCE),
    resolve(options.leaderboard ?? DEFAULT_LEADERBOARD),
  ];

  for (const path of files) {
    if (existsSync(path) && scanTextFile(path)) {
      failures.push(`${publicPath(path)} contains a local absolute path`);
    }
  }
  if (existsSync(bundleDir)) {
    for (const file of walkFiles(bundleDir)) {
      const path = join(bundleDir, file);
      if (scanTextFile(path)) failures.push(`${publicPath(path)} contains a local absolute path`);
    }
  }

  return {
    ok: failures.length === 0,
    filesChecked: files.filter(path => existsSync(path)).map(path => publicPath(path)),
    bundleDir: publicPath(bundleDir),
    failures,
  };
}

export function validatePublicationVerificationReport(report, options = {}) {
  const schema = readJson(options.schema ?? DEFAULT_SCHEMA);
  return validateSchema(report, schema, 'guardbench-publication-verification');
}

export async function verifyGuardBenchPublicationArtifacts(options = {}) {
  const registry = await validateAdapterRegistry();
  const adapterModule = await validateAdapterModuleFile({ adapter: options.adapter ?? DEFAULT_ADAPTER });
  const selfTest = validateAdapterSelfTestFile({
    report: join(resolve(options.artifactsDir ?? DEFAULT_ARTIFACTS_DIR), 'adapter-self-test', 'guardbench-adapter-self-test.json'),
  });
  const artifacts = validateGuardBenchArtifacts({ dir: options.artifactsDir ?? DEFAULT_ARTIFACTS_DIR });
  const bundle = verifyGuardBenchSubmissionBundle({ dir: options.bundleDir ?? DEFAULT_BUNDLE_DIR });
  const externalDryRun = checkExternalDryRun(options.externalDryRun ?? DEFAULT_EXTERNAL_DRY_RUN);
  const externalEvidence = checkExternalEvidence(options.externalEvidence ?? DEFAULT_EXTERNAL_EVIDENCE);
  const leaderboard = checkLeaderboard(options.leaderboard ?? DEFAULT_LEADERBOARD);
  const localPaths = checkLocalPathLeaks(options);
  const checks = {
    registry,
    adapterModule,
    selfTest,
    artifacts,
    bundle,
    externalDryRun,
    externalEvidence,
    leaderboard,
    localPaths,
  };
  const failures = Object.entries(checks).flatMap(([name, report]) =>
    (report.failures ?? []).map(failure => `${name}: ${failure}`));

  const report = {
    schemaVersion: '1.0.0',
    suite: 'GuardBench publication artifact verification',
    generatedAt: new Date().toISOString(),
    ok: failures.length === 0,
    checks,
    failures,
  };
  const reportLocalPathLeaks = findLocalPathLeaks({ checks });
  if (reportLocalPathLeaks.length > 0) {
    failures.push(...reportLocalPathLeaks.map(leak => `publication report contains local absolute path: ${leak}`));
    report.ok = false;
    report.failures = failures;
  }
  const schemaFailures = validatePublicationVerificationReport(report);
  if (schemaFailures.length > 0) {
    throw new Error(`GuardBench publication verification schema validation failed: ${schemaFailures.join('; ')}`);
  }
  return report;
}

async function main() {
  const args = parsePublicationVerifierArgs();
  if (args.help) {
    console.log(usage());
    return;
  }

  const report = await verifyGuardBenchPublicationArtifacts(args);
  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
  } else if (report.ok) {
    console.log('GuardBench publication artifact verification passed.');
    console.log(`Registry adapters: ${report.checks.registry.adapters.length}`);
    console.log(`Submission bundle files: ${report.checks.bundle.files.length}`);
    console.log(`External dry-run adapters: ${report.checks.externalDryRun.adapters}`);
    console.log(`External live evidence: ${report.checks.externalEvidence.verified} verified, ${report.checks.externalEvidence.pending} pending`);
    console.log(`Leaderboard rows: ${report.checks.leaderboard.rows}`);
    console.log(`Local path sweep: ${report.checks.localPaths.filesChecked.length} files plus bundle`);
  } else {
    console.error('GuardBench publication artifact verification failed:');
    for (const failure of report.failures) console.error(`- ${failure}`);
  }

  if (!report.ok) process.exit(1);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(error.stack ?? error.message);
    process.exit(1);
  });
}
