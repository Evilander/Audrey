import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { writeGuardBenchConformanceCard } from './create-conformance-card.mjs';
import { validateGuardBenchArtifacts } from './validate-guardbench-artifacts.mjs';
import { publicPath } from './public-paths.mjs';

const REQUIRED_ARTIFACTS = [
  'guardbench-manifest.json',
  'guardbench-summary.json',
  'guardbench-raw.json',
  'guardbench-conformance-card.json',
];
const OPTIONAL_ARTIFACTS = ['external-run-metadata.json'];
const SCHEMA_FILES = [
  'guardbench-adapter-registry.schema.json',
  'guardbench-adapter-self-test.schema.json',
  'guardbench-external-dry-run.schema.json',
  'guardbench-external-evidence.schema.json',
  'guardbench-publication-verification.schema.json',
  'guardbench-manifest.schema.json',
  'guardbench-summary.schema.json',
  'guardbench-raw.schema.json',
  'guardbench-external-run.schema.json',
  'guardbench-conformance-card.schema.json',
  'guardbench-leaderboard.schema.json',
  'guardbench-submission-manifest.schema.json',
];

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf-8'));
}

function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function copyFileInto(sourceDir, outDir, file) {
  const source = join(sourceDir, file);
  if (!existsSync(source)) return null;
  const target = join(outDir, file);
  cpSync(source, target);
  return target;
}

export function bundleRelativeFilePath(path, root) {
  const relativePath = relative(root, path);
  if (!relativePath || relativePath.startsWith('..') || isAbsolute(relativePath)) {
    throw new Error(`Cannot add file outside GuardBench submission bundle: ${path}`);
  }
  return relativePath.replaceAll('\\', '/');
}

function fileRecord(path, root) {
  return {
    path: bundleRelativeFilePath(path, root),
    bytes: readFileSync(path).byteLength,
    sha256: sha256File(path),
  };
}

export function writeGuardBenchSubmissionBundle(options = {}) {
  const sourceDir = resolve(options.dir ?? 'benchmarks/output');
  const outDir = resolve(options.outDir ?? join(sourceDir, 'submission-bundle'));
  const schemasDir = resolve(options.schemasDir ?? 'benchmarks/schemas');

  writeGuardBenchConformanceCard({ dir: sourceDir });
  const sourceValidation = validateGuardBenchArtifacts({ dir: sourceDir, schemasDir });
  if (!sourceValidation.ok) {
    throw new Error(`Cannot create GuardBench submission bundle from invalid artifacts: ${sourceValidation.failures.join('; ')}`);
  }

  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(join(outDir, 'schemas'), { recursive: true });

  const copied = [];
  for (const file of [...REQUIRED_ARTIFACTS, ...OPTIONAL_ARTIFACTS]) {
    const target = copyFileInto(sourceDir, outDir, file);
    if (target) copied.push(target);
  }
  for (const file of SCHEMA_FILES) {
    const target = join(outDir, 'schemas', file);
    cpSync(join(schemasDir, file), target);
    copied.push(target);
  }

  const bundleValidation = validateGuardBenchArtifacts({
    dir: outDir,
    schemasDir: join(outDir, 'schemas'),
  });
  const validationReportPath = join(outDir, 'validation-report.json');
  writeFileSync(validationReportPath, `${JSON.stringify({
    generatedAt: new Date().toISOString(),
    sourceValidation,
    bundleValidation,
  }, null, 2)}\n`, 'utf-8');
  copied.push(validationReportPath);

  const card = readJson(join(outDir, 'guardbench-conformance-card.json'));
  const manifestPath = join(outDir, 'submission-manifest.json');
  const manifest = {
    schemaVersion: '1.0.0',
    suite: 'GuardBench submission bundle',
    generatedAt: new Date().toISOString(),
    sourceDir: publicPath(sourceDir),
    subject: card.subject,
    score: card.score,
    conformance: card.conformance,
    validation: bundleValidation,
    files: copied.map(path => fileRecord(path, outDir)).sort((a, b) => a.path.localeCompare(b.path)),
  };
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf-8');

  const finalFiles = copied.map(path => fileRecord(path, outDir)).sort((a, b) => a.path.localeCompare(b.path));
  manifest.files = finalFiles;
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf-8');

  return {
    outDir,
    manifestPath,
    validation: bundleValidation,
    subject: card.subject,
    files: finalFiles.map(record => record.path),
  };
}

function parseArgs(argv = process.argv.slice(2)) {
  const args = {
    dir: 'benchmarks/output',
    outDir: null,
    schemasDir: 'benchmarks/schemas',
    json: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if ((token === '--dir' || token === '--source-dir') && argv[i + 1]) args.dir = argv[++i];
    else if (token === '--out-dir' && argv[i + 1]) args.outDir = argv[++i];
    else if (token === '--schemas-dir' && argv[i + 1]) args.schemasDir = argv[++i];
    else if (token === '--json') args.json = true;
    else if (token === '--help' || token === '-h') args.help = true;
    else throw new Error(`Unknown argument: ${token}`);
  }
  return args;
}

function usage() {
  return [
    'Usage: node benchmarks/create-submission-bundle.mjs [--dir benchmarks/output] [--out-dir <dir>] [--json]',
    '',
    'Creates a portable GuardBench submission bundle containing artifacts, schemas,',
    'a conformance card, validation report, and submission manifest.',
  ].join('\n');
}

async function main() {
  const args = parseArgs();
  if (args.help) {
    console.log(usage());
    return;
  }
  const result = writeGuardBenchSubmissionBundle(args);
  if (args.json) console.log(JSON.stringify(result, null, 2));
  else {
    console.log(`GuardBench submission bundle: ${result.outDir}`);
    console.log(`Subject: ${result.subject.name}`);
    console.log(`Validation: ${result.validation.ok ? 'passed' : 'failed'}`);
  }
  if (!result.validation.ok) process.exit(1);
}

if (process.argv[1] && resolve(process.argv[1]).endsWith(basename(import.meta.url))) {
  main().catch(error => {
    console.error(error.stack ?? error.message);
    process.exit(1);
  });
}
