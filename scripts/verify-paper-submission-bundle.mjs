import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateSchema } from '../benchmarks/validate-guardbench-artifacts.mjs';
import { publicPath, scanFilesForLocalPaths } from '../benchmarks/public-paths.mjs';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const DEFAULT_DIR = 'docs/paper/output/submission-bundle';
const DEFAULT_SCHEMA = 'docs/paper/paper-submission-bundle.schema.json';
const REQUIRED_FILES = [
  'README.md',
  'LICENSE',
  'package.json',
  'docs/paper/arxiv-compile-report.schema.json',
  'docs/paper/output/arxiv/main.tex',
  'docs/paper/output/arxiv/references.bib',
  'docs/paper/output/arxiv/arxiv-manifest.json',
  'docs/paper/output/arxiv-compile-report.json',
  'docs/paper/audrey-paper-v1.md',
  'docs/paper/browser-launch-plan.json',
  'docs/paper/browser-launch-plan.schema.json',
  'docs/paper/browser-launch-results.json',
  'docs/paper/browser-launch-results.schema.json',
  'docs/paper/claim-register.json',
  'docs/paper/publication-pack.json',
  'docs/paper/evidence-ledger.md',
  'docs/paper/references.bib',
  'docs/paper/SUBMISSION_README.md',
  'benchmarks/output/guardbench-summary.json',
  'benchmarks/output/guardbench-raw.json',
  'benchmarks/output/external/guardbench-external-evidence.json',
  'benchmarks/output/submission-bundle/submission-manifest.json',
];
const PASSED_COMPILE_FILES = [
  'docs/paper/output/arxiv-compile/main.pdf',
  'docs/paper/output/arxiv-compile/arxiv-compile.log',
];

function fromRoot(path) {
  return resolve(ROOT, path);
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf-8'));
}

function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function walkFiles(dir, root = dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return walkFiles(path, root);
    return relative(root, path).replaceAll('\\', '/');
  });
}

function parseArgs(argv = process.argv.slice(2)) {
  const args = {
    dir: DEFAULT_DIR,
    schema: DEFAULT_SCHEMA,
    checkSourceFreshness: true,
    json: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if ((token === '--dir' || token === '--bundle-dir') && argv[i + 1]) args.dir = argv[++i];
    else if (token === '--schema' && argv[i + 1]) args.schema = argv[++i];
    else if (token === '--no-source-check') args.checkSourceFreshness = false;
    else if (token === '--json') args.json = true;
    else if (token === '--help' || token === '-h') args.help = true;
    else throw new Error(`Unknown argument: ${token}`);
  }
  return args;
}

function usage() {
  return `Usage: node scripts/verify-paper-submission-bundle.mjs [options]

Options:
  --dir <path>     Paper submission bundle directory. Default: ${DEFAULT_DIR}.
  --schema <path>  Bundle manifest schema. Default: ${DEFAULT_SCHEMA}.
  --no-source-check
                  Skip checking bundled hashes against current source files.
  --json           Print the machine-readable verification report.
`;
}

export function verifyPaperSubmissionBundle(options = {}) {
  const dir = fromRoot(options.dir ?? DEFAULT_DIR);
  const schemaPath = fromRoot(options.schema ?? DEFAULT_SCHEMA);
  const checkSourceFreshness = options.checkSourceFreshness !== false;
  const manifestPath = join(dir, 'paper-submission-manifest.json');
  const failures = [];
  let manifest = null;

  try {
    manifest = readJson(manifestPath);
  } catch (error) {
    return {
      ok: false,
      dir,
      files: [],
      failures: [`paper-submission-manifest.json: ${error.message}`],
    };
  }

  try {
    const schema = readJson(schemaPath);
    failures.push(...validateSchema(manifest, schema, 'audrey-paper-submission-bundle'));
  } catch (error) {
    failures.push(`schema: ${error.message}`);
  }

  const listed = new Map((manifest.files ?? []).map(file => [file.path, file]));
  for (const file of REQUIRED_FILES) {
    if (!listed.has(file)) failures.push(`paper-submission-manifest.json: missing required file record ${file}`);
  }
  const compileReport = listed.has('docs/paper/output/arxiv-compile-report.json')
    ? readJson(join(dir, 'docs/paper/output/arxiv-compile-report.json'))
    : null;
  if (compileReport?.status === 'passed') {
    for (const file of PASSED_COMPILE_FILES) {
      if (!listed.has(file)) failures.push(`paper-submission-manifest.json: missing compile-proof file record ${file}`);
    }
  }
  if (listed.has('paper-submission-manifest.json')) {
    failures.push('paper-submission-manifest.json: must not include a self-hash file record');
  }

  for (const [file, record] of listed) {
    const path = join(dir, file);
    if (!existsSync(path)) {
      failures.push(`${file}: listed in manifest but missing from bundle`);
      continue;
    }
    const bytes = readFileSync(path).byteLength;
    if (record.bytes !== bytes) failures.push(`${file}: byte length mismatch`);
    const sha256 = sha256File(path);
    if (record.sha256 !== sha256) failures.push(`${file}: sha256 mismatch`);
    if (checkSourceFreshness && record.source) {
      const sourcePath = fromRoot(record.source);
      if (existsSync(sourcePath)) {
        const sourceBytes = readFileSync(sourcePath).byteLength;
        const sourceSha256 = sha256File(sourcePath);
        if (record.bytes !== sourceBytes || record.sha256 !== sourceSha256) {
          failures.push(`${file}: source file has changed since bundle creation`);
        }
      }
    }
  }

  const actualFiles = walkFiles(dir).filter(file => file !== 'paper-submission-manifest.json').sort();
  const listedFiles = [...listed.keys()].sort();
  const actualSet = new Set(actualFiles);
  const listedSet = new Set(listedFiles);
  for (const file of actualFiles) {
    if (!listedSet.has(file)) failures.push(`${file}: present in bundle but missing from manifest`);
  }
  for (const file of listedFiles) {
    if (!actualSet.has(file)) failures.push(`${file}: listed in manifest but not present in bundle`);
  }
  for (const file of scanFilesForLocalPaths(dir, actualFiles)) {
    failures.push(`${file}: contains a local absolute path`);
  }
  if (manifest.claimVerification?.ok !== true) failures.push('paper-submission-manifest.json: claimVerification is not ok');
  if (manifest.publicationPackVerification?.ok !== true) failures.push('paper-submission-manifest.json: publicationPackVerification is not ok');
  if (manifest.guardBenchSnapshot?.passed !== 10) failures.push('paper-submission-manifest.json: GuardBench passed count is not 10');
  if (manifest.guardBenchSnapshot?.scenarios !== 10) failures.push('paper-submission-manifest.json: GuardBench scenario count is not 10');
  if (manifest.guardBenchSnapshot?.redactionLeaks !== 0) failures.push('paper-submission-manifest.json: GuardBench decision redaction leaks are not 0');
  if (manifest.guardBenchSnapshot?.artifactLeaks !== 0) failures.push('paper-submission-manifest.json: GuardBench artifact leaks are not 0');

  return {
    ok: failures.length === 0,
    dir: publicPath(dir),
    manifestPath: publicPath(manifestPath),
    files: listedFiles,
    failures,
  };
}

async function main() {
  const args = parseArgs();
  if (args.help) {
    console.log(usage());
    return;
  }

  const report = verifyPaperSubmissionBundle(args);
  if (args.json) console.log(JSON.stringify(report, null, 2));
  else if (report.ok) console.log(`Paper submission bundle verification passed: ${report.dir}`);
  else {
    console.error('Paper submission bundle verification failed:');
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
