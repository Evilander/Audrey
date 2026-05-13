import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { verifyPaperClaims } from './verify-paper-claims.mjs';
import { verifyPaperSubmissionBundle } from './verify-paper-submission-bundle.mjs';
import { verifyPublicationPack } from './verify-publication-pack.mjs';
import { verifyBrowserLaunchPlan } from './verify-browser-launch-plan.mjs';
import { verifyBrowserLaunchResults } from './verify-browser-launch-results.mjs';
import { verifyArxivSourcePackage } from './verify-arxiv-source.mjs';
import { verifyArxivCompileReport } from './verify-arxiv-compile.mjs';

const ROOT = process.cwd();
const SEEDED_SECRET = 'sk-guardbench-secret-0000000000000000000000000000';

function readText(path) {
  const absolute = resolve(ROOT, path);
  if (!existsSync(absolute)) throw new Error(`Missing required file: ${path}`);
  return readFileSync(absolute, 'utf-8');
}

function readJson(path) {
  return JSON.parse(readText(path));
}

function assert(condition, message, failures) {
  if (!condition) failures.push(message);
}

function formatMetric(value) {
  return String(value);
}

function countEvidenceRows(ledger) {
  return ledger.split(/\r?\n/).filter(line => /^\| E\d+ - /.test(line)).length;
}

