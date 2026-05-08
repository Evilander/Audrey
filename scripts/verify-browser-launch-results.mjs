import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { publicPath } from '../benchmarks/public-paths.mjs';
import { validateSchema } from '../benchmarks/validate-guardbench-artifacts.mjs';
import { verifyBrowserLaunchPlan } from './verify-browser-launch-plan.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_RESULTS = 'docs/paper/browser-launch-results.json';
const DEFAULT_SCHEMA = 'docs/paper/browser-launch-results.schema.json';
const DEFAULT_PLAN = 'docs/paper/browser-launch-plan.json';
const SEEDED_SECRET = 'sk-guardbench-secret-0000000000000000000000000000';
const PLATFORM_HOSTS = {
  arxiv: ['arxiv.org'],
  'hacker-news': ['news.ycombinator.com'],
  reddit: ['www.reddit.com', 'reddit.com'],
  x: ['twitter.com', 'x.com'],
  linkedin: ['www.linkedin.com', 'linkedin.com'],
};

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
    results: DEFAULT_RESULTS,
    schema: DEFAULT_SCHEMA,
    plan: DEFAULT_PLAN,
    strict: false,
    json: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if ((token === '--results' || token === '--file') && argv[i + 1]) args.results = argv[++i];
    else if (token === '--schema' && argv[i + 1]) args.schema = argv[++i];
    else if (token === '--plan' && argv[i + 1]) args.plan = argv[++i];
    else if (token === '--strict') args.strict = true;
    else if (token === '--json') args.json = true;
    else if (token === '--help' || token === '-h') args.help = true;
    else throw new Error(`Unknown argument: ${token}`);
  }

  return args;
}

function usage() {
  return `Usage: node scripts/verify-browser-launch-results.mjs [options]

Options:
  --results <path>  Browser launch results JSON. Default: ${DEFAULT_RESULTS}.
  --schema <path>   Browser launch results schema. Default: ${DEFAULT_SCHEMA}.
  --plan <path>     Browser launch plan JSON. Default: ${DEFAULT_PLAN}.
  --strict          Fail until every launch target is submitted and verified.
  --json            Print the machine-readable verification report.
`;
}

function isAllowedPlatformUrl(platform, value) {
  if (value === null) return true;
  try {
    const url = new URL(value);
    return (PLATFORM_HOSTS[platform] ?? []).includes(url.hostname);
  } catch {
    return false;
  }
}

