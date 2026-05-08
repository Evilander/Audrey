import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildExternalGuardBenchRun, writeExternalRunMetadata } from './run-external-guardbench.mjs';
import { validateAdapterRegistry } from './validate-adapter-registry.mjs';
import { validateSchema } from './validate-guardbench-artifacts.mjs';
import { publicCommand, publicPath } from './public-paths.mjs';

const DEFAULT_REGISTRY = 'benchmarks/adapters/registry.json';
const DEFAULT_OUT_ROOT = 'benchmarks/output/external';
const DEFAULT_OUT = 'benchmarks/output/external/guardbench-external-dry-run.json';
const DEFAULT_SCHEMA = 'benchmarks/schemas/guardbench-external-dry-run.schema.json';

export function parseExternalDryRunArgs(argv = process.argv.slice(2)) {
  const args = {
    registry: DEFAULT_REGISTRY,
    outRoot: DEFAULT_OUT_ROOT,
    out: DEFAULT_OUT,
    includeCredentialFree: false,
    json: false,
    noWrite: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === '--registry' && argv[i + 1]) args.registry = argv[++i];
    else if (token === '--out-root' && argv[i + 1]) args.outRoot = argv[++i];
    else if (token === '--out' && argv[i + 1]) args.out = argv[++i];
    else if (token === '--include-credential-free') args.includeCredentialFree = true;
    else if (token === '--json') args.json = true;
    else if (token === '--no-write') args.noWrite = true;
    else if (token === '--help' || token === '-h') args.help = true;
    else throw new Error(`Unknown argument: ${token}`);
  }

  return args;
}

function usage() {
  return `Usage: node benchmarks/dry-run-external-adapters.mjs [options]

Options:
  --registry <path>              Adapter registry JSON. Default: ${DEFAULT_REGISTRY}.
  --out-root <path>              Root directory for dry-run metadata. Default: ${DEFAULT_OUT_ROOT}.
  --out <path>                   Matrix JSON report path. Default: ${DEFAULT_OUT}.
  --include-credential-free      Include credential-free registry adapters.
  --json                         Print the machine-readable dry-run matrix.
  --no-write                     Do not write the matrix JSON report.
`;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf-8'));
}

export function validateExternalAdapterDryRunMatrix(matrix, options = {}) {
  const schema = options.schemaObject ?? readJson(options.schema ?? DEFAULT_SCHEMA);
  return validateSchema(matrix, schema, 'guardbench-external-dry-run');
}

export function writeExternalAdapterDryRunMatrix(matrix, out = DEFAULT_OUT) {
  const outPath = resolve(out);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(matrix, null, 2)}\n`, 'utf-8');
  return outPath;
}

export async function buildExternalAdapterDryRunMatrix(options = {}) {
  const registryPath = options.registry ?? DEFAULT_REGISTRY;
  const outRoot = resolve(options.outRoot ?? DEFAULT_OUT_ROOT);
  const registryValidation = await validateAdapterRegistry({ registry: registryPath });
  const registry = readJson(registryPath);
  const adapters = registry.adapters.filter(adapter =>
    adapter.status === 'external-system'
    && (options.includeCredentialFree || adapter.credentialMode === 'runtime-env'));
  const rows = [];
  const failures = [];

  if (!registryValidation.ok) {
    failures.push(...registryValidation.failures.map(failure => `registry: ${failure}`));
  }

  for (const adapter of adapters) {
    const run = buildExternalGuardBenchRun({
      adapter: adapter.id,
      outDir: join(outRoot, adapter.id),
      check: true,
      json: true,
    }, options.env ?? process.env);
    const metadata = {
      suite: 'GuardBench external adapter run',
      startedAt: new Date().toISOString(),
      adapter: run.adapter,
      adapterPath: run.adapterPath,
      outDir: run.outDir,
      requiredEnv: run.requiredEnv,
      missingEnv: run.missingEnv,
      command: run.command,
      validationCommand: run.validationCommand,
      dryRun: true,
      status: run.missingEnv.length ? 'dry-run-missing-env' : 'dry-run-ready',
    };
    const metadataPath = writeExternalRunMetadata(run.outDir, metadata);
    rows.push({
      id: adapter.id,
      name: adapter.name,
      credentialMode: adapter.credentialMode,
      requiredEnv: run.requiredEnv,
      missingEnv: run.missingEnv,
      status: metadata.status,
      command: publicCommand(run.command),
      validationCommand: publicCommand(run.validationCommand),
      metadataPath: publicPath(metadataPath),
    });
  }

  const matrix = {
    schemaVersion: '1.0.0',
    suite: 'GuardBench external adapter dry-run matrix',
    generatedAt: new Date().toISOString(),
    ok: failures.length === 0,
    registry: publicPath(resolve(registryPath)),
    outRoot: publicPath(outRoot),
    adapters: rows,
    failures,
  };
  const schemaFailures = validateExternalAdapterDryRunMatrix(matrix, options);
  if (schemaFailures.length > 0) {
    throw new Error(`GuardBench external adapter dry-run schema validation failed: ${schemaFailures.join('; ')}`);
  }
  return matrix;
}

async function main() {
  const args = parseExternalDryRunArgs();
  if (args.help) {
    console.log(usage());
    return;
  }

  const matrix = await buildExternalAdapterDryRunMatrix(args);
  const outPath = args.noWrite ? null : writeExternalAdapterDryRunMatrix(matrix, args.out);
  if (args.json) {
    console.log(JSON.stringify(matrix, null, 2));
  } else if (matrix.ok) {
    console.log(`GuardBench external adapter dry-run matrix passed: ${matrix.adapters.length} adapter(s)`);
    for (const row of matrix.adapters) {
      const missing = row.missingEnv.length ? `missing ${row.missingEnv.join(', ')}` : 'ready';
      console.log(`- ${row.id}: ${missing}; metadata ${row.metadataPath}`);
    }
    if (outPath) console.log(`Matrix report: ${outPath}`);
  } else {
    console.error('GuardBench external adapter dry-run matrix failed:');
    for (const failure of matrix.failures) console.error(`- ${failure}`);
  }

  if (!matrix.ok) process.exit(1);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(error.stack ?? error.message);
    process.exit(1);
  });
}
