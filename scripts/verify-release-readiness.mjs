import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyExternalGuardBenchEvidence } from '../benchmarks/verify-external-evidence.mjs';
import { verifyArxivSourcePackage } from './verify-arxiv-source.mjs';
import { verifyBrowserLaunchPlan } from './verify-browser-launch-plan.mjs';
import { verifyBrowserLaunchResults } from './verify-browser-launch-results.mjs';
import { verifyArxivCompileReport } from './verify-arxiv-compile.mjs';
import { verifyPaperClaims } from './verify-paper-claims.mjs';
import { verifyPaperSubmissionBundle } from './verify-paper-submission-bundle.mjs';
import { verifyPublicationPack } from './verify-publication-pack.mjs';

const ROOT = process.cwd();
const DEFAULT_TARGET_VERSION = '1.0.0';
const PYPI_CREDENTIAL_ENVS = ['TWINE_PASSWORD', 'PYPI_API_TOKEN', 'UV_PUBLISH_TOKEN'];
const NPM_REGISTRY = 'https://registry.npmjs.org/';

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
    targetVersion: DEFAULT_TARGET_VERSION,
    allowPending: false,
    json: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if ((token === '--target-version' || token === '--version') && argv[i + 1]) args.targetVersion = argv[++i];
    else if (token === '--allow-pending') args.allowPending = true;
    else if (token === '--json') args.json = true;
    else if (token === '--help' || token === '-h') args.help = true;
    else throw new Error(`Unknown argument: ${token}`);
  }

  return args;
}

function usage() {
  return `Usage: node scripts/verify-release-readiness.mjs [options]

Options:
  --target-version <version>  Target release version. Default: ${DEFAULT_TARGET_VERSION}.
  --allow-pending            Exit 0 when only publish/account/credential blockers remain.
  --json                     Print the machine-readable readiness report.
`;
}

function check(id, label, status, details = {}) {
  return {
    id,
    label,
    status,
    evidence: details.evidence ?? [],
    blockers: details.blockers ?? [],
    failures: details.failures ?? [],
  };
}

function ok(id, label, evidence) {
  return check(id, label, 'passed', { evidence });
}

function pending(id, label, evidence, blockers) {
  return check(id, label, 'pending', { evidence, blockers });
}

function failed(id, label, evidence, failures) {
  return check(id, label, 'failed', { evidence, failures });
}

function runGit(args, options = {}) {
  return spawnSync('git', args, {
    cwd: ROOT,
    encoding: 'utf-8',
    timeout: options.timeout ?? 120000,
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: '0',
      GCM_INTERACTIVE: 'never',
      GIT_ASKPASS: '',
      SSH_ASKPASS: '',
      ...options.env,
    },
  });
}

function runNpm(args) {
  const command = process.platform === 'win32' ? (process.env.ComSpec ?? 'cmd.exe') : 'npm';
  const commandArgs = process.platform === 'win32' ? ['/d', '/c', 'npm', ...args] : args;
  return spawnSync(command, commandArgs, {
    cwd: ROOT,
    encoding: 'utf-8',
    timeout: 15000,
  });
}

function commandSummary(result) {
  if (result.error) return result.error.message;
  const output = `${result.stderr ?? ''}\n${result.stdout ?? ''}`
    .split(/\r?\n/)
    .map(line => line.trim())
    .find(Boolean);
  return output ?? `command exited ${result.status ?? result.signal ?? 'unknown'}`;
}

function gitOutput(args) {
  const result = runGit(args);
  if (result.status !== 0) return null;
  return result.stdout.trim();
}

function parseRemoteRefs(output) {
  const refs = new Map();
  for (const line of output.split(/\r?\n/)) {
    const [sha, ref] = line.trim().split(/\s+/);
    if (sha && ref) refs.set(ref, sha);
  }
  return refs;
}

function parseBundleRefs(output, targetVersion) {
  const refs = parseRemoteRefs(output);
  return {
    branch: refs.get('refs/heads/master') ?? null,
    tag: refs.get(`refs/tags/v${targetVersion}`) ?? null,
  };
}

