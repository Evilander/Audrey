#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyExternalGuardBenchEvidence } from '../benchmarks/verify-external-evidence.mjs';
import { verifyBrowserLaunchResults } from './verify-browser-launch-results.mjs';
import { verifyReleaseReadiness } from './verify-release-readiness.mjs';

const ROOT = process.cwd();
const DEFAULT_VERSION = '1.0.0';
const DEFAULT_OUT = '.tmp/release-artifacts/completion-audit.json';
const NPM_REGISTRY = 'https://registry.npmjs.org/';

function fromRoot(path) {
  return resolve(ROOT, path);
}

function readText(path) {
  return readFileSync(fromRoot(path), 'utf-8');
}

function readJson(path) {
  return JSON.parse(readText(path).replace(/^\uFEFF/, ''));
}

function parseArgs(argv = process.argv.slice(2)) {
  const args = {
    version: DEFAULT_VERSION,
    out: DEFAULT_OUT,
    json: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if ((token === '--version' || token === '--target-version') && argv[i + 1]) args.version = argv[++i];
    else if (token === '--out' && argv[i + 1]) args.out = argv[++i];
    else if (token === '--json') args.json = true;
    else if (token === '--help' || token === '-h') args.help = true;
    else throw new Error(`Unknown argument: ${token}`);
  }

  return args;
}

function usage() {
  return `Usage: node scripts/audit-release-completion.mjs [options]

Options:
  --version <version>  Target release version. Default: ${DEFAULT_VERSION}.
  --out <path>         Output JSON report. Default: ${DEFAULT_OUT}.
  --json               Print the full machine-readable report.
`;
}

function commandFor(command, args) {
  if (process.platform === 'win32' && command === 'npm') {
    return { command: process.env.ComSpec ?? 'cmd.exe', args: ['/d', '/c', 'npm', ...args] };
  }
  return { command, args };
}

function run(command, args, options = {}) {
  const prepared = commandFor(command, args);
  const result = spawnSync(prepared.command, prepared.args, {
    cwd: ROOT,
    encoding: 'utf-8',
    timeout: options.timeout ?? 120_000,
    env: process.env,
  });
  return {
    command: [command, ...args].join(' '),
    ok: result.status === 0,
    status: result.status,
    stdout: result.stdout?.trim() ?? '',
    stderr: result.stderr?.trim() ?? '',
    error: result.error?.message ?? null,
  };
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(fromRoot(path))).digest('hex');
}

function artifactEvidence(path) {
  if (!existsSync(fromRoot(path))) return { path, exists: false };
  return {
    path,
    exists: true,
    sha256: sha256(path),
    bytes: readFileSync(fromRoot(path)).byteLength,
  };
}

function checklistItem(id, requirement, status, evidence = [], gaps = []) {
  return { id, requirement, status, evidence, gaps };
}

function statusFromGaps(gaps, passed = true) {
  if (!passed) return 'failed';
  return gaps.length ? 'pending' : 'passed';
}

function commandEvidence(result) {
  const firstLine = `${result.stderr}\n${result.stdout}`.split(/\r?\n/).map(line => line.trim()).find(Boolean);
  return `${result.command}: ${result.ok ? 'ok' : `exit ${result.status ?? 'unknown'}`}${firstLine ? ` (${firstLine})` : ''}`;
}

function extractRemoteRefs(output) {
  const refs = new Map();
  for (const line of output.split(/\r?\n/)) {
    const [sha, ref] = line.trim().split(/\s+/);
    if (sha && ref) refs.set(ref, sha);
  }
  return refs;
}

function latestGitObjectReport() {
  const path = '.tmp/release-git-object-report.json';
  return existsSync(fromRoot(path)) ? readJson(path) : null;
}

async function checkPypi(version) {
  try {
    const response = await fetch(`https://pypi.org/pypi/audrey-memory/${version}/json`);
    return { ok: response.ok, status: response.status };
  } catch (error) {
    return { ok: false, status: 'network-error', error: error.message };
  }
}

function localPathSweep(paths) {
  const failures = [];
  const localPathPattern = /(^|[^a-z])[A-Z]:\\|\\\\\?\\|file:\/\//i;
  for (const path of paths) {
    const absolute = fromRoot(path);
    if (!existsSync(absolute)) continue;
    const scan = run('rg', ['-n', '-F', '-e', 'B:\\Projects', '-e', 'C:\\Users', '-e', '\\\\?\\', '-e', 'file://', path], { timeout: 30_000 });
    if (scan.status === 0) failures.push(`${path}: local path match found`);
    if (scan.status !== 0 && scan.status !== 1) failures.push(`${path}: local path sweep failed (${scan.stderr || scan.stdout})`);
    if (scan.stdout && localPathPattern.test(scan.stdout)) failures.push(`${path}: local path sweep output contains local path`);
  }
  return failures;
}

