import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { publicPath } from '../benchmarks/public-paths.mjs';
import { validateSchema } from '../benchmarks/validate-guardbench-artifacts.mjs';
import { verifyPaperClaims } from './verify-paper-claims.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_PACK = 'docs/paper/publication-pack.json';
const DEFAULT_SCHEMA = 'docs/paper/publication-pack.schema.json';
const SEEDED_SECRET = 'sk-guardbench-secret-0000000000000000000000000000';
const REQUIRED_ENTRIES = [
  'arxiv-title',
  'arxiv-abstract',
  'hacker-news-title',
  'hacker-news-comment',
  'reddit-title',
  'reddit-body',
  'x-post-1',
  'x-post-2',
  'linkedin-post',
];
const X_URL_RESERVED_CHARS = 24;

function fromRoot(path) {
  return resolve(ROOT, path);
}

function readText(path) {
  const absolute = fromRoot(path);
  if (!existsSync(absolute)) throw new Error(`Missing required file: ${path}`);
  return readFileSync(absolute, 'utf-8');
}

function readJson(path) {
  return JSON.parse(readText(path));
}

function parseArgs(argv = process.argv.slice(2)) {
  const args = {
    pack: DEFAULT_PACK,
    schema: DEFAULT_SCHEMA,
    json: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === '--pack' && argv[i + 1]) args.pack = argv[++i];
    else if (token === '--schema' && argv[i + 1]) args.schema = argv[++i];
    else if (token === '--json') args.json = true;
    else if (token === '--help' || token === '-h') args.help = true;
    else throw new Error(`Unknown argument: ${token}`);
  }

  return args;
}

function usage() {
  return `Usage: node scripts/verify-publication-pack.mjs [options]

Options:
  --pack <path>    Publication pack JSON. Default: ${DEFAULT_PACK}.
  --schema <path>  Publication pack schema. Default: ${DEFAULT_SCHEMA}.
  --json           Print the machine-readable verification report.
`;
}

function referencesPendingClaim(entry, claimMap) {
  return entry.claimIds.some(id => claimMap.get(id)?.status === 'pending');
}

function hasPendingBoundaryLanguage(text) {
  return /\b(pending|deferred|does not report|not reporting|not claimed|Stage-B|live credentialed)\b/i.test(text);
}

function validateEntry(entry, claimMap, forbiddenNeedles) {
  const failures = [];
  const reservedUrlChars = Number.isInteger(entry.reservedUrlChars) ? entry.reservedUrlChars : 0;
  if (entry.text.length > entry.maxChars) {
    failures.push(`${entry.id}: text length ${entry.text.length} exceeds maxChars ${entry.maxChars}`);
  }
  if (entry.text.includes(SEEDED_SECRET)) failures.push(`${entry.id}: contains seeded raw secret`);
  if (entry.text.includes('runtime-key')) failures.push(`${entry.id}: contains runtime-key test credential`);
  for (const claimId of entry.claimIds) {
    if (!claimMap.has(claimId)) failures.push(`${entry.id}: unknown claim id ${claimId}`);
  }
  for (const needle of forbiddenNeedles) {
    if (entry.text.includes(needle)) failures.push(`${entry.id}: contains forbidden claim text: ${needle}`);
  }
  if (referencesPendingClaim(entry, claimMap) && !hasPendingBoundaryLanguage(entry.text)) {
    failures.push(`${entry.id}: references a pending claim without explicit pending/deferred boundary language`);
  }
  if (/10\/10/.test(entry.text) && !/\b(local|Stage-A)\b/i.test(entry.text)) {
    failures.push(`${entry.id}: 10/10 claim must be scoped as local or Stage-A`);
  }
  if (/\b(Mem0|Zep)\b/.test(entry.text) && !hasPendingBoundaryLanguage(entry.text)) {
    failures.push(`${entry.id}: Mem0/Zep mention must include pending/deferred boundary language`);
  }
  if (entry.platform === 'hacker-news' && entry.kind === 'title' && entry.text.length > 80) {
    failures.push(`${entry.id}: Hacker News title should stay at or below 80 characters`);
  }
  if (entry.platform === 'x' && entry.text.length > 280) {
    failures.push(`${entry.id}: X post should stay at or below 280 characters`);
  }
  if (entry.platform === 'x' && entry.requiresArtifactUrl === true) {
    if (!Number.isInteger(entry.reservedUrlChars)) {
      failures.push(`${entry.id}: X post requiring an artifact URL must set reservedUrlChars`);
    } else if (entry.reservedUrlChars < X_URL_RESERVED_CHARS) {
      failures.push(`${entry.id}: X artifact URL reserve must be at least ${X_URL_RESERVED_CHARS} characters`);
    }
    if (entry.text.length + reservedUrlChars > entry.maxChars) {
      failures.push(`${entry.id}: text length ${entry.text.length} plus URL reserve ${reservedUrlChars} exceeds maxChars ${entry.maxChars}`);
    }
  }
  return failures;
}

export async function verifyPublicationPack(options = {}) {
  const pack = readJson(options.pack ?? DEFAULT_PACK);
  const schema = readJson(options.schema ?? DEFAULT_SCHEMA);
  const claimReport = await verifyPaperClaims();
  const claimRegister = readJson(pack.claimRegister);
  const claimMap = new Map((claimRegister.claims ?? []).map(claim => [claim.id, claim]));
  const forbiddenNeedles = (claimRegister.claims ?? []).flatMap(claim =>
    (claim.forbiddenText ?? []).map(needle => needle.text));

  const schemaFailures = validateSchema(pack, schema, 'audrey-publication-pack');
  const ids = new Set();
  const entryReports = [];
  const failures = [...schemaFailures.map(failure => `publication pack schema: ${failure}`)];

  if (!claimReport.ok) failures.push(...claimReport.failures.map(failure => `claim verifier: ${failure}`));

  for (const entry of pack.entries ?? []) {
    const entryFailures = [];
    const reservedUrlChars = Number.isInteger(entry.reservedUrlChars) ? entry.reservedUrlChars : 0;
    if (ids.has(entry.id)) entryFailures.push(`${entry.id}: duplicate entry id`);
    ids.add(entry.id);
    entryFailures.push(...validateEntry(entry, claimMap, forbiddenNeedles));
    entryReports.push({
      id: entry.id,
      platform: entry.platform,
      kind: entry.kind,
      chars: entry.text.length,
      maxChars: entry.maxChars,
      requiresArtifactUrl: entry.requiresArtifactUrl === true,
      reservedUrlChars,
      effectiveChars: entry.text.length + reservedUrlChars,
      claimIds: entry.claimIds,
      ok: entryFailures.length === 0,
      failures: entryFailures,
    });
    failures.push(...entryFailures);
  }

  for (const id of REQUIRED_ENTRIES) {
    if (!ids.has(id)) failures.push(`Missing required publication-pack entry: ${id}`);
  }

  return {
    schemaVersion: '1.0.0',
    suite: 'Audrey publication pack verification',
    generatedAt: new Date().toISOString(),
    ok: failures.length === 0,
    pack: publicPath(fromRoot(options.pack ?? DEFAULT_PACK)),
    entries: entryReports,
    failures,
  };
}

async function main() {
  const args = parseArgs();
  if (args.help) {
    console.log(usage());
    return;
  }

  const report = await verifyPublicationPack(args);
  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
  } else if (report.ok) {
    console.log(`Publication pack verification passed: ${report.entries.length} entry(s)`);
  } else {
    console.error('Publication pack verification failed:');
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