function gitMetadataWritableCheck() {
  const probe = fromRoot(`.git/audrey-readiness-${process.pid}.tmp`);
  try {
    writeFileSync(probe, 'ok\n', { flag: 'wx' });
    unlinkSync(probe);
    return { writable: true, evidence: 'gitMetadataWritable=true' };
  } catch (error) {
    try {
      if (existsSync(probe)) unlinkSync(probe);
    } catch {
      // Best effort cleanup only; the original write failure is the useful signal.
    }
    const detail = error?.code ?? error?.message ?? 'unknown error';
    return {
      writable: false,
      evidence: 'gitMetadataWritable=false',
      blocker: `Make .git metadata writable before final commit/tag (${detail})`,
    };
  }
}

function shortSha(value) {
  return value ? value.slice(0, 7) : 'unknown';
}

export function remoteBranchFreshnessStatus({ branch, upstream, upstreamSha }, run = runGit) {
  if (!branch || branch === 'HEAD' || branch === 'unknown') {
    return {
      evidence: ['remoteHead=unverified'],
      blockers: ['Check out a named release branch before final source-control readiness'],
    };
  }

  const remoteRef = `refs/heads/${branch}`;
  let result = run(['ls-remote', 'origin', remoteRef]);
  const fallbackEvidence = [];
  if (result.status !== 0 && /schannel|AcquireCredentialsHandle|SEC_E_NO_CREDENTIALS/i.test(commandSummary(result))) {
    const fallback = run(['-c', 'http.sslBackend=openssl', 'ls-remote', 'origin', remoteRef]);
    if (fallback.status === 0) {
      result = fallback;
      fallbackEvidence.push('remoteHeadTlsFallback=openssl');
    }
  }
  if (result.status !== 0) {
    return {
      evidence: ['remoteHead=unverified', ...fallbackEvidence],
      blockers: [`Verify live remote origin/${branch} before final release (${commandSummary(result)})`],
    };
  }

  const remoteLine = result.stdout.trim().split(/\r?\n/).find(line => line.endsWith(remoteRef));
  const remoteSha = remoteLine?.split(/\s+/)[0];
  if (!remoteSha) {
    return {
      evidence: [`remoteHead=origin/${branch}:missing`],
      blockers: [`Confirm origin/${branch} exists before final release`],
    };
  }

  const evidence = [...fallbackEvidence, `remoteHead=origin/${branch}:${shortSha(remoteSha)}`];
  const blockers = [];
  if (upstream && upstreamSha && upstreamSha !== remoteSha) {
    blockers.push(`Fetch/reconcile origin/${branch}: local ${upstream} is ${shortSha(upstreamSha)} but live remote is ${shortSha(remoteSha)}`);
  }

  return { evidence, blockers };
}

function remoteReleaseRefs(branch, targetVersion, run = runGit) {
  const branchRef = `refs/heads/${branch}`;
  const tagRef = `refs/tags/v${targetVersion}`;
  let result = run(['ls-remote', 'origin', branchRef, tagRef, `${tagRef}^{}`]);
  const evidence = [];
  if (result.status !== 0 && /schannel|AcquireCredentialsHandle|SEC_E_NO_CREDENTIALS/i.test(commandSummary(result))) {
    const fallback = run(['-c', 'http.sslBackend=openssl', 'ls-remote', 'origin', branchRef, tagRef, `${tagRef}^{}`]);
    if (fallback.status === 0) {
      result = fallback;
      evidence.push('releaseRemoteTlsFallback=openssl');
    }
  }

  if (result.status !== 0) {
    return {
      ok: false,
      evidence: [...evidence, 'releaseRemoteRefs=unverified'],
      refs: new Map(),
      blockers: [`Verify live release refs before final release (${commandSummary(result)})`],
    };
  }

  return {
    ok: true,
    evidence,
    refs: parseRemoteRefs(result.stdout),
    blockers: [],
  };
}

function currentWorkingReleaseTree() {
  const objectDir = mkdtempSync(resolve(tmpdir(), `audrey-readiness-objects-${process.pid}-`));
  const indexFile = resolve(tmpdir(), `audrey-readiness-${process.pid}-${Date.now()}.index`);
  const env = {
    GIT_OBJECT_DIRECTORY: objectDir,
    GIT_ALTERNATE_OBJECT_DIRECTORIES: fromRoot('.git/objects'),
    GIT_INDEX_FILE: indexFile,
  };

  try {
    for (const args of [['read-tree', 'HEAD'], ['add', '--all']]) {
      const result = runGit(args, { env, timeout: 120000 });
      if (result.status !== 0) return { ok: false, error: commandSummary(result) };
    }
    const tree = runGit(['write-tree'], { env, timeout: 120000 });
    if (tree.status !== 0) return { ok: false, error: commandSummary(tree) };
    return { ok: true, tree: tree.stdout.trim() };
  } finally {
    rmSync(objectDir, { recursive: true, force: true });
    rmSync(indexFile, { force: true });
  }
}

