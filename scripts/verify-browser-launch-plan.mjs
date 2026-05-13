import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { publicPath } from '../benchmarks/public-paths.mjs';
import { validateSchema } from '../benchmarks/validate-guardbench-artifacts.mjs';
import { verifyPublicationPack } from './verify-publication-pack.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_PLAN = 'docs/paper/browser-launch-plan.json';
const DEFAULT_SCHEMA = 'docs/paper/browser-launch-plan.schema.json';
const REQUIRED_TARGETS = [
  'arxiv-preprint',
  'hacker-news-show',
  'reddit-discussion',
  'x-launch-thread',
  'linkedin-launch-post',
];
const REQUIRED_PREFLIGHT_COMMANDS = [
  'npm run release:gate:paper',
  'npm run paper:publication-pack',
  'npm run paper:bundle:verify',
  'npm run paper:launch-plan',
];
const ALLOWED_HOSTS = {
  arxiv: ['arxiv.org'],
  'hacker-news': ['news.ycombinator.com'],
  reddit: ['www.reddit.com', 'reddit.com'],
  x: ['twitter.com', 'x.com'],
  linkedin: ['www.linkedin.com', 'linkedin.com'],
};
const PLATFORM_ENTRY_RULES = {
  arxiv: new Set(['arxiv-title', 'arxiv-abstract']),
  'hacker-news': new Set(['hacker-news-title', 'hacker-news-comment']),
  reddit: new Set(['reddit-title', 'reddit-body']),
  x: new Set(['x-post-1', 'x-post-2']),
  linkedin: new Set(['linkedin-post']),
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
    plan: DEFAULT_PLAN,
    schema: DEFAULT_SCHEMA,
    json: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === '--plan' && argv[i + 1]) args.plan = argv[++i];
    else if (token === '--schema' && argv[i + 1]) args.schema = argv[++i];
    else if (token === '--json') args.json = true;
    else if (token === '--help' || token === '-h') args.help = true;
    else throw new Error(`Unknown argument: ${token}`);
  }

  return args;
}

function usage() {
  return `Usage: node scripts/verify-browser-launch-plan.mjs [options]

Options:
  --plan <path>    Browser launch plan JSON. Default: ${DEFAULT_PLAN}.
  --schema <path>  Browser launch plan schema. Default: ${DEFAULT_SCHEMA}.
  --json           Print the machine-readable verification report.
`;
}

function isAllowedHost(platform, value) {
  try {
    const url = new URL(value);
    return (ALLOWED_HOSTS[platform] ?? []).includes(url.hostname);
  } catch {
    return false;
  }
}

function hasPendingBoundary(text) {
  return /\b(pending|not claim|not claimed|does not report|remain pending|live evidence|strict evidence)\b/i.test(text);
}

function validateTarget(target, entryMap, sourceIds) {
  const failures = [];
  const allowedEntries = PLATFORM_ENTRY_RULES[target.platform] ?? new Set();
  const targetEntries = [];

  if (!isAllowedHost(target.platform, target.url)) {
    failures.push(`${target.id}: URL host is not allowed for ${target.platform}`);
  }
  for (const entryId of target.contentEntryIds) {
    const entry = entryMap.get(entryId);
    if (!entry) {
      failures.push(`${target.id}: unknown publication-pack entry ${entryId}`);
      continue;
    }
    if (entry.platform !== target.platform) {
      failures.push(`${target.id}: entry ${entryId} belongs to ${entry.platform}, not ${target.platform}`);
    }
    if (!allowedEntries.has(entryId)) {
      failures.push(`${target.id}: entry ${entryId} is not approved for ${target.platform}`);
    }
    if (entry.text.length > entry.maxChars) {
      failures.push(`${target.id}: entry ${entryId} exceeds maxChars`);
    }
    if (/\b(Mem0|Zep)\b/.test(entry.text) && !hasPendingBoundary(entry.text)) {
      failures.push(`${target.id}: entry ${entryId} mentions Mem0/Zep without pending boundary language`);
    }
    targetEntries.push(entry);
  }
  for (const sourceId of target.sourceRefs) {
    if (!sourceIds.has(sourceId)) failures.push(`${target.id}: unknown sourceRef ${sourceId}`);
  }
  for (const artifact of target.artifactRefs) {
    if (!existsSync(fromRoot(artifact))) failures.push(`${target.id}: missing artifactRef ${artifact}`);
  }
  if (target.platform === 'reddit' && target.manualRuleCheckRequired !== true) {
    failures.push(`${target.id}: Reddit target must require a manual subreddit rule check`);
  }
  if (target.platform === 'hacker-news' && target.manualRuleCheckRequired !== true) {
    failures.push(`${target.id}: Hacker News target must require a manual guideline check`);
  }
  if (target.platform === 'arxiv' && target.manualRuleCheckRequired !== true) {
    failures.push(`${target.id}: arXiv target must require a manual category/metadata check`);
  }
  if (!target.humanRequired) failures.push(`${target.id}: browser launch targets must require a human operator`);
  if (!target.authRequired) failures.push(`${target.id}: browser launch targets must require authenticated account review`);
  if (target.operatorChecks.length < 2) failures.push(`${target.id}: operator checklist is too thin`);
  if (target.postSubmitChecks.length < 1) failures.push(`${target.id}: missing post-submit checks`);
  if (
    target.platform === 'x' &&
    target.status === 'blocked-until-artifact-url' &&
    !targetEntries.some(entry => entry.requiresArtifactUrl === true)
  ) {
    failures.push(`${target.id}: X artifact-url launch target must include a publication entry with reserved URL budget`);
  }

  return failures;
}

