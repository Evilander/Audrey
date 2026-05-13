import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateAdapterRegistry } from './validate-adapter-registry.mjs';
import { validateGuardBenchArtifacts, validateSchema } from './validate-guardbench-artifacts.mjs';
import { publicPath } from './public-paths.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_REGISTRY = 'benchmarks/adapters/registry.json';
const DEFAULT_REGISTRY_SCHEMA = 'benchmarks/schemas/guardbench-adapter-registry.schema.json';
const DEFAULT_EXTERNAL_RUN_SCHEMA = 'benchmarks/schemas/guardbench-external-run.schema.json';
const DEFAULT_EVIDENCE_SCHEMA = 'benchmarks/schemas/guardbench-external-evidence.schema.json';
const DEFAULT_OUT_ROOT = 'benchmarks/output/external';
const DEFAULT_REPORT = 'benchmarks/output/external/guardbench-external-evidence.json';
const PENDING_METADATA_STATUSES = new Set(['blocked', 'dry-run-missing-env', 'dry-run-ready']);

function fromRoot(path) {
  return resolve(ROOT, path);
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf-8'));
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf-8');
}

export function parseExternalEvidenceArgs(argv = process.argv.slice(2)) {
  const args = {
    registry: DEFAULT_REGISTRY,
    registrySchema: DEFAULT_REGISTRY_SCHEMA,
    externalRunSchema: DEFAULT_EXTERNAL_RUN_SCHEMA,
    evidenceSchema: DEFAULT_EVIDENCE_SCHEMA,
    outRoot: DEFAULT_OUT_ROOT,
    report: DEFAULT_REPORT,
    adapters: [],
    allowPending: false,
    json: false,
    write: true,
  };

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === '--registry' && argv[i + 1]) args.registry = argv[++i];
    else if (token === '--registry-schema' && argv[i + 1]) args.registrySchema = argv[++i];
    else if (token === '--external-run-schema' && argv[i + 1]) args.externalRunSchema = argv[++i];
    else if (token === '--evidence-schema' && argv[i + 1]) args.evidenceSchema = argv[++i];
    else if (token === '--out-root' && argv[i + 1]) args.outRoot = argv[++i];
    else if (token === '--report' && argv[i + 1]) args.report = argv[++i];
    else if (token === '--adapter' && argv[i + 1]) args.adapters.push(argv[++i]);
    else if (token === '--allow-pending') args.allowPending = true;
    else if (token === '--json') args.json = true;
    else if (token === '--no-write') args.write = false;
    else if (token === '--help' || token === '-h') args.help = true;
    else throw new Error(`Unknown argument: ${token}`);
  }

  return args;
}

function usage() {
  return `Usage: node benchmarks/verify-external-evidence.mjs [options]

Options:
  --registry <path>             GuardBench adapter registry. Default: ${DEFAULT_REGISTRY}.
  --out-root <path>             External evidence root. Default: ${DEFAULT_OUT_ROOT}.
  --report <path>               Output report path. Default: ${DEFAULT_REPORT}.
  --adapter <id>                Limit verification to one adapter id. May repeat.
  --allow-pending               Treat missing, blocked, or dry-run-only evidence as pending.
  --json                        Print the machine-readable evidence report.
  --no-write                    Do not write the evidence report.
`;
}

function credentialLeaks(text, requiredEnv, env) {
  const leaks = [];
  for (const name of requiredEnv) {
    const value = env[name];
    if (typeof value === 'string' && value.length >= 8 && text.includes(value)) {
      leaks.push(name);
    }
  }
  return leaks;
}

function pendingRow(target, outDir, metadataPath, allowPending, reason, metadata = null, extraFailures = [], secretLeakCount = 0) {
  return {
    id: target.id,
    name: target.name,
    path: target.path,
    credentialMode: target.credentialMode,
    requiredEnv: target.requiredEnv,
    outDir: publicPath(outDir),
    metadataPath: publicPath(metadataPath),
    status: 'pending',
    evidenceKind: metadata?.dryRun ? 'dry-run' : reason === 'missing' ? 'missing' : 'blocked',
    metadataStatus: metadata?.status ?? null,
    dryRun: metadata?.dryRun ?? null,
    missingEnv: metadata?.missingEnv ?? target.requiredEnv,
    artifactValidationOk: null,
    adapterConformanceOk: null,
    secretLeakCount,
    failures: allowPending ? extraFailures : [
      ...extraFailures,
      reason === 'missing'
        ? `Missing external run metadata: ${metadataPath}`
        : `External evidence is pending for ${target.id}: ${metadata?.status ?? reason}`,
    ],
  };
}

