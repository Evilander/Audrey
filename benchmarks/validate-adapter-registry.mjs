import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateSchema } from './validate-guardbench-artifacts.mjs';
import { validateAdapterModuleFile } from './validate-adapter-module.mjs';
import { publicPath } from './public-paths.mjs';

const DEFAULT_REGISTRY = 'benchmarks/adapters/registry.json';
const DEFAULT_SCHEMA = 'benchmarks/schemas/guardbench-adapter-registry.schema.json';

export function parseAdapterRegistryValidatorArgs(argv = process.argv.slice(2)) {
  const args = {
    registry: DEFAULT_REGISTRY,
    schema: DEFAULT_SCHEMA,
    json: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === '--registry' && argv[i + 1]) args.registry = argv[++i];
    else if (token === '--schema' && argv[i + 1]) args.schema = argv[++i];
    else if (token === '--json') args.json = true;
    else if (token === '--help' || token === '-h') args.help = true;
    else throw new Error(`Unknown argument: ${token}`);
  }

  return args;
}

function usage() {
  return `Usage: node benchmarks/validate-adapter-registry.mjs [options]

Options:
  --registry <path>   Adapter registry JSON. Default: ${DEFAULT_REGISTRY}.
  --schema <path>     Adapter registry JSON schema. Default: ${DEFAULT_SCHEMA}.
  --json              Print the machine-readable validation report.
`;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf-8'));
}

export async function validateAdapterRegistry(options = {}) {
  const registryPath = resolve(options.registry ?? DEFAULT_REGISTRY);
  const schemaPath = resolve(options.schema ?? DEFAULT_SCHEMA);
  const failures = [];
  let registry = null;

  try {
    registry = readJson(registryPath);
  } catch (error) {
    failures.push(error.message);
  }

  try {
    const schema = readJson(schemaPath);
    if (registry) failures.push(...validateSchema(registry, schema, 'guardbench-adapter-registry'));
  } catch (error) {
    failures.push(error.message);
  }

  const ids = new Set();
  const adapterReports = [];
  for (const adapter of registry?.adapters ?? []) {
    if (ids.has(adapter.id)) failures.push(`Duplicate adapter id: ${adapter.id}`);
    ids.add(adapter.id);
    if (adapter.credentialMode === 'none' && adapter.requiredEnv.length !== 0) {
      failures.push(`Adapter ${adapter.id} has credentialMode=none but declares requiredEnv`);
    }
    if (adapter.credentialMode === 'runtime-env' && adapter.requiredEnv.length === 0) {
      failures.push(`Adapter ${adapter.id} has credentialMode=runtime-env but declares no requiredEnv`);
    }
    for (const [commandName, command] of Object.entries(adapter.commands ?? {})) {
      if ((commandName === 'moduleValidate' || commandName === 'selfTest') && !command.includes(adapter.path)) {
        failures.push(`Adapter ${adapter.id} command ${commandName} does not reference ${adapter.path}`);
      }
    }
    if (!existsSync(resolve(adapter.path))) {
      failures.push(`Adapter ${adapter.id} path does not exist: ${adapter.path}`);
      continue;
    }
    const report = await validateAdapterModuleFile({ adapter: adapter.path });
    adapterReports.push({
      id: adapter.id,
      ok: report.ok,
      adapter: report.adapter,
      credentialMode: adapter.credentialMode,
      failures: report.failures,
    });
    if (!report.ok) {
      failures.push(`Adapter ${adapter.id} failed module validation: ${report.failures.join('; ')}`);
    }
    if (report.adapter?.name && report.adapter.name !== adapter.name) {
      failures.push(`Adapter ${adapter.id} registry name ${adapter.name} does not match module name ${report.adapter.name}`);
    }
  }

  return {
    ok: failures.length === 0,
    registry: publicPath(registryPath),
    schema: publicPath(schemaPath),
    adapters: adapterReports,
    failures,
  };
}

async function main() {
  const args = parseAdapterRegistryValidatorArgs();
  if (args.help) {
    console.log(usage());
    return;
  }

  const validation = await validateAdapterRegistry(args);
  if (args.json) {
    console.log(JSON.stringify(validation, null, 2));
  } else if (validation.ok) {
    console.log(`GuardBench adapter registry validation passed: ${validation.registry}`);
    console.log(`Adapters: ${validation.adapters.length}`);
  } else {
    console.error('GuardBench adapter registry validation failed:');
    for (const failure of validation.failures) console.error(`- ${failure}`);
  }

  if (!validation.ok) process.exit(1);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(error.stack ?? error.message);
    process.exit(1);
  });
}