export async function verifyBrowserLaunchPlan(options = {}) {
  const plan = readJson(options.plan ?? DEFAULT_PLAN);
  const schema = readJson(options.schema ?? DEFAULT_SCHEMA);
  const publicationReport = await verifyPublicationPack({ pack: plan.publicationPack });
  const publicationPack = readJson(plan.publicationPack);
  const entryMap = new Map((publicationPack.entries ?? []).map(entry => [entry.id, entry]));
  const sourceIds = new Set((plan.sources ?? []).map(source => source.id));
  const ids = new Set();
  const targetReports = [];
  const failures = [
    ...validateSchema(plan, schema, 'audrey-browser-launch-plan').map(failure => `browser launch plan schema: ${failure}`),
  ];

  if (!publicationReport.ok) {
    failures.push(...publicationReport.failures.map(failure => `publication pack: ${failure}`));
  }
  if (plan.publicationPack !== 'docs/paper/publication-pack.json') {
    failures.push('browser launch plan must point at docs/paper/publication-pack.json');
  }
  for (const command of REQUIRED_PREFLIGHT_COMMANDS) {
    if (!(plan.preflightCommands ?? []).includes(command)) failures.push(`Missing browser-launch preflight command: ${command}`);
  }
  for (const target of plan.targets ?? []) {
    const targetFailures = [];
    if (ids.has(target.id)) targetFailures.push(`${target.id}: duplicate target id`);
    ids.add(target.id);
    targetFailures.push(...validateTarget(target, entryMap, sourceIds));
    targetReports.push({
      id: target.id,
      platform: target.platform,
      status: target.status,
      url: target.url,
      contentEntryIds: target.contentEntryIds,
      manualRuleCheckRequired: target.manualRuleCheckRequired,
      ok: targetFailures.length === 0,
      failures: targetFailures,
    });
    failures.push(...targetFailures);
  }
  for (const id of REQUIRED_TARGETS) {
    if (!ids.has(id)) failures.push(`Missing browser-launch target: ${id}`);
  }
  const ordered = [...(plan.targets ?? [])].sort((a, b) => a.order - b.order).map(target => target.id);
  if (ordered.join('|') !== REQUIRED_TARGETS.join('|')) {
    failures.push(`Browser-launch target order must be ${REQUIRED_TARGETS.join(', ')}`);
  }

  return {
    schemaVersion: '1.0.0',
    suite: 'Audrey browser launch plan verification',
    generatedAt: new Date().toISOString(),
    ok: failures.length === 0,
    plan: publicPath(fromRoot(options.plan ?? DEFAULT_PLAN)),
    publicationPack: publicPath(fromRoot(plan.publicationPack)),
    targets: targetReports,
    failures,
  };
}

async function main() {
  const args = parseArgs();
  if (args.help) {
    console.log(usage());
    return;
  }

  const report = await verifyBrowserLaunchPlan(args);
  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
  } else if (report.ok) {
    console.log(`Browser launch plan verification passed: ${report.targets.length} target(s)`);
  } else {
    console.error('Browser launch plan verification failed:');
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