function isHttpsUrl(value) {
  if (value === null) return true;
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

function containsLocalPath(text) {
  return /(^|[^a-z])[A-Z]:\\/i.test(text) || /\\\\\?\\/.test(text) || /file:\/\//i.test(text);
}

function validateResultTarget(result, planTarget) {
  const failures = [];
  const blockers = [];
  const text = JSON.stringify(result);

  if (!planTarget) {
    failures.push(`${result.id}: no matching launch-plan target`);
    return { failures, blockers };
  }

  if (result.platform !== planTarget.platform) {
    failures.push(`${result.id}: platform ${result.platform} does not match launch plan ${planTarget.platform}`);
  }
  if (!isAllowedPlatformUrl(result.platform, result.publicUrl)) {
    failures.push(`${result.id}: publicUrl host is not allowed for ${result.platform}`);
  }
  if (!isHttpsUrl(result.artifactUrl)) {
    failures.push(`${result.id}: artifactUrl must be null or https`);
  }
  if (text.includes(SEEDED_SECRET)) failures.push(`${result.id}: contains raw seeded GuardBench secret`);
  if (containsLocalPath(text)) failures.push(`${result.id}: contains local absolute path`);

  if (result.status === 'pending') {
    if (!result.blocker) failures.push(`${result.id}: pending result must record a blocker`);
    if (result.publicUrl !== null) failures.push(`${result.id}: pending result must not record a publicUrl`);
    if (result.submittedAt !== null) failures.push(`${result.id}: pending result must not record submittedAt`);
    if (result.operatorVerified) failures.push(`${result.id}: pending result must not be operator verified`);
    blockers.push(`${result.id}: ${result.blocker ?? 'pending launch target'}`);
  }

  if (result.status === 'submitted') {
    if (!result.publicUrl) failures.push(`${result.id}: submitted result must record publicUrl`);
    if (planTarget.status === 'blocked-until-artifact-url' && !result.artifactUrl) {
      failures.push(`${result.id}: submitted artifact-url target must record artifactUrl`);
    }
    if (!result.submittedAt) failures.push(`${result.id}: submitted result must record submittedAt`);
    if (!result.operatorVerified) failures.push(`${result.id}: submitted result must be operator verified`);
    if (planTarget.manualRuleCheckRequired && !result.manualRuleCheckCompleted) {
      failures.push(`${result.id}: submitted result must record manual rule check completion`);
    }
    for (const check of planTarget.postSubmitChecks) {
      if (!result.postSubmitChecksCompleted.includes(check)) {
        failures.push(`${result.id}: missing completed post-submit check: ${check}`);
      }
    }
  }

  if ((result.status === 'failed' || result.status === 'skipped') && !result.blocker) {
    failures.push(`${result.id}: ${result.status} result must record a blocker`);
  }

  return { failures, blockers };
}

export async function verifyBrowserLaunchResults(options = {}) {
  const resultsPath = options.results ?? DEFAULT_RESULTS;
  const schemaPath = options.schema ?? DEFAULT_SCHEMA;
  const planPath = options.plan ?? DEFAULT_PLAN;
  const results = readJson(resultsPath);
  const schema = readJson(schemaPath);
  const plan = readJson(planPath);
  const planReport = await verifyBrowserLaunchPlan({ plan: planPath });
  const planTargets = new Map((plan.targets ?? []).map(target => [target.id, target]));
  const failures = [
    ...validateSchema(results, schema, 'audrey-browser-launch-results').map(failure => `browser launch results schema: ${failure}`),
  ];
  const blockers = [];
  const seen = new Set();
  const targetReports = [];

  if (!planReport.ok) {
    failures.push(...planReport.failures.map(failure => `browser launch plan: ${failure}`));
  }
  if (results.plan !== planPath) {
    failures.push(`browser launch results must point at ${planPath}`);
  }

  for (const result of results.targets ?? []) {
    if (seen.has(result.id)) failures.push(`${result.id}: duplicate result id`);
    seen.add(result.id);
    const planTarget = planTargets.get(result.id);
    const targetValidation = validateResultTarget(result, planTarget);
    failures.push(...targetValidation.failures);
    blockers.push(...targetValidation.blockers);
    targetReports.push({
      id: result.id,
      platform: result.platform,
      status: result.status,
      publicUrl: result.publicUrl,
      artifactUrl: result.artifactUrl,
      operatorVerified: result.operatorVerified,
      manualRuleCheckCompleted: result.manualRuleCheckCompleted,
      ok: targetValidation.failures.length === 0,
      failures: targetValidation.failures,
    });
  }

  const planOrder = [...(plan.targets ?? [])].sort((a, b) => a.order - b.order).map(target => target.id);
  const resultOrder = [...(results.targets ?? [])].map(target => target.id);
  if (resultOrder.join('|') !== planOrder.join('|')) {
    failures.push(`browser launch results order must be ${planOrder.join(', ')}`);
  }
  for (const id of planOrder) {
    if (!seen.has(id)) failures.push(`Missing browser launch result: ${id}`);
  }

  const notSubmitted = targetReports.filter(target => target.status !== 'submitted').map(target => target.id);
  const ready = failures.length === 0 && notSubmitted.length === 0;
  if (options.strict === true && notSubmitted.length > 0) {
    failures.push(`strict launch readiness requires submitted targets: ${notSubmitted.join(', ')}`);
  }

  return {
    schemaVersion: '1.0.0',
    suite: 'Audrey browser launch results verification',
    generatedAt: new Date().toISOString(),
    ok: failures.length === 0,
    ready,
    strict: options.strict === true,
    results: publicPath(fromRoot(resultsPath)),
    plan: publicPath(fromRoot(planPath)),
    targets: targetReports,
    blockers,
    failures,
  };
}

async function main() {
  const args = parseArgs();
  if (args.help) {
    console.log(usage());
    return;
  }

  const report = await verifyBrowserLaunchResults(args);
  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
  } else if (report.ok) {
    const submitted = report.targets.filter(target => target.status === 'submitted').length;
    const pending = report.targets.length - submitted;
    console.log(`Browser launch results verification passed: ${submitted} submitted, ${pending} pending`);
  } else {
    console.error('Browser launch results verification failed:');
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