function releaseSourceHandoffStatus(targetVersion, branch) {
  const objectReportPath = '.tmp/release-git-object-report.json';
  if (!existsSync(fromRoot(objectReportPath))) {
    return {
      usable: false,
      evidence: ['sourceHandoff=missing'],
      blockers: [],
    };
  }

  const report = readJson(objectReportPath);
  const evidence = [
    'sourceHandoff=present',
    `sourceTree=${shortSha(report.tree)}`,
    `sourceCommit=${shortSha(report.commit)}`,
    `sourceTagObject=${shortSha(report.tag)}`,
    `sourceBundle=${report.bundle ?? 'missing'}`,
  ];
  const blockers = [];

  const currentTree = currentWorkingReleaseTree();
  if (!currentTree.ok) {
    blockers.push(`Verify current working tree against source handoff (${currentTree.error})`);
  } else {
    evidence.push(`currentReleaseTree=${shortSha(currentTree.tree)}`);
    if (report.tree && currentTree.tree !== report.tree) {
      blockers.push(`Regenerate release artifacts: current release tree ${currentTree.tree} differs from source handoff tree ${report.tree}`);
    }
  }

  const bundlePath = report.bundle ?? `.tmp/release-artifacts/audrey-${targetVersion}.git.bundle`;
  const bundleVerify = runGit(['bundle', 'verify', bundlePath], { timeout: 60000 });
  if (bundleVerify.status !== 0) {
    blockers.push(`Release source bundle does not verify (${commandSummary(bundleVerify)})`);
  } else {
    evidence.push('sourceBundleVerify=passed');
    const refs = parseBundleRefs(bundleVerify.stdout, targetVersion);
    if (refs.branch !== report.commit) {
      blockers.push(`Release source bundle master is ${refs.branch ?? 'missing'}, expected ${report.commit}`);
    }
    if (refs.tag !== report.tag) {
      blockers.push(`Release source bundle tag is ${refs.tag ?? 'missing'}, expected ${report.tag}`);
    }
  }

  const remote = remoteReleaseRefs(branch, targetVersion);
  evidence.push(...remote.evidence);
  blockers.push(...remote.blockers);
  const remoteMaster = remote.refs.get(`refs/heads/${branch}`);
  const remoteTagObject = remote.refs.get(`refs/tags/v${targetVersion}`);
  const remoteTagCommit = remote.refs.get(`refs/tags/v${targetVersion}^{}`);
  evidence.push(`releaseRemoteMaster=${shortSha(remoteMaster)}`);
  evidence.push(`releaseRemoteTag=${shortSha(remoteTagObject)}`);
  if (report.commit && remoteMaster !== report.commit) {
    blockers.push(`Publish source bundle commit ${report.commit} to origin/${branch} (remote is ${remoteMaster ?? 'missing'})`);
  }
  if (report.tag && remoteTagObject !== report.tag) {
    blockers.push(`Publish source bundle tag object ${report.tag} to refs/tags/v${targetVersion} (remote is ${remoteTagObject ?? 'missing'})`);
  }
  if (remoteTagCommit && report.commit && remoteTagCommit !== report.commit) {
    blockers.push(`Remote v${targetVersion} dereferences to ${remoteTagCommit}, not release commit ${report.commit}`);
  }

  const stalePrefixes = [
    'Regenerate release artifacts',
    'Release source bundle',
    'Verify current working tree',
  ];
  return {
    usable: blockers.every(blocker => !stalePrefixes.some(prefix => blocker.startsWith(prefix))),
    evidence,
    blockers,
  };
}

function pythonVersion() {
  const versionFile = readText('python/audrey_memory/_version.py');
  return versionFile.match(/__version__\s*=\s*"([^"]+)"/)?.[1] ?? null;
}

