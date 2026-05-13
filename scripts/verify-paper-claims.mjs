import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateSchema } from '../benchmarks/validate-guardbench-artifacts.mjs';
import { verifyGuardBenchPublicationArtifacts } from '../benchmarks/verify-publication-artifacts.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_REGISTER = 'docs/paper/claim-register.json';
const DEFAULT_SCHEMA = 'docs/paper/claim-register.schema.json';
const SEEDED_SECRET = 'sk-guardbench-secret-0000000000000000000000000000';

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
    register: DEFAULT_REGISTER,
    schema: DEFAULT_SCHEMA,
    json: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === '--register' && argv[i + 1]) args.register = argv[++i];
    else if (token === '--schema' && argv[i + 1]) args.schema = argv[++i];
    else if (token === '--json') args.json = true;
    else if (token === '--help' || token === '-h') args.help = true;
    else throw new Error(`Unknown argument: ${token}`);
  }

  return args;
}

function usage() {
  return `Usage: node scripts/verify-paper-claims.mjs [options]

Options:
  --register <path>  Claim register JSON. Default: ${DEFAULT_REGISTER}.
  --schema <path>    Claim register schema. Default: ${DEFAULT_SCHEMA}.
  --json             Print the machine-readable claim verification report.
`;
}

function assertTextNeedles(needles, shouldExist, failures) {
  for (const needle of needles) {
    let text = '';
    try {
      text = readText(needle.path);
    } catch (error) {
      failures.push(error.message);
      continue;
    }
    const normalizedText = text.replace(/\s+/g, ' ');
    const normalizedNeedle = needle.text.replace(/\s+/g, ' ');
    const found = text.includes(needle.text) || normalizedText.includes(normalizedNeedle);
    if (shouldExist && !found) failures.push(`${needle.path} is missing claim text: ${needle.text}`);
    if (!shouldExist && found) failures.push(`${needle.path} contains forbidden claim text: ${needle.text}`);
  }
}

function guardbenchLocalPassed() {
  const summary = readJson('benchmarks/output/guardbench-summary.json');
  const failures = [];
  if (summary.passed !== 10) failures.push(`GuardBench passed expected 10, got ${summary.passed}`);
  if (summary.scenarios !== 10) failures.push(`GuardBench scenarios expected 10, got ${summary.scenarios}`);
  if (summary.redactionLeaks !== 0) failures.push(`GuardBench decision redaction leaks expected 0, got ${summary.redactionLeaks}`);
  if (summary.artifactRedactionSweep?.passed !== true) failures.push('GuardBench artifact redaction sweep did not pass');
  if (summary.artifactRedactionSweep?.leakCount !== 0) {
    failures.push(`GuardBench artifact leak count expected 0, got ${summary.artifactRedactionSweep?.leakCount}`);
  }
  return failures;
}

function noPublishedSecretLeaks() {
  const paths = [
    'benchmarks/output/guardbench-manifest.json',
    'benchmarks/output/guardbench-summary.json',
    'benchmarks/output/guardbench-raw.json',
  ];
  return paths.flatMap(path => readText(path).includes(SEEDED_SECRET)
    ? [`${path} contains the seeded raw secret`]
    : []);
}

function adapterRegistryHasMem0Zep() {
  const registry = readJson('benchmarks/adapters/registry.json');
  const ids = new Set((registry.adapters ?? []).map(adapter => adapter.id));
  const failures = [];
  if (!ids.has('mem0-platform')) failures.push('Adapter registry missing mem0-platform');
  if (!ids.has('zep-cloud')) failures.push('Adapter registry missing zep-cloud');
  return failures;
}

function externalEvidencePending() {
  const evidence = readJson('benchmarks/output/external/guardbench-external-evidence.json');
  const rows = (evidence.adapters ?? []).filter(adapter => ['mem0-platform', 'zep-cloud'].includes(adapter.id));
  const failures = [];
  if (rows.length !== 2) failures.push(`External evidence expected Mem0 and Zep rows, got ${rows.length}`);
  if (rows.every(row => row.status === 'verified')) {
    failures.push('External evidence is fully verified but claim register still marks external scores pending');
  }
  for (const row of rows) {
    if (row.status !== 'pending') failures.push(`External evidence row ${row.id} should remain pending until strict live evidence passes`);
    if (row.evidenceKind !== 'dry-run') failures.push(`External evidence row ${row.id} should be dry-run evidence before live credentials`);
  }
  return failures;
}