export async function auditReleaseCompletion(options = {}) {
  const version = options.version ?? DEFAULT_VERSION;
  const out = options.out ?? DEFAULT_OUT;
  const pkg = readJson('package.json');
  const readiness = await verifyReleaseReadiness({ targetVersion: version, allowPending: true });
  const strictReadiness = await verifyReleaseReadiness({ targetVersion: version, allowPending: false });
  const browserResults = await verifyBrowserLaunchResults();
  const externalEvidence = await verifyExternalGuardBenchEvidence({ allowPending: true, write: false });
  const paperVerify = run('node', ['scripts/verify-paper-artifacts.mjs'], { timeout: 180_000 });
  const paperBundleVerify = run('node', ['scripts/verify-paper-submission-bundle.mjs'], { timeout: 120_000 });
  const audit = run('npm', ['audit', '--omit=dev', '--audit-level=moderate'], { timeout: 120_000 });
  const diffCheck = run('git', ['diff', '--check'], { timeout: 60_000 });
  const bundleVerify = run('git', ['bundle', 'verify', `.tmp/release-artifacts/audrey-${version}.git.bundle`], { timeout: 60_000 });
  const remoteRefsResult = run('git', ['-c', 'http.sslBackend=openssl', 'ls-remote', 'origin', 'refs/heads/master', `refs/tags/v${version}`], { timeout: 60_000 });
  const npmView = run('npm', ['view', `audrey@${version}`, 'version', '--registry', NPM_REGISTRY], { timeout: 60_000 });
  const pypi = await checkPypi(version);
  const gitObjects = latestGitObjectReport();
  const remoteRefs = extractRemoteRefs(remoteRefsResult.stdout);
  const artifactReport = existsSync(fromRoot('.tmp/release-artifacts/release-finalize-report.json'))
    ? readJson('.tmp/release-artifacts/release-finalize-report.json')
    : null;
  const localPathFailures = localPathSweep(['docs/paper/output', 'benchmarks/output']);

  const checklist = [];
  const versionGaps = [];
  if (pkg.version !== version) versionGaps.push(`package.json is ${pkg.version}, expected ${version}`);
  if (!readiness.ok) versionGaps.push(...readiness.failures.map(failure => `readiness failure: ${failure}`));
  checklist.push(checklistItem(
    'code-release-local-readiness',
    'Audrey codebase is cut to 1.0.0 and local release gates are coherent.',
    statusFromGaps(versionGaps, readiness.ok),
    [
      `package.json version=${pkg.version}`,
      `readiness ok=${readiness.ok}`,
      `strict readiness ok=${strictReadiness.ok}`,
      `pending blockers=${readiness.blockers.length}`,
    ],
    versionGaps,
  ));

  const sourceGaps = [];
  const remoteMaster = remoteRefs.get('refs/heads/master');
  const remoteTag = remoteRefs.get(`refs/tags/v${version}`) ?? remoteRefs.get(`refs/tags/v${version}^{}`);
  if (!bundleVerify.ok) sourceGaps.push('release Git bundle does not verify');
  if (!gitObjects?.commit) sourceGaps.push('missing external release commit object report');
  if (gitObjects?.commit && remoteMaster !== gitObjects.commit) {
    sourceGaps.push(`remote master is ${remoteMaster ?? 'missing'}, not release commit ${gitObjects.commit}`);
  }
  if (!remoteTag) sourceGaps.push(`remote tag v${version} is missing`);
  checklist.push(checklistItem(
    'source-control-release-state',
    'Final release commit and v1.0.0 tag are present on the public repository.',
    statusFromGaps(sourceGaps, bundleVerify.ok && remoteRefsResult.ok),
    [
      commandEvidence(bundleVerify),
      `external commit=${gitObjects?.commit ?? 'missing'}`,
      `external tag object=${gitObjects?.tag ?? 'missing'}`,
      `remote master=${remoteMaster ?? 'missing'}`,
      `remote tag=${remoteTag ?? 'missing'}`,
    ],
    sourceGaps,
  ));

  const npmArtifact = artifactEvidence(`.tmp/release-artifacts/audrey-${version}.tgz`);
  const npmGaps = [];
  if (!npmArtifact.exists) npmGaps.push('npm tarball missing');
  if (!npmView.ok) npmGaps.push(`audrey@${version} is not published on npm or npm registry check failed`);
  checklist.push(checklistItem(
    'npm-package-publication',
    'audrey@1.0.0 npm package is packaged and published.',
    statusFromGaps(npmGaps),
    [JSON.stringify(npmArtifact), commandEvidence(npmView)],
    npmGaps,
  ));

  const wheel = artifactEvidence(`python/dist/audrey_memory-${version}-py3-none-any.whl`);
  const sdist = artifactEvidence(`python/dist/audrey_memory-${version}.tar.gz`);
  const pypiGaps = [];
  if (!wheel.exists) pypiGaps.push('Python wheel missing');
  if (!sdist.exists) pypiGaps.push('Python sdist missing');
  if (!pypi.ok) pypiGaps.push(`audrey-memory ${version} is not published on PyPI (status=${pypi.status})`);
  checklist.push(checklistItem(
    'python-package-publication',
    'audrey-memory 1.0.0 Python package is built and published.',
    statusFromGaps(pypiGaps),
    [JSON.stringify(wheel), JSON.stringify(sdist), `PyPI status=${pypi.status}`],
    pypiGaps,
  ));

  const paperGaps = [];
  if (!paperVerify.ok) paperGaps.push('paper artifact verifier failed');
  if (!paperBundleVerify.ok) paperGaps.push('paper submission bundle verifier failed');
  checklist.push(checklistItem(
    'paper-local-quality',
    'Research paper, claim register, bibliography, evidence ledger, arXiv source, and submission bundle verify locally.',
    statusFromGaps(paperGaps, paperVerify.ok && paperBundleVerify.ok),
    [commandEvidence(paperVerify), commandEvidence(paperBundleVerify)],
    paperGaps,
  ));

  const publicationGaps = [];
  if (!browserResults.ok) publicationGaps.push(...browserResults.failures);
  if (!browserResults.ready) publicationGaps.push(...browserResults.blockers);
  checklist.push(checklistItem(
    'paper-publication',
    'Paper is publicly submitted/published across the launch targets recorded by the browser launch ledger.',
    statusFromGaps(publicationGaps, browserResults.ok),
    [
      `browser results ok=${browserResults.ok}`,
      `browser results ready=${browserResults.ready}`,
      `submitted=${browserResults.targets.filter(target => target.status === 'submitted').length}/${browserResults.targets.length}`,
    ],
    publicationGaps,
  ));

  const guardGaps = [];
  if (!externalEvidence.ok) guardGaps.push(...externalEvidence.failures);
  for (const adapter of externalEvidence.adapters.filter(adapter => adapter.status !== 'verified')) {
    guardGaps.push(`${adapter.id}: ${adapter.missingEnv?.length ? `missing ${adapter.missingEnv.join(', ')}` : adapter.evidenceKind}`);
  }
  checklist.push(checklistItem(
    'external-guardbench-evidence',
    'External GuardBench adapters are live-verified, not only dry-run verified.',
    statusFromGaps(guardGaps, externalEvidence.ok),
    externalEvidence.adapters.map(adapter => `${adapter.id}: ${adapter.status}/${adapter.evidenceKind}`),
    guardGaps,
  ));

  const safetyGaps = [];
  if (!audit.ok) safetyGaps.push('production dependency audit failed');
  if (!diffCheck.ok) safetyGaps.push('git diff --check failed');
  safetyGaps.push(...localPathFailures);
  checklist.push(checklistItem(
    'release-safety-hygiene',
    'Release artifacts pass dependency audit, whitespace checks, and local-path leak sweeps.',
    statusFromGaps(safetyGaps, audit.ok && diffCheck.ok),
    [commandEvidence(audit), commandEvidence(diffCheck), `local path sweep failures=${localPathFailures.length}`],
    safetyGaps,
  ));

  const finalizerGaps = [];
  if (!artifactReport) finalizerGaps.push('missing release-finalize-report.json');
  checklist.push(checklistItem(
    'release-finalizer-artifacts',
    'Finalization report records packaged npm/Python artifacts and source-control handoff artifacts.',
    statusFromGaps(finalizerGaps),
    artifactReport?.artifacts?.map(artifact => `${artifact.path} sha256=${artifact.sha256}`) ?? [],
    finalizerGaps,
  ));

  const complete = checklist.every(item => item.status === 'passed');
  const report = {
    schemaVersion: '1.0.0',
    suite: 'Audrey release completion audit',
    generatedAt: new Date().toISOString(),
    objective: 'audrey 1.0 release + published audrey research paper',
    successCriteria: [
      'Audrey code is cut to 1.0.0 with local gates passing.',
      'Final release commit and v1.0.0 tag are on the public repository.',
      'npm and Python packages are packaged and publicly published.',
      'Paper artifacts verify locally and compile for arXiv.',
      'Paper publication targets are publicly submitted and operator verified.',
      'GuardBench local and external evidence is verified without leaked secrets or local paths.',
    ],
    complete,
    checklist,
    readiness: {
      ok: readiness.ok,
      ready: readiness.ready,
      blockers: readiness.blockers,
      failures: readiness.failures,
    },
    strictReadiness: {
      ok: strictReadiness.ok,
      ready: strictReadiness.ready,
      blockers: strictReadiness.blockers,
      failures: strictReadiness.failures,
    },
  };

  mkdirSync(dirname(fromRoot(out)), { recursive: true });
  writeFileSync(fromRoot(out), `${JSON.stringify(report, null, 2)}\n`, 'utf-8');
  return report;
}

async function main() {
  const args = parseArgs();
  if (args.help) {
    console.log(usage());
    return;
  }

  const report = await auditReleaseCompletion(args);
  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`Audrey release completion audit: complete=${report.complete}`);
    for (const item of report.checklist) {
      console.log(`- ${item.id}: ${item.status}${item.gaps.length ? ` (${item.gaps.length} gap(s))` : ''}`);
    }
  }

  if (!report.complete) process.exit(1);
}

function isDirectRun() {
  return Boolean(process.argv[1]) && resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase();
}

if (isDirectRun()) {
  main().catch(error => {
    console.error(error.stack ?? error.message);
    process.exit(1);
  });
}