function currentVersionSnapshot() {
  const pkg = readJson('package.json');
  const lock = readJson('package-lock.json');
  return {
    packageJson: pkg.version,
    packageLock: lock.version,
    packageLockRoot: lock.packages?.['']?.version,
    python: pythonVersion(),
  };
}

function versionChecks(targetVersion) {
  const versions = currentVersionSnapshot();
  const values = Object.entries(versions);
  const uniqueVersions = new Set(values.map(([, value]) => value));
  const evidence = values.map(([name, value]) => `${name}=${value ?? 'missing'}`);

  if (values.some(([, value]) => !value)) {
    return failed('version-surfaces', 'Version surfaces are present', evidence, ['One or more version surfaces are missing']);
  }
  if (uniqueVersions.size !== 1) {
    return failed('version-surfaces', 'Version surfaces are aligned', evidence, ['package.json, package-lock.json, and Python version are not aligned']);
  }
  if (!uniqueVersions.has(targetVersion)) {
    return pending(
      'target-version',
      `Target release version is ${targetVersion}`,
      evidence,
      [`Local version is ${versions.packageJson}; bump all release surfaces to ${targetVersion} only when 1.0 publish is being cut`],
    );
  }
  return ok('target-version', `Target release version is ${targetVersion}`, evidence);
}