function externalEvidenceNoSecrets() {
  const text = readText('benchmarks/output/external/guardbench-external-evidence.json');
  const evidence = JSON.parse(text);
  const failures = [];
  if (text.includes('runtime-key')) failures.push('External evidence report contains test runtime-key');
  for (const row of evidence.adapters ?? []) {
    if (row.secretLeakCount !== 0) failures.push(`External evidence row ${row.id} reports ${row.secretLeakCount} credential leak(s)`);
  }
  return failures;
}

function paperStageBoundaryExcludesExternalScores() {
  const paper = readText('docs/paper/audrey-paper-v1.md');
  const failures = [];
  if (!paper.includes('this paper does not report external-system GuardBench scores')) {
    failures.push('Paper missing explicit external-score exclusion');
  }
  if (!paper.includes('External scores added only when live adapter runs and raw outputs are published')) {
    failures.push('Paper missing Stage-B external-score condition');
  }
  return failures;
}

async function publicationVerifierOk() {
  const report = await verifyGuardBenchPublicationArtifacts();
  return report.ok ? [] : report.failures.map(failure => `publication verifier: ${failure}`);
}

async function runArtifactCheck(name) {
  if (name === 'adapter-registry-has-mem0-zep') return adapterRegistryHasMem0Zep();
  if (name === 'external-evidence-no-secrets') return externalEvidenceNoSecrets();
  if (name === 'external-evidence-pending') return externalEvidencePending();
  if (name === 'guardbench-local-passed') return guardbenchLocalPassed();
  if (name === 'no-published-secret-leaks') return noPublishedSecretLeaks();
  if (name === 'paper-stage-boundary-excludes-external-scores') return paperStageBoundaryExcludesExternalScores();
  if (name === 'publication-verifier-ok') return publicationVerifierOk();
  return [`Unknown claim artifact check: ${name}`];
}

export async function verifyPaperClaims(options = {}) {
  const register = readJson(options.register ?? DEFAULT_REGISTER);
  const schema = readJson(options.schema ?? DEFAULT_SCHEMA);
  const schemaFailures = validateSchema(register, schema, 'audrey-paper-claim-register');
  const claimReports = [];

  for (const claim of register.claims ?? []) {
    const failures = [];
    assertTextNeedles(claim.requiredText ?? [], true, failures);
    assertTextNeedles(claim.forbiddenText ?? [], false, failures);
    for (const evidence of claim.evidence ?? []) {
      const [path] = evidence.split('#');
      if (!existsSync(fromRoot(path))) failures.push(`Missing evidence file for ${claim.id}: ${path}`);
    }
    for (const check of claim.artifactChecks ?? []) {
      failures.push(...(await runArtifactCheck(check)));
    }
    claimReports.push({
      id: claim.id,
      status: claim.status,
      ok: failures.length === 0,
      artifactChecks: claim.artifactChecks ?? [],
      failures,
    });
  }

  const failures = [
    ...schemaFailures.map(failure => `claim register schema: ${failure}`),
    ...claimReports.flatMap(report => report.failures.map(failure => `${report.id}: ${failure}`)),
  ];

  return {
    schemaVersion: '1.0.0',
    suite: 'Audrey paper claim verification',
    generatedAt: new Date().toISOString(),
    ok: failures.length === 0,
    register: fromRoot(options.register ?? DEFAULT_REGISTER),
    claims: claimReports,
    failures,
  };
}

async function main() {
  const args = parseArgs();
  if (args.help) {
    console.log(usage());
    return;
  }

  const report = await verifyPaperClaims(args);
  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
  } else if (report.ok) {
    console.log(`Paper claim verification passed: ${report.claims.length} claim(s)`);
  } else {
    console.error('Paper claim verification failed:');
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
