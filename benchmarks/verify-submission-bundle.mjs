import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, relative, resolve } from 'node:path';
import { validateGuardBenchArtifacts, validateSchema } from './validate-guardbench-artifacts.mjs';
import { publicPath, scanFilesForLocalPaths } from './public-paths.mjs';

const REQUIRED_FILES = [
  'guardbench-conformance-card.json',
  'guardbench-manifest.json',
  'guardbench-raw.json',
  'guardbench-summary.json',
  'schemas/guardbench-adapter-registry.schema.json',
  'schemas/guardbench-adapter-self-test.schema.json',
  'schemas/guardbench-conformance-card.schema.json',
  'schemas/guardbench-external-dry-run.schema.json',
  'schemas/guardbench-external-evidence.schema.json',
  'schemas/guardbench-external-run.schema.json',
  'schemas/guardbench-leaderboard.schema.json',
  'schemas/guardbench-manifest.schema.json',
  'schemas/guardbench-publication-verification.schema.json',
  'schemas/guardbench-raw.schema.json',
  'schemas/guardbench-summary.schema.json',
  'schemas/guardbench-submission-manifest.schema.json',
  'validation-report.json',
];

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

export function verifyGuardBenchSubmissionBundle(options = {}) {
  const dir = resolve(options.dir ?? 'benchmarks/output/submission-bundle');
  const manifestPath = join(dir, 'submission-manifest.json');
  const failures = [];
  let manifest = null;

  try {
    manifest = readJson(manifestPath);
  } catch (error) {
    failures.push(`submission-manifest.json: ${error.message}`);
  }

  if (!manifest) {
    return { ok: false, dir, failures };
  }

  if (manifest.suite !== 'GuardBench submission bundle') {
    failures.push('submission-manifest.json: suite must be GuardBench submission bundle');
  }
  try {
    const schema = readJson(join(dir, 'schemas', 'guardbench-submission-manifest.schema.json'));
    for (const error of validateSchema(manifest, schema, 'submission-manifest')) {
      failures.push(`submission-manifest.json: ${error}`);
    }
  } catch (error) {
    failures.push(`schemas/guardbench-submission-manifest.schema.json: ${error.message}`);
  }
  const listed = new Map((manifest.files ?? []).map(file => [file.path, file]));
  for (const file of REQUIRED_FILES) {
    if (!listed.has(file)) failures.push(`submission-manifest.json: missing required file record ${file}`);
  }
  if (listed.has('submission-manifest.json')) {
    failures.push('submission-manifest.json: must not include a self-hash file record');
  }

  for (const [file, record] of listed) {
    const path = join(dir, file);
    if (!existsSync(path)) {
      failures.push(`${file}: listed in manifest but missing from bundle`);
      continue;
    }
    const actualHash = sha256File(path);
    if (record.sha256 !== actualHash) failures.push(`${file}: sha256 mismatch`);
    const actualBytes = readFileSync(path).byteLength;
    if (record.bytes !== actualBytes) failures.push(`${file}: byte length mismatch`);
  }

  const actualFiles = walkFiles(dir).filter(file => file !== 'submission-manifest.json').sort();
  const listedFiles = [...listed.keys()].sort();
  const actualSet = new Set(actualFiles);
  const listedSet = new Set(listedFiles);
  for (const file of actualFiles) {
    if (!listedSet.has(file)) failures.push(`${file}: present in bundle but missing from manifest`);
  }
  for (const file of listedFiles) {
    if (!actualSet.has(file)) failures.push(`${file}: listed in manifest but not present in bundle`);
  }

  const artifactValidation = validateGuardBenchArtifacts({
    dir,
    schemasDir: join(dir, 'schemas'),
  });
  if (!artifactValidation.ok) {
    failures.push(...artifactValidation.failures.map(failure => `artifact validation: ${failure}`));
  }
  if (manifest.validation?.ok !== true) {
    failures.push('submission-manifest.json: embedded validation status is not ok');
  }
  for (const file of scanFilesForLocalPaths(dir, actualFiles)) {
    failures.push(`${file}: contains a local absolute path`);
  }

  return {
    ok: failures.length === 0,
    dir: publicPath(dir),
    subject: manifest.subject ?? null,
    files: listedFiles,
    artifactValidation,
    failures,
  };
}

function parseArgs(argv = process.argv.slice(2)) {
  const args = { dir: 'benchmarks/output/submission-bundle', json: false };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if ((token === '--dir' || token === '--bundle-dir') && argv[i + 1]) args.dir = argv[++i];
    else if (token === '--json') args.json = true;
    else if (token === '--help' || token === '-h') args.help = true;
    else throw new Error(`Unknown argument: ${token}`);
  }
  return args;
}

function usage() {
  return [
    'Usage: node benchmarks/verify-submission-bundle.mjs [--dir benchmarks/output/submission-bundle] [--json]',
    '',
    'Verifies a GuardBench submission bundle manifest, file hashes, bundled schemas,',
    'and artifact validation report.',
  ].join('\n');
}

async function main() {
  const args = parseArgs();
  if (args.help) {
    console.log(usage());
    return;
  }
  const report = verifyGuardBenchSubmissionBundle(args);
  if (args.json) console.log(JSON.stringify(report, null, 2));
  else if (report.ok) console.log(`GuardBench submission bundle verification passed: ${report.dir}`);
  else {
    console.error('GuardBench submission bundle verification failed:');
    for (const failure of report.failures) console.error(`- ${failure}`);
  }
  if (!report.ok) process.exit(1);
}

if (process.argv[1] && resolve(process.argv[1]).endsWith('verify-submission-bundle.mjs')) {
  main().catch(error => {
    console.error(error.stack ?? error.message);
    process.exit(1);
  });
}