function verifyLiveMetadata(target, outDir, metadataPath, metadata, metadataText, schemas, env) {
  const failures = [];
  const schemaErrors = validateSchema(metadata, schemas.externalRun, 'guardbench-externalRun');
  failures.push(...schemaErrors);

  const artifactValidation = validateGuardBenchArtifacts({ dir: outDir });
  if (!artifactValidation.ok) {
    failures.push(...artifactValidation.failures.map(failure => `artifact validation: ${failure}`));
  }

  if (metadata.adapter !== target.id) failures.push(`metadata adapter ${metadata.adapter} does not match registry id ${target.id}`);
  if (metadata.dryRun !== false) failures.push('metadata must come from a live run, not a dry run');
  if (metadata.status !== 'passed') failures.push(`metadata status must be passed, got ${metadata.status}`);
  if (metadata.exitCode !== 0) failures.push(`metadata exitCode must be 0, got ${metadata.exitCode}`);
  if ((metadata.missingEnv ?? []).length !== 0) failures.push(`metadata still reports missing runtime env: ${(metadata.missingEnv ?? []).join(', ')}`);
  for (const name of target.requiredEnv) {
    if (!(metadata.requiredEnv ?? []).includes(name)) failures.push(`metadata requiredEnv missing ${name}`);
  }
  if (metadata.artifactValidation?.ok !== true) failures.push('metadata artifactValidation.ok must be true');
  if (metadata.adapterConformance?.ok !== true) failures.push('metadata adapterConformance.ok must be true');
  if (!metadata.artifactHashes) failures.push('metadata missing artifactHashes');

  const leakedEnv = credentialLeaks(metadataText, target.requiredEnv, env);
  failures.push(...leakedEnv.map(name => `metadata leaks runtime credential value for ${name}`));

  return {
    id: target.id,
    name: target.name,
    path: target.path,
    credentialMode: target.credentialMode,
    requiredEnv: target.requiredEnv,
    outDir: publicPath(outDir),
    metadataPath: publicPath(metadataPath),
    status: failures.length === 0 ? 'verified' : 'failed',
    evidenceKind: 'live',
    metadataStatus: metadata.status ?? null,
    dryRun: metadata.dryRun ?? null,
    missingEnv: metadata.missingEnv ?? [],
    artifactValidationOk: artifactValidation.ok,
    adapterConformanceOk: metadata.adapterConformance?.ok ?? null,
    secretLeakCount: leakedEnv.length,
    failures,
  };
}

function verifyTarget(target, options, schemas) {
  const outDir = resolve(options.outRoot, target.id);
  const metadataPath = join(outDir, 'external-run-metadata.json');

  if (!existsSync(metadataPath)) {
    return pendingRow(target, outDir, metadataPath, options.allowPending, 'missing');
  }

  let metadata = null;
  let metadataText = '';
  const parseFailures = [];
  try {
    metadataText = readFileSync(metadataPath, 'utf-8');
    metadata = JSON.parse(metadataText);
  } catch (error) {
    parseFailures.push(error.message);
  }

  if (!metadata) {
    return {
      id: target.id,
      name: target.name,
    path: target.path,
    credentialMode: target.credentialMode,
    requiredEnv: target.requiredEnv,
    outDir: publicPath(outDir),
    metadataPath: publicPath(metadataPath),
      status: 'failed',
      evidenceKind: 'missing',
      metadataStatus: null,
      dryRun: null,
      missingEnv: target.requiredEnv,
      artifactValidationOk: null,
      adapterConformanceOk: null,
      secretLeakCount: 0,
      failures: parseFailures,
    };
  }

  const metadataSchemaFailures = validateSchema(metadata, schemas.externalRun, 'guardbench-externalRun');
  const leakedEnv = credentialLeaks(metadataText, target.requiredEnv, options.env);
  const metadataFailures = [
    ...metadataSchemaFailures,
    ...leakedEnv.map(name => `metadata leaks runtime credential value for ${name}`),
  ];

  if (metadata.dryRun === true || PENDING_METADATA_STATUSES.has(metadata.status)) {
    return pendingRow(target, outDir, metadataPath, options.allowPending, metadata.status ?? 'pending', metadata, metadataFailures, leakedEnv.length);
  }

  return verifyLiveMetadata(target, outDir, metadataPath, metadata, metadataText, schemas, options.env);
}

