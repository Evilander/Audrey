import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateAdapterSelfTestReport } from './adapter-self-test.mjs';
import { publicPath } from './public-paths.mjs';

const DEFAULT_REPORT = 'benchmarks/output/adapter-self-test/guardbench-adapter-self-test.json';

export function parseAdapterSelfTestValidatorArgs(argv = process.argv.slice(2)) {
  const args = {
    report: DEFAULT_REPORT,
    schema: undefined,
    json: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if ((token === '--report' || token === '--file') && argv[i + 1]) args.report = argv[++i];
    else if (token === '--schema' && argv[i + 1]) args.schema = argv[++i];
    else if (token === '--json') args.json = true;
    else if (token === '--help' || token === '-h') args.help = true;
    else throw new Error(`Unknown argument: ${token}`);
  }

  return args;
}

function usage() {
  return `Usage: node benchmarks/validate-adapter-self-test.mjs [options]

Options:
  --report <path>   Adapter self-test JSON report. Default: ${DEFAULT_REPORT}.
  --schema <path>   Optional alternate schema path.
  --json            Print the machine-readable validation report.
`;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf-8'));
}

export function validateAdapterSelfTestFile(options = {}) {
  const reportPath = resolve(options.report ?? DEFAULT_REPORT);
  const failures = [];
  let report = null;

  if (!existsSync(reportPath)) {
    failures.push(`Missing adapter self-test report: ${reportPath}`);
  } else {
    try {
      report = readJson(reportPath);
      failures.push(...validateAdapterSelfTestReport(report, { schema: options.schema }));
    } catch (error) {
      failures.push(error.message);
    }
  }

  return {
    ok: failures.length === 0,
    report: publicPath(reportPath),
    adapter: report?.adapter?.name ?? null,
    scenarios: report?.conformance?.scenarios ?? null,
    expectedScenarios: report?.conformance?.expectedScenarios ?? null,
    lowScoreAllowed: report?.contract?.lowScoreAllowed ?? null,
    failures,
  };
}

async function main() {
  const args = parseAdapterSelfTestValidatorArgs();
  if (args.help) {
    console.log(usage());
    return;
  }

  const validation = validateAdapterSelfTestFile(args);
  if (args.json) {
    console.log(JSON.stringify(validation, null, 2));
  } else if (validation.ok) {
    console.log(`GuardBench adapter self-test validation passed: ${validation.report}`);
    console.log(`Adapter: ${validation.adapter}`);
    console.log(`Rows: ${validation.scenarios}/${validation.expectedScenarios}`);
  } else {
    console.error('GuardBench adapter self-test validation failed:');
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
