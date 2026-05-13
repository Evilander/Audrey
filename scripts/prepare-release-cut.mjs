import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = process.cwd();
const DEFAULT_TARGET_VERSION = '1.0.0';
const VERSION_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

function fromRoot(path) {
  return resolve(ROOT, path);
}

function readText(path) {
  const absolute = fromRoot(path);
  if (!existsSync(absolute)) throw new Error(`Missing required file: ${path}`);
  return readFileSync(absolute, 'utf-8');
}

function writeText(path, content) {
  writeFileSync(fromRoot(path), content, 'utf-8');
}

function readJson(path) {
  return JSON.parse(readText(path));
}

function parseArgs(argv = process.argv.slice(2)) {
  const args = {
    targetVersion: DEFAULT_TARGET_VERSION,
    date: new Date().toISOString().slice(0, 10),
    apply: false,
    json: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if ((token === '--target-version' || token === '--version') && argv[i + 1]) args.targetVersion = argv[++i];
    else if (token === '--date' && argv[i + 1]) args.date = argv[++i];
    else if (token === '--apply') args.apply = true;
    else if (token === '--json') args.json = true;
    else if (token === '--help' || token === '-h') args.help = true;
    else throw new Error(`Unknown argument: ${token}`);
  }

  return args;
}

function usage() {
  return `Usage: node scripts/prepare-release-cut.mjs [options]

Options:
  --target-version <version>  Target release version. Default: ${DEFAULT_TARGET_VERSION}.
  --date <YYYY-MM-DD>         Changelog date. Default: today.
  --apply                    Write the planned release-cut edits. Dry-run by default.
  --json                     Print the machine-readable plan.
`;
}

function assertValidVersion(version) {
  if (!VERSION_RE.test(version)) throw new Error(`Invalid semver version: ${version}`);
}

function compareCoreVersions(a, b) {
  const pa = a.split(/[+-]/)[0].split('.').map(Number);
  const pb = b.split(/[+-]/)[0].split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return Math.sign(pa[i] - pb[i]);
  }
  return 0;
}

function currentVersionSnapshot() {
  const pkg = readJson('package.json');
  const lock = readJson('package-lock.json');
  const config = readText('mcp-server/config.ts');
  const python = readText('python/audrey_memory/_version.py');
  return {
    packageJson: pkg.version,
    packageLock: lock.version,
    packageLockRoot: lock.packages?.['']?.version,
    mcpConfig: config.match(/export const VERSION = '([^']+)'/)?.[1] ?? null,
    python: python.match(/__version__\s*=\s*"([^"]+)"/)?.[1] ?? null,
  };
}

function replaceOnce(text, pattern, replacement, label) {
  let count = 0;
  const next = text.replace(pattern, (...args) => {
    count += 1;
    return typeof replacement === 'function' ? replacement(...args) : replacement;
  });
  if (count !== 1) throw new Error(`Expected one ${label} replacement, found ${count}`);
  return next;
}

function updatePackageJson(targetVersion) {
  const pkg = readJson('package.json');
  pkg.version = targetVersion;
  return `${JSON.stringify(pkg, null, 2)}\n`;
}

function updatePackageLock(targetVersion) {
  const lock = readJson('package-lock.json');
  lock.version = targetVersion;
  if (!lock.packages?.['']) throw new Error('package-lock.json is missing packages[""]');
  lock.packages[''].version = targetVersion;
  return `${JSON.stringify(lock, null, 2)}\n`;
}

function updateMcpConfig(targetVersion) {
  return replaceOnce(
    readText('mcp-server/config.ts'),
    /export const VERSION = '[^']+';/,
    `export const VERSION = '${targetVersion}';`,
    'mcp VERSION',
  );
}

function updatePythonVersion(targetVersion) {
  return replaceOnce(
    readText('python/audrey_memory/_version.py'),
    /__version__\s*=\s*"[^"]+"/,
    `__version__ = "${targetVersion}"`,
    'Python __version__',
  );
}

function targetChangelogHeader(targetVersion) {
  return `## ${targetVersion} - `;
}

