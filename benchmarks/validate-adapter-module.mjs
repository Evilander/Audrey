import { existsSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { validateGuardBenchAdapter } from './guardbench.js';
import { publicPath } from './public-paths.mjs';

const DEFAULT_ADAPTER = 'benchmarks/adapters/example-allow.mjs';

export function parseAdapterModuleValidatorArgs(argv = process.argv.slice(2)) {
  const args = {
    adapter: DEFAULT_ADAPTER,
    json: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === '--adapter' && argv[i + 1]) args.adapter = argv[++i];
    else if (token === '--json') args.json = true;
    else if (token === '--help' || token === '-h') args.help = true;
    else throw new Error(`Unknown argument: ${token}`);
  }

  return args;
}

function usage() {
  return `Usage: node benchmarks/validate-adapter-module.mjs [options]

Options:
  --adapter <path>   ESM GuardBench adapter module. Default: ${DEFAULT_ADAPTER}.
  --json             Print the machine-readable validation report.
`;
}

export async function validateAdapterModuleFile(options = {}) {
  const adapterPath = resolve(options.adapter ?? DEFAULT_ADAPTER);
  const failures = [];
  let adapter = null;

  if (!existsSync(adapterPath)) {
    failures.push(`Adapter not found: ${adapterPath}`);
  } else {
    try {
      const mod = await import(pathToFileURL(adapterPath).href);
      const candidate = typeof mod.createGuardBenchAdapter === 'function'
        ? await mod.createGuardBenchAdapter()
        : mod.default ?? mod.adapter;
      adapter = validateGuardBenchAdapter(candidate, adapterPath);
    } catch (error) {
      failures.push(error.message);
    }
  }

  return {
    ok: failures.length === 0,
    adapterPath: publicPath(adapterPath),
    moduleFile: basename(adapterPath),
    adapter: adapter
      ? {
        name: adapter.name,
        description: adapter.description ?? null,
        hasSetup: typeof adapter.setup === 'function',
        hasDecide: typeof adapter.decide === 'function',
        hasCleanup: typeof adapter.cleanup === 'function',
      }
      : null,
    contract: {
      moduleFormat: 'ESM',
      exports: ['default', 'adapter', 'createGuardBenchAdapter'],
      requiredMethods: ['decide'],
      optionalMethods: ['setup', 'cleanup'],
    },
    failures,
  };
}

async function main() {
  const args = parseAdapterModuleValidatorArgs();
  if (args.help) {
    console.log(usage());
    return;
  }

  const validation = await validateAdapterModuleFile(args);
  if (args.json) {
    console.log(JSON.stringify(validation, null, 2));
  } else if (validation.ok) {
    console.log(`GuardBench adapter module validation passed: ${validation.adapterPath}`);
    console.log(`Adapter: ${validation.adapter.name}`);
    console.log(`Methods: setup=${validation.adapter.hasSetup}, decide=${validation.adapter.hasDecide}, cleanup=${validation.adapter.hasCleanup}`);
  } else {
    console.error('GuardBench adapter module validation failed:');
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