function externalTargetsFromRegistry(registry, adapterIds) {
  const selected = new Set(adapterIds ?? []);
  return (registry.adapters ?? [])
    .filter(adapter => adapter.credentialMode === 'runtime-env')
    .filter(adapter => selected.size === 0 || selected.has(adapter.id));
}

export function validateExternalEvidenceReport(report, options = {}) {
  const schema = readJson(fromRoot(options.schema ?? DEFAULT_EVIDENCE_SCHEMA));
  return validateSchema(report, schema, 'guardbench-external-evidence');
}

export async function verifyExternalGuardBenchEvidence(options = {}) {
  const registryPath = fromRoot(options.registry ?? DEFAULT_REGISTRY);
  const registrySchemaPath = fromRoot(options.registrySchema ?? DEFAULT_REGISTRY_SCHEMA);
  const outRoot = fromRoot(options.outRoot ?? DEFAULT_OUT_ROOT);
  const allowPending = options.allowPending === true;
  const registry = options.targets ? null : readJson(registryPath);
  const registryValidation = options.targets
    ? { ok: true, failures: [] }
    : await validateAdapterRegistry({ registry: registryPath, schema: registrySchemaPath });
  const targets = options.targets ?? externalTargetsFromRegistry(registry, options.adapters);
  const schemas = {
    externalRun: readJson(fromRoot(options.externalRunSchema ?? DEFAULT_EXTERNAL_RUN_SCHEMA)),
  };
  const rows = targets.map(target => verifyTarget(target, {
    outRoot,
    allowPending,
    env: options.env ?? process.env,
  }, schemas));
  const unknownAdapters = (options.adapters ?? []).filter(id => !targets.some(target => target.id === id));
  const failures = [
    ...registryValidation.failures.map(failure => `registry: ${failure}`),
    ...unknownAdapters.map(id => `Unknown runtime-env adapter id: ${id}`),
    ...rows.flatMap(row => row.failures.map(failure => `${row.id}: ${failure}`)),
  ];
  const report = {
    schemaVersion: '1.0.0',
    suite: 'GuardBench external evidence verification',
    generatedAt: new Date().toISOString(),
    ok: failures.length === 0,
    allowPending,
    registry: options.targets ? 'inline-targets' : publicPath(registryPath),
    outRoot: publicPath(outRoot),
    adapters: rows,
    failures,
  };
  const schemaFailures = validateExternalEvidenceReport(report, { schema: options.evidenceSchema ?? DEFAULT_EVIDENCE_SCHEMA });
  if (schemaFailures.length > 0) {
    throw new Error(`GuardBench external evidence schema validation failed: ${schemaFailures.join('; ')}`);
  }
  if (options.write !== false) {
    writeJson(fromRoot(options.report ?? DEFAULT_REPORT), report);
  }
  return report;
}

async function main() {
  const args = parseExternalEvidenceArgs();
  if (args.help) {
    console.log(usage());
    return;
  }

  const report = await verifyExternalGuardBenchEvidence(args);
  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
  } else if (report.ok) {
    const verified = report.adapters.filter(adapter => adapter.status === 'verified').length;
    const pending = report.adapters.filter(adapter => adapter.status === 'pending').length;
    console.log(`GuardBench external evidence verification passed: ${verified} verified, ${pending} pending`);
  } else {
    console.error('GuardBench external evidence verification failed:');
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
