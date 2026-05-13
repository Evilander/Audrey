import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateSchema } from '../benchmarks/validate-guardbench-artifacts.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_DIR = 'docs/paper/output/arxiv';
const DEFAULT_SCHEMA = 'docs/paper/arxiv-source.schema.json';
const REQUIRED_FILES = ['main.tex', 'references.bib', 'README-arxiv.txt'];
const SEEDED_SECRET = 'sk-guardbench-secret-0000000000000000000000000000';

function fromRoot(path) {
  return resolve(ROOT, path);
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf-8'));
}

function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function countBibEntries(text) {
  return [...text.matchAll(/@\w+\s*\{/g)].length;
}

function walkFiles(dir, root = dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return walkFiles(path, root);
    return relative(root, path).replaceAll('\\', '/');
  });
}

function checkSourceHash(label, sourcePath, expectedHash, failures) {
  if (!sourcePath || !expectedHash) return;
  const absolute = fromRoot(sourcePath);
  if (!existsSync(absolute)) {
    failures.push(`arxiv-manifest.json: missing source file for ${label}: ${sourcePath}`);
    return;
  }
  if (expectedHash !== sha256File(absolute)) failures.push(`arxiv-manifest.json: ${label} hash is stale`);
}

function parseArgs(argv = process.argv.slice(2)) {
  const args = {
    dir: DEFAULT_DIR,
    schema: DEFAULT_SCHEMA,
    json: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if ((token === '--dir' || token === '--source-dir') && argv[i + 1]) args.dir = argv[++i];
    else if (token === '--schema' && argv[i + 1]) args.schema = argv[++i];
    else if (token === '--json') args.json = true;
    else if (token === '--help' || token === '-h') args.help = true;
    else throw new Error(`Unknown argument: ${token}`);
  }
  return args;
}

function usage() {
  return `Usage: node scripts/verify-arxiv-source.mjs [options]

Options:
  --dir <path>     arXiv source directory. Default: ${DEFAULT_DIR}.
  --schema <path>  arXiv source manifest schema. Default: ${DEFAULT_SCHEMA}.
  --json           Print the machine-readable verification report.
`;
}

export function verifyArxivSourcePackage(options = {}) {
  const dir = fromRoot(options.dir ?? DEFAULT_DIR);
  const schemaPath = fromRoot(options.schema ?? DEFAULT_SCHEMA);
  const manifestPath = join(dir, 'arxiv-manifest.json');
  const failures = [];
  let manifest = null;

  try {
    manifest = readJson(manifestPath);
  } catch (error) {
    return {
      ok: false,
      dir,
      files: [],
      citationCount: 0,
      bibEntries: 0,
      failures: [`arxiv-manifest.json: ${error.message}`],
    };
  }

  try {
    failures.push(...validateSchema(manifest, readJson(schemaPath), 'audrey-arxiv-source'));
  } catch (error) {
    failures.push(`schema: ${error.message}`);
  }

  const listed = new Map((manifest.files ?? []).map(file => [file.path, file]));
  for (const file of REQUIRED_FILES) {
    if (!listed.has(file)) failures.push(`arxiv-manifest.json: missing required file record ${file}`);
  }
  if (listed.has('arxiv-manifest.json')) failures.push('arxiv-manifest.json: must not include a self-hash file record');
  checkSourceHash('sourceMarkdown', manifest.sourceMarkdown, manifest.sourceHashes?.sourceMarkdown, failures);
  checkSourceHash('publicationPack', manifest.publicationPack, manifest.sourceHashes?.publicationPack, failures);
  checkSourceHash('referencesBib', 'docs/paper/references.bib', manifest.sourceHashes?.referencesBib, failures);

  for (const [file, record] of listed) {
    const path = join(dir, file);
    if (!existsSync(path)) {
      failures.push(`${file}: listed in manifest but missing from package`);
      continue;
    }
    const bytes = readFileSync(path).byteLength;
    if (record.bytes !== bytes) failures.push(`${file}: byte length mismatch`);
    if (record.sha256 !== sha256File(path)) failures.push(`${file}: sha256 mismatch`);
    if (record.source && record.source !== 'generated') {
      const sourcePath = fromRoot(record.source);
      if (existsSync(sourcePath)) {
        const sourceSha = sha256File(sourcePath);
        if (record.source === 'docs/paper/references.bib' && sourceSha !== record.sha256) {
          failures.push(`${file}: source bibliography has changed since arXiv package creation`);
        }
      }
    }
  }

  const actualFiles = walkFiles(dir).filter(file => file !== 'arxiv-manifest.json').sort();
  const listedFiles = [...listed.keys()].sort();
  const listedSet = new Set(listedFiles);
  for (const file of actualFiles) {
    if (!listedSet.has(file)) failures.push(`${file}: present in package but missing from manifest`);
  }

  const mainPath = join(dir, 'main.tex');
  const bibPath = join(dir, 'references.bib');
  const main = existsSync(mainPath) ? readFileSync(mainPath, 'utf-8') : '';
  const bib = existsSync(bibPath) ? readFileSync(bibPath, 'utf-8') : '';
  const citationCount = [...main.matchAll(/\\cite\{([^}]+)\}/g)].length;
  const citedIds = new Set([...main.matchAll(/\\cite\{([^}]+)\}/g)].flatMap(match => match[1].split(',').map(id => id.trim())));
  const bibIds = new Set([...bib.matchAll(/@\w+\s*\{\s*([^,\s]+)/g)].map(match => match[1].trim()));
  const bibEntries = countBibEntries(bib);

  if (!main.includes('\\documentclass')) failures.push('main.tex: missing documentclass');
  if (!main.includes('\\begin{abstract}')) failures.push('main.tex: missing abstract');
  if (!main.includes('\\bibliography{references}')) failures.push('main.tex: missing bibliography command');
  if (main.includes('[@')) failures.push('main.tex: contains unconverted Markdown citation syntax');
  if (/^#{1,6}\s/m.test(main)) failures.push('main.tex: contains unconverted Markdown heading syntax');
  if (main.includes(SEEDED_SECRET)) failures.push('main.tex: contains seeded raw secret');
  if (/([A-Z]:\\|file:\/\/|C:\\Users\\|B:\\Projects\\)/i.test(main)) failures.push('main.tex: contains a local absolute path');
  if (citationCount < 1) failures.push('main.tex: expected at least one citation');
  if (bibEntries !== 21) failures.push(`references.bib: expected 21 entries, found ${bibEntries}`);
  for (const id of citedIds) {
    if (!bibIds.has(id)) failures.push(`main.tex: cites missing bibliography id ${id}`);
  }
  if (manifest.tex?.citationCount !== citationCount) failures.push('arxiv-manifest.json: citation count is stale');
  if (manifest.tex?.bibEntryCount !== bibEntries) failures.push('arxiv-manifest.json: bibliography count is stale');

  return {
    ok: failures.length === 0,
    dir,
    manifestPath,
    files: listedFiles,
    citationCount,
    bibEntries,
    failures,
  };
}

function main() {
  const args = parseArgs();
  if (args.help) {
    console.log(usage());
    return;
  }
  const report = verifyArxivSourcePackage(args);
  if (args.json) console.log(JSON.stringify(report, null, 2));
  else if (report.ok) console.log(`arXiv source package verification passed: ${report.dir}`);
  else {
    console.error('arXiv source package verification failed:');
    for (const failure of report.failures) console.error(`- ${failure}`);
  }
  if (!report.ok) process.exit(1);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(error.stack ?? error.message);
    process.exit(1);
  }
}