export function releaseChangelogSection(targetVersion, date) {
  return `## ${targetVersion} - ${date}

### Audrey Guard

- Adds the Memory Controller layer and \`audrey guard\` CLI for memory-before-action decisions that return allow, warn, or block with evidence.
- Adds Claude Code hook generation and hook-stdin support so pre-tool checks and post-tool traces can run inside real agent sessions.
- Binds validation feedback to preflight event ids, evidence ids, and Guard action fingerprints so remembered guidance can be audited after use.

### GuardBench And Paper Artifacts

- Ships GuardBench, a local comparative benchmark for pre-action memory control with Audrey Guard, no-memory, recent-window, vector-only, and FTS-only baselines.
- Adds portable GuardBench submission bundles, conformance cards, JSON schemas, adapter self-tests, leaderboard generation, and external adapter evidence reports.
- Adds Mem0 Platform and Zep Cloud adapter runners that use runtime-only API keys and keep dry-run evidence separate from live external scores.
- Ships the Audrey Guard paper source, claim register, launch-copy verifier, browser launch plan/results ledger, deterministic arXiv source package, and paper submission bundle.

### Release Controls

- Adds the pending-aware \`release:readiness\` verifier and strict \`release:readiness:strict\` gate for the final 1.0 cut.
- Adds \`release:cut:plan\` and \`release:cut:apply\` so npm, lockfile, MCP, Python, and changelog version surfaces are cut consistently.
- Adds production dependency audit coverage to the release gates and keeps the current production audit clean.

### Runtime And Client Hardening

- Improves recall degradation reporting across capsules, strict preflights, status surfaces, and Guard decisions.
- Batches embedding provider calls in \`encodeBatch\` and tightens exact-failure matching, redaction, action fingerprinting, and control-memory recall.
- Hardens Docker/API configuration, Python client behavior, MCP surfaces, and test execution on locked-down Windows hosts.

`;
}

export function insertChangelogSection(changelog, targetVersion, date) {
  if (changelog.includes(targetChangelogHeader(targetVersion))) return changelog;
  return replaceOnce(
    changelog,
    /(# Changelog\r?\n\r?\n)/,
    match => `${match}${releaseChangelogSection(targetVersion, date)}`,
    'changelog insertion point',
  );
}

function updateChangelog(targetVersion, date) {
  return insertChangelogSection(readText('CHANGELOG.md'), targetVersion, date);
}

function plannedFiles(targetVersion, date) {
  return [
    ['package.json', updatePackageJson(targetVersion)],
    ['package-lock.json', updatePackageLock(targetVersion)],
    ['mcp-server/config.ts', updateMcpConfig(targetVersion)],
    ['python/audrey_memory/_version.py', updatePythonVersion(targetVersion)],
    ['CHANGELOG.md', updateChangelog(targetVersion, date)],
  ];
}

function changeSummary(path, before, after) {
  return {
    path,
    changed: before !== after,
    beforeBytes: Buffer.byteLength(before),
    afterBytes: Buffer.byteLength(after),
  };
}

export function prepareReleaseCut(options = {}) {
  const targetVersion = options.targetVersion ?? DEFAULT_TARGET_VERSION;
  const date = options.date ?? new Date().toISOString().slice(0, 10);
  const apply = options.apply === true;
  assertValidVersion(targetVersion);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`Invalid release date: ${date}`);

  const versions = currentVersionSnapshot();
  const versionValues = Object.values(versions);
  const failures = [];
  if (versionValues.some(value => !value)) failures.push('One or more release version surfaces are missing');
  if (new Set(versionValues).size !== 1) failures.push(`Release version surfaces are not aligned: ${JSON.stringify(versions)}`);
  if (versions.packageJson && compareCoreVersions(targetVersion, versions.packageJson) < 0) {
    failures.push(`Target version ${targetVersion} is lower than current package version ${versions.packageJson}`);
  }

  const files = plannedFiles(targetVersion, date).map(([path, after]) => {
    const before = readText(path);
    return { ...changeSummary(path, before, after), content: after };
  });

  if (apply && failures.length === 0) {
    for (const file of files) {
      if (file.changed) writeText(file.path, file.content);
    }
  }

  return {
    schemaVersion: '1.0.0',
    suite: 'Audrey release cut preparation',
    generatedAt: new Date().toISOString(),
    targetVersion,
    date,
    apply,
    ok: failures.length === 0,
    currentVersions: versions,
    files: files.map(({ content, ...file }) => file),
    nextCommands: [
      'npm run release:gate:paper',
      'npm run release:readiness:strict -- --json',
      'npm run python:release:check',
    ],
    failures,
  };
}

async function main() {
  const args = parseArgs();
  if (args.help) {
    console.log(usage());
    return;
  }

  const report = prepareReleaseCut(args);
  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
  } else if (report.ok) {
    const changed = report.files.filter(file => file.changed).map(file => file.path);
    console.log(`${report.apply ? 'Applied' : 'Planned'} Audrey ${report.targetVersion} release cut: ${changed.length} file(s)`);
    for (const file of changed) console.log(`- ${file}`);
  } else {
    console.error('Release cut preparation failed:');
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