function countBibEntries(bib) {
  return [...bib.matchAll(/@\w+\s*\{/g)].length;
}

function ensureContainsAll(text, needles, label, failures) {
  for (const needle of needles) {
    assert(text.includes(needle), `${label} is missing: ${needle}`, failures);
  }
}

function ensureContainsAllProse(text, needles, label, failures) {
  const normalized = text.replace(/\s+/g, ' ').toLowerCase();
  for (const needle of needles) {
    assert(normalized.includes(needle.toLowerCase()), `${label} is missing: ${needle}`, failures);
  }
}

function typeOf(value) {
  if (Array.isArray(value)) return 'array';
  if (value === null) return 'null';
  return typeof value;
}

function validateSchema(value, schema, label, root = schema) {
  const errors = [];

  function validate(current, currentSchema, path) {
    if (currentSchema.$ref) {
      const refPath = currentSchema.$ref.replace(/^#\//, '').split('/');
      const resolved = refPath.reduce((node, key) => node?.[key], root);
      if (!resolved) {
        errors.push(`${path}: unresolved schema ref ${currentSchema.$ref}`);
        return;
      }
      validate(current, resolved, path);
      return;
    }

    if (currentSchema.anyOf) {
      const nested = currentSchema.anyOf.map(option => {
        const before = errors.length;
        validate(current, option, path);
        return errors.splice(before);
      });
      const passed = nested.some(group => group.length === 0);
      if (!passed) errors.push(`${path}: did not match any allowed schema`);
      return;
    }

    if (currentSchema.const !== undefined && current !== currentSchema.const) {
      errors.push(`${path}: expected constant ${currentSchema.const}`);
    }
    if (currentSchema.enum && !currentSchema.enum.includes(current)) {
      errors.push(`${path}: expected one of ${currentSchema.enum.join(', ')}`);
    }
    if (currentSchema.type === 'integer') {
      if (typeof current !== 'number' || !Number.isInteger(current)) {
        errors.push(`${path}: expected integer, got ${typeOf(current)}`);
        return;
      }
    } else if (currentSchema.type) {
      const actual = typeOf(current);
      if (actual !== currentSchema.type) {
        errors.push(`${path}: expected ${currentSchema.type}, got ${actual}`);
        return;
      }
    }
    if (currentSchema.minLength != null && String(current).length < currentSchema.minLength) {
      errors.push(`${path}: shorter than minLength ${currentSchema.minLength}`);
    }
    if (currentSchema.pattern && typeof current === 'string' && !(new RegExp(currentSchema.pattern).test(current))) {
      errors.push(`${path}: does not match ${currentSchema.pattern}`);
    }
    if (currentSchema.minimum != null && typeof current === 'number' && current < currentSchema.minimum) {
      errors.push(`${path}: below minimum ${currentSchema.minimum}`);
    }
    if (currentSchema.maximum != null && typeof current === 'number' && current > currentSchema.maximum) {
      errors.push(`${path}: above maximum ${currentSchema.maximum}`);
    }

    if (currentSchema.type === 'array') {
      if (currentSchema.minItems != null && current.length < currentSchema.minItems) {
        errors.push(`${path}: expected at least ${currentSchema.minItems} items`);
      }
      if (currentSchema.items) {
        current.forEach((item, index) => validate(item, currentSchema.items, `${path}[${index}]`));
      }
      if (currentSchema.contains) {
        const matched = current.some(item => validateSchema(item, currentSchema.contains, `${path}.contains`, root).length === 0);
        if (!matched) errors.push(`${path}: no item matched contains constraint`);
      }
    }

    if (currentSchema.type === 'object') {
      for (const required of currentSchema.required ?? []) {
        if (!Object.hasOwn(current, required)) errors.push(`${path}: missing required property ${required}`);
      }
      if (currentSchema.additionalProperties === false) {
        for (const key of Object.keys(current)) {
          if (!Object.hasOwn(currentSchema.properties ?? {}, key)) {
            errors.push(`${path}: unexpected property ${key}`);
          }
        }
      }
      for (const [key, propertySchema] of Object.entries(currentSchema.properties ?? {})) {
        if (Object.hasOwn(current, key)) validate(current[key], propertySchema, `${path}.${key}`);
      }
    }
  }

  validate(value, schema, label);
  return errors;
}

const failures = [];

const summary = readJson('benchmarks/output/summary.json');
const guardSummary = readJson('benchmarks/output/guardbench-summary.json');
const guardManifest = readJson('benchmarks/output/guardbench-manifest.json');
const guardRaw = readJson('benchmarks/output/guardbench-raw.json');
const guardAdapterSelfTest = readJson('benchmarks/output/adapter-self-test/guardbench-adapter-self-test.json');
const guardAdapterRegistry = readJson('benchmarks/adapters/registry.json');
const guardExternalDryRun = readJson('benchmarks/output/external/guardbench-external-dry-run.json');
const guardExternalEvidence = readJson('benchmarks/output/external/guardbench-external-evidence.json');
const guardManifestSchema = readJson('benchmarks/schemas/guardbench-manifest.schema.json');
const guardSummarySchema = readJson('benchmarks/schemas/guardbench-summary.schema.json');
const guardRawSchema = readJson('benchmarks/schemas/guardbench-raw.schema.json');
const guardAdapterSelfTestSchema = readJson('benchmarks/schemas/guardbench-adapter-self-test.schema.json');
const guardAdapterRegistrySchema = readJson('benchmarks/schemas/guardbench-adapter-registry.schema.json');
const guardExternalDryRunSchema = readJson('benchmarks/schemas/guardbench-external-dry-run.schema.json');
const guardExternalEvidenceSchema = readJson('benchmarks/schemas/guardbench-external-evidence.schema.json');
const guardPublicationVerificationSchema = readJson('benchmarks/schemas/guardbench-publication-verification.schema.json');
const packageJsonText = readText('package.json');
const readme = readText('README.md');
const evaluation = readText('docs/paper/07-evaluation.md');
const paper = readText('docs/paper/audrey-paper-v1.md');
const ledger = readText('docs/paper/evidence-ledger.md');
const submission = readText('docs/paper/SUBMISSION_README.md');
const references = readText('docs/paper/references.bib');
const browserPlan = readText('docs/paper/browser-launch-plan.json');
const browserLaunchResultsVerifier = readText('scripts/verify-browser-launch-results.mjs');
const claimReport = await verifyPaperClaims();
const publicationPackReport = await verifyPublicationPack();
const arxivSourceReport = verifyArxivSourcePackage();
const arxivCompileReport = verifyArxivCompileReport({ allowPending: true });
const browserLaunchReport = await verifyBrowserLaunchPlan();
const browserLaunchResultsReport = await verifyBrowserLaunchResults();
const paperBundleReport = verifyPaperSubmissionBundle();

const local = Object.fromEntries(summary.local.overall.map(row => [row.system, row]));
const evidenceRows = countEvidenceRows(ledger);
const bibEntries = countBibEntries(references);

assert(evidenceRows >= 97, `Expected at least 97 evidence ledger rows, found ${evidenceRows}`, failures);
assert(submission.includes(`Evidence ledger with ${evidenceRows} rows`), 'SUBMISSION_README ledger row count is stale', failures);
assert(bibEntries === 21, `Expected 21 bibliography entries, found ${bibEntries}`, failures);
assert(submission.includes(`Primary-source bibliography with ${bibEntries} entries`), 'SUBMISSION_README bibliography count is stale', failures);

ensureContainsAll(ledger, ['| E46 -', '| E47 -', '| E48 -', '| E49 -', '| E50 -', '| E51 -', '| E52 -', '| E53 -', '| E54 -', '| E55 -', '| E56 -', '| E57 -', '| E58 -', '| E59 -', '| E60 -', '| E61 -', '| E62 -', '| E63 -', '| E64 -', '| E65 -', '| E66 -', '| E67 -', '| E68 -', '| E69 -', '| E70 -', '| E71 -', '| E72 -', '| E73 -', '| E74 -', '| E75 -', '| E76 -', '| E77 -', '| E78 -', '| E79 -', '| E80 -', '| E81 -', '| E82 -', '| E83 -', '| E84 -', '| E85 -', '| E86 -', '| E87 -', '| E88 -', '| E89 -', '| E90 -', '| E91 -', '| E92 -', '| E93 -', '| E94 -', '| E95 -', '| E96 -', '| E97 -'], 'evidence-ledger.md', failures);
ensureContainsAll(submission, ['Ledger: E46-E51', 'artifact redaction sweep', 'local absolute-path sweep', 'public-paths.mjs', 'adapter-kit.mjs', 'registry.json', 'claim-register.json', 'publication-pack.json', 'reservedUrlChars', 'arxiv-source.schema.json', 'arxiv-compile-report.schema.json', 'arxiv-compile-report.json', 'docs/paper/output/arxiv', 'paper:arxiv', 'paper:arxiv:verify', 'paper:arxiv:compile', 'paper:arxiv:compile:strict', 'browser-launch-plan.json', 'browser-launch-plan.schema.json', 'browser-launch-results.json', 'browser-launch-results.schema.json', 'artifactUrl', 'x-counting-characters', 'paper-submission-bundle.schema.json', 'docs/paper/output/submission-bundle', 'paper:bundle', 'paper:bundle:verify', 'paper:launch-plan', 'paper:launch-results', 'paper:launch-results:strict', 'release:cut:plan', 'release:cut:apply', 'release:readiness', 'release:readiness:strict', 'python:release:check', 'Python package release verifier', 'npm audit --omit=dev --audit-level=moderate', 'bench:guard:adapter-registry:validate', 'bench:guard:adapter-module:validate', 'bench:guard:adapter-self-test', 'bench:guard:adapter-self-test:validate', 'bench:guard:publication:verify', 'bench:guard:external:dry-run', 'bench:guard:external:evidence', 'bench:guard:external:evidence:strict', 'paper:claims', 'paper:publication-pack', 'guardbench-adapter-self-test.schema.json', 'guardbench-adapter-registry.schema.json', 'guardbench-external-dry-run.schema.json', 'guardbench-external-evidence.schema.json', 'guardbench-publication-verification.schema.json', 'zep-cloud.mjs', 'bench:guard:zep', 'ZEP_API_KEY'], 'SUBMISSION_README.md', failures);
ensureContainsAllProse(submission, ['source-control release-state check', 'live remote-head verification', 'git ls-remote', 'npm registry/auth readiness', 'npm whoami', 'audrey@1.0.0', 'PyPI publish readiness'], 'SUBMISSION_README.md', failures);
ensureContainsAll(packageJsonText, ['"scripts/*.py"', '"python:release:check"', '"paper:arxiv:compile"', '"paper:arxiv:compile:strict"'], 'package.json', failures);
if (!claimReport.ok) {
  failures.push(...claimReport.failures.map(failure => `Paper claim verification failed: ${failure}`));
}
if (!publicationPackReport.ok) {
  failures.push(...publicationPackReport.failures.map(failure => `Publication pack verification failed: ${failure}`));
}
if (!arxivSourceReport.ok) {
  failures.push(...arxivSourceReport.failures.map(failure => `arXiv source package verification failed: ${failure}`));
}
if (!arxivCompileReport.ok) {
  failures.push(...arxivCompileReport.failures.map(failure => `arXiv compile report verification failed: ${failure}`));
}
if (!browserLaunchReport.ok) {
  failures.push(...browserLaunchReport.failures.map(failure => `Browser launch plan verification failed: ${failure}`));
}
if (!browserLaunchResultsReport.ok) {
  failures.push(...browserLaunchResultsReport.failures.map(failure => `Browser launch results verification failed: ${failure}`));
}
if (!paperBundleReport.ok) {
  failures.push(...paperBundleReport.failures.map(failure => `Paper submission bundle verification failed: ${failure}`));
}
if (arxivCompileReport.status === 'passed') {
  assert(paperBundleReport.files.includes('docs/paper/output/arxiv-compile/main.pdf'), 'Paper submission bundle missing compiled arXiv PDF', failures);
  assert(paperBundleReport.files.includes('docs/paper/output/arxiv-compile/arxiv-compile.log'), 'Paper submission bundle missing arXiv compile log', failures);
}
const firstXPost = publicationPackReport.entries.find(entry => entry.id === 'x-post-1');
assert(firstXPost?.requiresArtifactUrl === true, 'x-post-1 must require an artifact URL', failures);
assert(firstXPost?.reservedUrlChars >= 24, 'x-post-1 must reserve at least 24 characters for an X URL plus separator', failures);
assert(firstXPost?.effectiveChars <= 280, 'x-post-1 text plus URL reserve must fit within 280 characters', failures);
ensureContainsAll(browserPlan, ['x-counting-characters', 'https://docs.x.com/fundamentals/counting-characters', 'reservedUrlChars'], 'browser-launch-plan.json', failures);
ensureContainsAll(browserLaunchResultsVerifier, ['submitted artifact-url target must record artifactUrl'], 'verify-browser-launch-results.mjs', failures);

const manifestSchemaErrors = validateSchema(guardManifest, guardManifestSchema, 'guardbench-manifest');
for (const error of manifestSchemaErrors) failures.push(`GuardBench manifest schema violation: ${error}`);
const summarySchemaErrors = validateSchema(guardSummary, guardSummarySchema, 'guardbench-summary');
for (const error of summarySchemaErrors) failures.push(`GuardBench summary schema violation: ${error}`);
const rawSchemaErrors = validateSchema(guardRaw, guardRawSchema, 'guardbench-raw');
for (const error of rawSchemaErrors) failures.push(`GuardBench raw schema violation: ${error}`);
const adapterSelfTestSchemaErrors = validateSchema(guardAdapterSelfTest, guardAdapterSelfTestSchema, 'guardbench-adapter-self-test');
for (const error of adapterSelfTestSchemaErrors) failures.push(`GuardBench adapter self-test schema violation: ${error}`);
const adapterRegistrySchemaErrors = validateSchema(guardAdapterRegistry, guardAdapterRegistrySchema, 'guardbench-adapter-registry');
for (const error of adapterRegistrySchemaErrors) failures.push(`GuardBench adapter registry schema violation: ${error}`);
const externalDryRunSchemaErrors = validateSchema(guardExternalDryRun, guardExternalDryRunSchema, 'guardbench-external-dry-run');
for (const error of externalDryRunSchemaErrors) failures.push(`GuardBench external dry-run schema violation: ${error}`);
const externalEvidenceSchemaErrors = validateSchema(guardExternalEvidence, guardExternalEvidenceSchema, 'guardbench-external-evidence');
for (const error of externalEvidenceSchemaErrors) failures.push(`GuardBench external evidence schema violation: ${error}`);
const registryIds = guardAdapterRegistry.adapters.map(adapter => adapter.id);
assert(registryIds.includes('mem0-platform'), 'GuardBench adapter registry missing mem0-platform', failures);
assert(registryIds.includes('zep-cloud'), 'GuardBench adapter registry missing zep-cloud', failures);
const dryRunIds = guardExternalDryRun.adapters.map(adapter => adapter.id);
assert(dryRunIds.includes('mem0-platform'), 'GuardBench external dry-run matrix missing mem0-platform', failures);
assert(dryRunIds.includes('zep-cloud'), 'GuardBench external dry-run matrix missing zep-cloud', failures);
assert(guardExternalDryRun.adapters.every(adapter => !JSON.stringify(adapter).includes('runtime-key')), 'GuardBench external dry-run matrix contains a test secret', failures);
const evidenceIds = guardExternalEvidence.adapters.map(adapter => adapter.id);
assert(guardExternalEvidence.allowPending === true, 'GuardBench external evidence report should allow pending live runs in the release gate', failures);
assert(evidenceIds.includes('mem0-platform'), 'GuardBench external evidence report missing mem0-platform', failures);
assert(evidenceIds.includes('zep-cloud'), 'GuardBench external evidence report missing zep-cloud', failures);
assert(guardExternalEvidence.adapters.every(adapter => ['pending', 'verified'].includes(adapter.status)), 'GuardBench external evidence report has an invalid adapter status', failures);
assert(guardExternalEvidence.adapters.every(adapter => !JSON.stringify(adapter).includes('runtime-key')), 'GuardBench external evidence report contains a test secret', failures);
const zepAdapter = guardAdapterRegistry.adapters.find(adapter => adapter.id === 'zep-cloud');
assert(zepAdapter?.credentialMode === 'runtime-env', 'Zep adapter must require runtime environment credentials', failures);
assert(zepAdapter?.requiredEnv?.includes('ZEP_API_KEY'), 'Zep adapter registry entry missing ZEP_API_KEY', failures);
assert(zepAdapter?.commands?.externalRun === 'npm run bench:guard:zep', 'Zep adapter external-run command is stale', failures);
const publicationVerificationFixture = {
  schemaVersion: '1.0.0',
  suite: 'GuardBench publication artifact verification',
  generatedAt: '2026-05-13T00:00:00.000Z',
  ok: true,
  checks: {
    registry: { ok: true, failures: [] },
    adapterModule: { ok: true, failures: [] },
    selfTest: { ok: true, failures: [] },
    artifacts: { ok: true, failures: [] },
    bundle: { ok: true, failures: [] },
    externalDryRun: { ok: true, failures: [] },
    externalEvidence: { ok: true, failures: [] },
    leaderboard: { ok: true, failures: [] },
    localPaths: { ok: true, failures: [] },
  },
  failures: [],
};
const publicationVerificationSchemaErrors = validateSchema(
  publicationVerificationFixture,
  guardPublicationVerificationSchema,
  'guardbench-publication-verification',
);
for (const error of publicationVerificationSchemaErrors) failures.push(`GuardBench publication verifier schema violation: ${error}`);

const benchmarkNeedles = [
  summary.generatedAt,
  `| Audrey | ${local.Audrey.scorePercent} | ${local.Audrey.passRate} | ${formatMetric(local.Audrey.avgDurationMs)} |`,
  `| Vector Only | ${local['Vector Only'].scorePercent} | ${local['Vector Only'].passRate} | ${formatMetric(local['Vector Only'].avgDurationMs)} |`,
  `| Keyword + Recency | ${local['Keyword + Recency'].scorePercent} | ${local['Keyword + Recency'].passRate} | ${formatMetric(local['Keyword + Recency'].avgDurationMs)} |`,
];
ensureContainsAll(evaluation, benchmarkNeedles, '07-evaluation.md', failures);
ensureContainsAll(paper, benchmarkNeedles, 'audrey-paper-v1.md', failures);

const latency = guardSummary.latency;
const guardLatencyText = `${formatMetric(latency.p50Ms)} ms / ${formatMetric(latency.p95Ms)} ms`;
ensureContainsAll(evaluation, [guardLatencyText, '| Published artifact raw-secret leaks | 0 |'], '07-evaluation.md', failures);
ensureContainsAll(paper, [guardLatencyText, '| Published artifact raw-secret leaks | 0 |'], 'audrey-paper-v1.md', failures);
ensureContainsAll(readme, [`${formatMetric(latency.p50Ms)}ms / ${formatMetric(latency.p95Ms)}ms`, '0 published artifact leaks'], 'README.md', failures);
ensureContainsAll(readme, ['bench:guard:zep', 'bench:guard:external:dry-run', 'bench:guard:external:evidence', 'bench:guard:external:evidence:strict', 'paper:arxiv:compile', 'paper:arxiv:compile:strict', 'paper:launch-results', 'paper:launch-results:strict', 'release:cut:plan', 'release:cut:apply', 'release:readiness', 'release:readiness:strict', 'python:release:check', 'absolute-path sweep', 'X URL reserve', 'submitted artifact-url targets', 'external dry-run matrix', 'external evidence verification', 'ZEP_API_KEY', 'ZEP_GUARDBENCH_INGEST_DELAY_MS'], 'README.md', failures);
ensureContainsAllProse(readme, ['source-control state', 'live remote-head verification', 'npm registry/auth readiness', 'PyPI publish readiness'], 'README.md', failures);
ensureContainsAll(paper, ['Zep Cloud', 'ZEP_API_KEY', 'Mem0 and Zep adapters', 'external dry-run matrix', 'external evidence verification', 'reserved URL budget', 'submitted artifact-url targets', 'arXiv compile report', 'release-readiness verifier', 'release-cut planner', 'Python package verifier'], 'audrey-paper-v1.md', failures);
ensureContainsAllProse(paper, ['source-control release-state check', 'live remote-head verification', 'npm registry/auth readiness', 'npm whoami', 'audrey@1.0.0', 'PyPI publish readiness'], 'audrey-paper-v1.md', failures);
ensureContainsAll(ledger, [`${formatMetric(latency.p50Ms)}ms/${formatMetric(latency.p95Ms)}ms`, 'zero published artifact raw-secret leaks'], 'evidence-ledger.md', failures);

assert(guardSummary.passed === 10, `GuardBench expected 10 passed scenarios, got ${guardSummary.passed}`, failures);
assert(guardSummary.scenarios === 10, `GuardBench expected 10 scenarios, got ${guardSummary.scenarios}`, failures);
assert(guardSummary.redactionLeaks === 0, `GuardBench decision-output leaks expected 0, got ${guardSummary.redactionLeaks}`, failures);
assert(guardSummary.artifactRedactionSweep?.passed === true, 'GuardBench artifactRedactionSweep did not pass', failures);
assert(guardSummary.artifactRedactionSweep?.leakCount === 0, `GuardBench artifact leak count expected 0, got ${guardSummary.artifactRedactionSweep?.leakCount}`, failures);
assert(guardRaw.artifactRedactionSweep?.passed === true, 'Raw GuardBench artifactRedactionSweep did not pass', failures);

const manifestText = JSON.stringify(guardManifest);
const summaryText = JSON.stringify(guardSummary);
const rawText = JSON.stringify(guardRaw);
assert(!manifestText.includes(SEEDED_SECRET), 'GuardBench manifest contains the raw seeded secret', failures);
assert(!summaryText.includes(SEEDED_SECRET), 'GuardBench summary contains the raw seeded secret', failures);
assert(!rawText.includes(SEEDED_SECRET), 'GuardBench raw output contains the raw seeded secret', failures);
assert(manifestText.includes('seededSecretRefs'), 'GuardBench manifest missing seededSecretRefs', failures);
assert(!manifestText.includes('"seededSecrets"'), 'GuardBench manifest still publishes seededSecrets', failures);

if (failures.length) {
  console.error('Paper artifact verification failed:');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log('Paper artifact verification passed.');
console.log(`Evidence rows: ${evidenceRows}`);
console.log(`Bibliography entries: ${bibEntries}`);
console.log(`Paper claims: ${claimReport.claims.length}`);
console.log(`Publication pack entries: ${publicationPackReport.entries.length}`);
console.log(`arXiv source files: ${arxivSourceReport.files.length}, citations ${arxivSourceReport.citationCount}`);
console.log(`arXiv compile status: ${arxivCompileReport.status}`);
console.log(`Browser launch targets: ${browserLaunchReport.targets.length}`);
console.log(`Browser launch results: ${browserLaunchResultsReport.targets.length} targets, ready=${browserLaunchResultsReport.ready}`);
console.log(`Paper bundle files: ${paperBundleReport.files.length}`);
console.log(`GuardBench: ${guardSummary.passed}/${guardSummary.scenarios}, latency ${latency.p50Ms}ms/${latency.p95Ms}ms, artifact leaks ${guardSummary.artifactRedactionSweep.leakCount}`);