function sourceControlCheck(targetVersion) {
  const status = runGit(['status', '--short', '--branch', '--untracked-files=all']);
  if (status.status !== 0) {
    const detail = status.stderr.trim() || status.stdout.trim() || `git status exited ${status.status}`;
    return failed('source-control', 'Source control is ready for release', [], [detail]);
  }

  const statusLines = status.stdout.trim().split(/\r?\n/).filter(Boolean);
  const branchLine = statusLines[0] ?? '## unknown';
  const changedLines = statusLines.slice(1);
  const branch = gitOutput(['rev-parse', '--abbrev-ref', 'HEAD']) ?? 'unknown';
  const head = gitOutput(['rev-parse', '--short', 'HEAD']) ?? 'unknown';
  const upstream = gitOutput(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
  const upstreamSha = upstream ? gitOutput(['rev-parse', upstream]) : null;
  const originPush = gitOutput(['remote', 'get-url', '--push', 'origin']);
  const tagName = `v${targetVersion}`;
  const tagExists = Boolean(gitOutput(['tag', '--list', tagName]));
  const tagsAtHead = (gitOutput(['tag', '--points-at', 'HEAD']) ?? '').split(/\r?\n/).filter(Boolean);
  const metadataWritable = gitMetadataWritableCheck();
  const remoteFreshness = originPush ? remoteBranchFreshnessStatus({ branch, upstream, upstreamSha }) : { evidence: [], blockers: [] };
  const sourceHandoff = originPush ? releaseSourceHandoffStatus(targetVersion, branch) : { usable: false, evidence: [], blockers: [] };
  const evidence = [
    `branch=${branch}`,
    `head=${head}`,
    `status=${branchLine}`,
    `origin=${originPush ?? 'missing'}`,
    `upstream=${upstream ?? 'missing'}`,
    `tag=${tagName}:${tagExists ? 'exists' : 'missing'}`,
    metadataWritable.evidence,
    ...remoteFreshness.evidence,
    ...sourceHandoff.evidence,
  ];

  const blockers = [];
  if (!originPush) blockers.push('Configure an origin push remote before final release');
  if (sourceHandoff.usable) {
    blockers.push(...sourceHandoff.blockers);
    evidence.push('sourceControlLane=external-source-bundle');
  } else {
    if (!metadataWritable.writable && metadataWritable.blocker) blockers.push(metadataWritable.blocker);
    blockers.push(...remoteFreshness.blockers, ...sourceHandoff.blockers);
    if (!upstream) blockers.push('Configure an upstream branch before final release');
    if (upstream) {
      const counts = gitOutput(['rev-list', '--left-right', '--count', `HEAD...${upstream}`]);
      if (counts) {
        const [ahead, behind] = counts.split(/\s+/).map(Number);
        evidence.push(`ahead=${ahead}`, `behind=${behind}`);
        if (ahead > 0) blockers.push(`Push ${ahead} release commit(s) to ${upstream}`);
        if (behind > 0) blockers.push(`Pull or reconcile ${behind} upstream commit(s) before final release`);
      }
    }
    if (changedLines.length > 0) blockers.push(`Commit or stash ${changedLines.length} working-tree change(s) before final release`);
    if (!tagExists) blockers.push(`Create release tag ${tagName} on the final release commit`);
    if (tagExists && !tagsAtHead.includes(tagName)) blockers.push(`Move or recreate ${tagName} so it points at the final release commit`);
  }

  if (blockers.length > 0) {
    return pending('source-control', 'Source control is ready for release', evidence, blockers);
  }
  return ok('source-control', 'Source control is ready for release', [...evidence, `${tagName} points at HEAD`]);
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function targetChangelogStatus(changelog, targetVersion) {
  const sectionStart = new RegExp(`^## ${escapeRegex(targetVersion)}(?:\\s+-\\s+.*)?\\r?$`, 'm');
  const match = changelog.match(sectionStart);
  if (!match || match.index === undefined) return { found: false, placeholderMarkers: [] };

  const rest = changelog.slice(match.index + match[0].length);
  const nextSection = rest.search(/^## /m);
  const section = nextSection === -1 ? rest : rest.slice(0, nextSection);
  const placeholderMarkers = [];
  if (/\bTODO\b/i.test(section)) placeholderMarkers.push('TODO marker');
  if (/Release Cut Checklist/i.test(section)) placeholderMarkers.push('release-cut checklist scaffold');

  return { found: true, placeholderMarkers };
}

function changelogCheck(targetVersion) {
  const changelog = readText('CHANGELOG.md');
  const status = targetChangelogStatus(changelog, targetVersion);
  if (status.found && status.placeholderMarkers.length === 0) {
    return ok('changelog-target', `CHANGELOG has a final ${targetVersion} section`, ['CHANGELOG.md']);
  }
  if (status.found) {
    return failed(
      'changelog-target',
      `CHANGELOG has a final ${targetVersion} section`,
      ['CHANGELOG.md'],
      [`Replace placeholder ${targetVersion} changelog scaffold before strict readiness: ${status.placeholderMarkers.join(', ')}`],
    );
  }
  return pending(
    'changelog-target',
    `CHANGELOG has a final ${targetVersion} section`,
    ['CHANGELOG.md'],
    [`Add the final ${targetVersion} changelog section when the 1.0 release is actually cut`],
  );
}

function pythonDistCheck(targetVersion) {
  const wheel = `python/dist/audrey_memory-${targetVersion}-py3-none-any.whl`;
  const sdist = `python/dist/audrey_memory-${targetVersion}.tar.gz`;
  if (existsSync(fromRoot(wheel)) && existsSync(fromRoot(sdist))) {
    const verification = spawnSync('python', ['scripts/verify-python-package.py', '--version', targetVersion, '--json'], {
      cwd: ROOT,
      encoding: 'utf-8',
    });
    if (verification.status !== 0) {
      const detail = verification.stderr.trim() || verification.stdout.trim() || `python verifier exited ${verification.status}`;
      return failed('python-dist', `Python ${targetVersion} artifacts verify`, [wheel, sdist], [detail]);
    }
    return ok('python-dist', `Python ${targetVersion} artifacts verify`, [wheel, sdist, 'python package verifier passed']);
  }
  return pending(
    'python-dist',
    `Python ${targetVersion} artifacts exist`,
    ['python/dist/'],
    [`Build Python release artifacts for ${targetVersion} and run twine check before publishing`],
  );
}

function pypiPublishCheck(targetVersion) {
  const pyproject = readText('python/pyproject.toml');
  const packageName = pyproject.match(/^name\s*=\s*"([^"]+)"/m)?.[1] ?? 'unknown';
  const version = pythonVersion();
  const evidence = [`python package=${packageName}`, `python version=${version ?? 'missing'}`];

  if (version !== targetVersion) {
    return pending(
      'pypi-package-target',
      `PyPI package is ready to publish as ${targetVersion}`,
      evidence,
      [`Cut the Python package to ${targetVersion} before PyPI publishing`],
    );
  }

  const credentialEnv = PYPI_CREDENTIAL_ENVS.find(name => Boolean(process.env[name]));
  if (!credentialEnv) {
    return pending(
      'pypi-package-target',
      `PyPI package is ready to publish as ${targetVersion}`,
      evidence,
      [`Provide runtime PyPI publish credentials (${PYPI_CREDENTIAL_ENVS.join(', ')}) or trusted-publisher evidence before publishing`],
    );
  }

  return ok('pypi-package-target', `PyPI package is ready to publish as ${targetVersion}`, [...evidence, `credentialEnv=${credentialEnv}`]);
}

async function paperChecks() {
  const claimReport = await verifyPaperClaims();
  const publicationPackReport = await verifyPublicationPack();
  const arxivSourceReport = verifyArxivSourcePackage();
  const launchPlanReport = await verifyBrowserLaunchPlan();
  const launchResultsReport = await verifyBrowserLaunchResults();
  const bundleReport = verifyPaperSubmissionBundle();

  const failures = [
    ...claimReport.failures.map(failure => `claims: ${failure}`),
    ...publicationPackReport.failures.map(failure => `publication pack: ${failure}`),
    ...arxivSourceReport.failures.map(failure => `arXiv source: ${failure}`),
    ...launchPlanReport.failures.map(failure => `browser launch plan: ${failure}`),
    ...launchResultsReport.failures.map(failure => `browser launch results: ${failure}`),
    ...bundleReport.failures.map(failure => `paper bundle: ${failure}`),
  ];

  if (failures.length > 0) {
    return failed('paper-artifacts', 'Paper artifacts verify locally', [
      'paper:claims',
      'paper:publication-pack',
      'paper:arxiv:verify',
      'paper:launch-plan',
      'paper:launch-results',
      'paper:bundle:verify',
    ], failures);
  }
  return ok('paper-artifacts', 'Paper artifacts verify locally', [
    `${claimReport.claims.length} claim(s)`,
    `${publicationPackReport.entries.length} publication-pack entries`,
    `${arxivSourceReport.files.length} arXiv source files`,
    `${launchPlanReport.targets.length} browser launch targets`,
    `${launchResultsReport.targets.length} launch result rows, ready=${launchResultsReport.ready}`,
    `${bundleReport.files.length} bundled paper files`,
  ]);
}

async function browserPublicationCheck() {
  const report = await verifyBrowserLaunchResults();
  if (!report.ok) {
    return failed('browser-publication', 'Browser publication results are valid', [report.results], report.failures);
  }
  if (!report.ready) {
    return pending(
      'browser-publication',
      'Paper/browser launch targets are submitted',
      [`${report.targets.filter(target => target.status === 'submitted').length}/${report.targets.length} submitted`],
      report.blockers,
    );
  }
  return ok('browser-publication', 'Paper/browser launch targets are submitted', report.targets.map(target => `${target.id}: ${target.publicUrl}`));
}

function arxivCompileCheck() {
  const report = verifyArxivCompileReport({ allowPending: true });
  const evidence = [
    `report=${report.report}`,
    `status=${report.status}`,
    `compiler=${report.compiler ?? 'none'}`,
  ];
  if (report.failures.length > 0) {
    return failed('arxiv-compile', 'arXiv source has compile proof', evidence, report.failures);
  }
  if (report.blockers.length > 0) {
    return pending('arxiv-compile', 'arXiv source has compile proof', evidence, report.blockers);
  }
  return ok('arxiv-compile', 'arXiv source has compile proof', evidence);
}

async function externalEvidenceCheck() {
  const report = await verifyExternalGuardBenchEvidence({ allowPending: true, write: false });
  if (!report.ok) {
    return failed('external-evidence', 'External GuardBench evidence verifies', [report.outRoot], report.failures);
  }
  const pendingRows = report.adapters.filter(adapter => adapter.status !== 'verified');
  if (pendingRows.length > 0) {
    return pending(
      'external-evidence',
      'External Mem0/Zep GuardBench evidence is live-verified',
      report.adapters.map(adapter => `${adapter.id}: ${adapter.status}/${adapter.evidenceKind}`),
      pendingRows.map(adapter => `${adapter.id}: ${adapter.missingEnv?.length ? `missing ${adapter.missingEnv.join(', ')}` : adapter.evidenceKind}`),
    );
  }
  return ok('external-evidence', 'External Mem0/Zep GuardBench evidence is live-verified', report.adapters.map(adapter => `${adapter.id}: verified`));
}

function npmVersionMissing(result) {
  const output = `${result.stderr ?? ''}\n${result.stdout ?? ''}`;
  return /E404|404 No match found|could not be found|No match found/i.test(output);
}

export function npmPackageTargetStatus(pkg, targetVersion, run = runNpm) {
  if (pkg.version !== targetVersion) {
    return pending(
      'npm-package-target',
      `npm package is ready to publish as ${targetVersion}`,
      [`package.json version=${pkg.version}`],
      [`Cut the npm package only after version is bumped to ${targetVersion} and npm OTP/auth is available`],
    );
  }

  const evidence = [`package.json version=${pkg.version}`];
  const packageSpec = `${pkg.name}@${targetVersion}`;
  const registryStatus = run(['view', packageSpec, 'version', '--registry', NPM_REGISTRY]);
  if (registryStatus.status === 0) {
    const registryVersion = registryStatus.stdout.trim().replace(/^"|"$/g, '');
    if (registryVersion === targetVersion) {
      return ok('npm-package-target', `npm package is already published as ${targetVersion}`, [
        ...evidence,
        `registry=${packageSpec}`,
      ]);
    }
    return failed('npm-package-target', `npm package registry state is coherent for ${targetVersion}`, evidence, [
      `npm registry returned unexpected version for ${packageSpec}: ${registryVersion || 'empty'}`,
    ]);
  }

  if (!npmVersionMissing(registryStatus)) {
    return pending(
      'npm-package-target',
      `npm package is ready to publish as ${targetVersion}`,
      evidence,
      [`Verify npm registry availability before publishing (${commandSummary(registryStatus)})`],
    );
  }

  evidence.push(`registry=${packageSpec}:unpublished`);
  const authStatus = run(['whoami', '--registry', NPM_REGISTRY]);
  if (authStatus.status !== 0) {
    return pending(
      'npm-package-target',
      `npm package is ready to publish as ${targetVersion}`,
      evidence,
      [`Authenticate npm CLI for ${NPM_REGISTRY} before publishing (${commandSummary(authStatus)})`],
    );
  }

  return ok('npm-package-target', `npm package is ready to publish as ${targetVersion}`, [
    ...evidence,
    `npmUser=${authStatus.stdout.trim()}`,
  ]);
}

function packageDryRunCheck(targetVersion) {
  return npmPackageTargetStatus(readJson('package.json'), targetVersion);
}

export async function verifyReleaseReadiness(options = {}) {
  const targetVersion = options.targetVersion ?? DEFAULT_TARGET_VERSION;
  const checks = [
    versionChecks(targetVersion),
    sourceControlCheck(targetVersion),
    changelogCheck(targetVersion),
    pythonDistCheck(targetVersion),
    await paperChecks(),
    arxivCompileCheck(),
    await browserPublicationCheck(),
    await externalEvidenceCheck(),
    packageDryRunCheck(targetVersion),
    pypiPublishCheck(targetVersion),
  ];
  const failures = checks.flatMap(row => row.failures.map(failure => `${row.id}: ${failure}`));
  const blockers = checks.flatMap(row => row.blockers.map(blocker => `${row.id}: ${blocker}`));
  const ready = failures.length === 0 && blockers.length === 0;
  const okStatus = failures.length === 0 && (options.allowPending === true || blockers.length === 0);

  return {
    schemaVersion: '1.0.0',
    suite: 'Audrey 1.0 release readiness',
    generatedAt: new Date().toISOString(),
    targetVersion,
    allowPending: options.allowPending === true,
    ok: okStatus,
    ready,
    checks,
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

  const report = await verifyReleaseReadiness(args);
  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
  } else if (report.ready) {
    console.log(`Audrey ${report.targetVersion} release readiness passed.`);
  } else if (report.ok) {
    console.log(`Audrey ${report.targetVersion} release readiness has ${report.blockers.length} pending blocker(s).`);
    for (const blocker of report.blockers) console.log(`- ${blocker}`);
  } else {
    console.error(`Audrey ${report.targetVersion} release readiness failed.`);
    for (const failure of report.failures) console.error(`- ${failure}`);
    for (const blocker of report.blockers) console.error(`- ${blocker}`);
  }

  if (!report.ok) process.exit(1);
}

if (process.argv[1] && resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase()) {
  main().catch(error => {
    console.error(error.stack ?? error.message);
    process.exit(1);
  });
}
