#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = process.cwd();
const DEFAULT_REPOSITORY = 'Evilander/Audrey';
const DEFAULT_BRANCH = 'master';
const DEFAULT_VERSION = '1.0.0';
const DEFAULT_TOKEN_ENV = 'GITHUB_TOKEN';
const API_VERSION = '2022-11-28';

function parseArgs(argv = process.argv.slice(2)) {
  const args = {
    repository: DEFAULT_REPOSITORY,
    branch: DEFAULT_BRANCH,
    version: DEFAULT_VERSION,
    tokenEnv: DEFAULT_TOKEN_ENV,
    apply: false,
    json: false,
    force: false,
    concurrency: 4,
    includeEntries: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if ((token === '--repository' || token === '--repo') && argv[i + 1]) args.repository = argv[++i];
    else if (token === '--branch' && argv[i + 1]) args.branch = argv[++i];
    else if ((token === '--version' || token === '--target-version') && argv[i + 1]) args.version = argv[++i];
    else if (token === '--token-env' && argv[i + 1]) args.tokenEnv = argv[++i];
    else if (token === '--concurrency' && argv[i + 1]) args.concurrency = Number.parseInt(argv[++i], 10);
    else if (token === '--apply') args.apply = true;
    else if (token === '--json') args.json = true;
    else if (token === '--force') args.force = true;
    else if (token === '--include-entries') args.includeEntries = true;
    else if (token === '--help' || token === '-h') args.help = true;
    else throw new Error(`Unknown argument: ${token}`);
  }

  if (!Number.isInteger(args.concurrency) || args.concurrency < 1 || args.concurrency > 12) {
    throw new Error('--concurrency must be an integer between 1 and 12');
  }

  return args;
}

function usage() {
  return `Usage: node scripts/publish-release-github-api.mjs [options]

Options:
  --apply                  Create GitHub blobs/tree/commit/tag and update the branch.
  --repository <owner/repo> Repository to publish. Default: ${DEFAULT_REPOSITORY}.
  --branch <name>          Branch ref to update. Default: ${DEFAULT_BRANCH}.
  --version <version>      Release version. Default: ${DEFAULT_VERSION}.
  --token-env <name>       Environment variable containing a GitHub token. Default: ${DEFAULT_TOKEN_ENV}.
  --concurrency <n>        Concurrent blob uploads. Default: 4.
  --force                  Force branch ref update if remote branch moved.
  --include-entries        Include every changed path in the JSON report.
  --json                   Print the machine-readable report.
`;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    encoding: 'utf-8',
    timeout: options.timeout ?? 120_000,
    env: {
      ...process.env,
      ...options.env,
    },
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

function assertOk(result) {
  if (!result.ok) throw new Error(`${result.command} failed: ${result.stderr || result.stdout || result.error || result.status}`);
  return result.stdout;
}

function splitZ(output) {
  return output.split('\0').filter(Boolean);
}

function normalized(path) {
  return path.replaceAll('\\', '/');
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(resolve(ROOT, path))).digest('hex');
}

function readJsonIfExists(path) {
  const full = resolve(ROOT, path);
  return existsSync(full) ? JSON.parse(readFileSync(full, 'utf-8').replace(/^\uFEFF/, '')) : null;
}

function collectChangedPaths() {
  const changed = splitZ(assertOk(run('git', ['-c', 'core.quotepath=false', 'diff', '--name-only', '-z', 'HEAD', '--'])));
  const untracked = splitZ(assertOk(run('git', ['-c', 'core.quotepath=false', 'ls-files', '--others', '--exclude-standard', '-z'])));
  return [...new Set([...changed, ...untracked].map(normalized))].sort((a, b) => a.localeCompare(b));
}

function fileMode(path) {
  const listing = run('git', ['ls-files', '-s', '--', path]);
  if (listing.ok && listing.stdout) return listing.stdout.split(/\s+/)[0] || '100644';
  return '100644';
}

function changedEntries() {
  return collectChangedPaths().map(path => {
    const full = resolve(ROOT, path);
    if (!existsSync(full)) {
      return { path, deleted: true, mode: '100644', bytes: 0, sha256: null };
    }
    const stat = statSync(full);
    if (!stat.isFile()) throw new Error(`Changed path is not a file: ${path}`);
    return {
      path,
      deleted: false,
      mode: fileMode(path),
      bytes: stat.size,
      sha256: sha256(path),
    };
  });
}

function remoteRefs(repository, branch, version) {
  let result = run('git', ['ls-remote', `https://github.com/${repository}.git`, `refs/heads/${branch}`, `refs/tags/v${version}`], { timeout: 60_000 });
  if (!result.ok && /schannel|AcquireCredentialsHandle|SEC_E_NO_CREDENTIALS/i.test(`${result.stderr}\n${result.stdout}`)) {
    result = run('git', ['-c', 'http.sslBackend=openssl', 'ls-remote', `https://github.com/${repository}.git`, `refs/heads/${branch}`, `refs/tags/v${version}`], { timeout: 60_000 });
    result.fallback = 'openssl';
  }

  const refs = {};
  for (const line of result.stdout.split(/\r?\n/)) {
    const [sha, ref] = line.trim().split(/\s+/);
    if (sha && ref) refs[ref] = sha;
  }
  return {
    result,
    branch: refs[`refs/heads/${branch}`] ?? null,
    tag: refs[`refs/tags/v${version}`] ?? null,
  };
}

function releaseDates() {
  const headTime = Number.parseInt(assertOk(run('git', ['show', '-s', '--format=%ct', 'HEAD'])), 10);
  const commitEpoch = headTime + 1;
  return {
    commitEpoch,
    tagEpoch: commitEpoch + 1,
    commitIso: isoWithOffset(commitEpoch, -300),
    tagIso: isoWithOffset(commitEpoch + 1, -300),
  };
}

function isoWithOffset(epochSeconds, offsetMinutes) {
  const shifted = new Date((epochSeconds + offsetMinutes * 60) * 1000);
  const stamp = shifted.toISOString().replace(/\.\d{3}Z$/, '');
  const sign = offsetMinutes < 0 ? '-' : '+';
  const absolute = Math.abs(offsetMinutes);
  const hours = String(Math.floor(absolute / 60)).padStart(2, '0');
  const minutes = String(absolute % 60).padStart(2, '0');
  return `${stamp}${sign}${hours}:${minutes}`;
}

async function githubJson(token, repository, path, options = {}) {
  const response = await fetch(`https://api.github.com/repos/${repository}${path}`, {
    method: options.method ?? 'GET',
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'User-Agent': 'audrey-release-publisher',
      'X-GitHub-Api-Version': API_VERSION,
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const text = await response.text();
  const payload = text ? JSON.parse(text) : null;
  if (!response.ok) {
    const message = payload?.message ?? text.slice(0, 500) ?? response.statusText;
    throw new Error(`GitHub API ${options.method ?? 'GET'} ${path} failed (${response.status}): ${message}`);
  }
  return payload;
}

async function mapLimit(items, limit, mapper) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const index = next++;
      results[index] = await mapper(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

async function uploadBlob(token, repository, entry) {
  const content = readFileSync(resolve(ROOT, entry.path)).toString('base64');
  const blob = await githubJson(token, repository, '/git/blobs', {
    method: 'POST',
    body: {
      content,
      encoding: 'base64',
    },
  });
  return {
    path: entry.path,
    mode: entry.mode,
    type: 'blob',
    sha: blob.sha,
    bytes: entry.bytes,
    sha256: entry.sha256,
  };
}

function localState(args) {
  const localHead = assertOk(run('git', ['rev-parse', 'HEAD']));
  const localTree = assertOk(run('git', ['rev-parse', 'HEAD^{tree}']));
  const objectReport = readJsonIfExists('.tmp/release-git-object-report.json');
  const finalizeReport = readJsonIfExists('.tmp/release-artifacts/release-finalize-report.json');
  const refs = remoteRefs(args.repository, args.branch, args.version);
  const entries = changedEntries();
  const bytes = entries.reduce((total, entry) => total + entry.bytes, 0);
  const blockers = [];

  if (!refs.result.ok) blockers.push(`Remote ref check failed: ${refs.result.stderr || refs.result.stdout || refs.result.error}`);
  if (refs.branch && refs.branch !== localHead && !args.force) {
    blockers.push(`Remote ${args.branch} is ${refs.branch}, but local HEAD is ${localHead}`);
  }
  if (refs.tag) blockers.push(`Remote tag v${args.version} already exists at ${refs.tag}`);
  if (!objectReport?.commit || !objectReport?.tree) blockers.push('Missing .tmp/release-git-object-report.json; run npm run release:artifacts first');

  return {
    localHead,
    localTree,
    expectedReleaseTree: objectReport?.tree ?? null,
    expectedReleaseCommit: objectReport?.commit ?? null,
    expectedReleaseTag: objectReport?.tag ?? null,
    remoteBranch: refs.branch,
    remoteTag: refs.tag,
    remoteCheck: refs.result,
    changedFiles: entries.length,
    changedBytes: bytes,
    entries,
    finalizeArtifacts: finalizeReport?.artifacts ?? [],
    blockers,
  };
}

async function publishWithGitHubApi(args, state, token) {
  const apiCommit = await githubJson(token, args.repository, `/git/commits/${state.remoteBranch}`);
  const uploaded = await mapLimit(
    state.entries.filter(entry => !entry.deleted),
    args.concurrency,
    entry => uploadBlob(token, args.repository, entry),
  );
  const uploadedByPath = new Map(uploaded.map(entry => [entry.path, entry]));
  const tree = await githubJson(token, args.repository, '/git/trees', {
    method: 'POST',
    body: {
      base_tree: apiCommit.tree.sha,
      tree: state.entries.map(entry => {
        if (entry.deleted) return { path: entry.path, mode: entry.mode, type: 'blob', sha: null };
        const blob = uploadedByPath.get(entry.path);
        return { path: entry.path, mode: entry.mode, type: 'blob', sha: blob.sha };
      }),
    },
  });

  if (state.expectedReleaseTree && tree.sha !== state.expectedReleaseTree) {
    throw new Error(`GitHub release tree ${tree.sha} does not match local source-bundle tree ${state.expectedReleaseTree}`);
  }

  const dates = releaseDates();
  const identity = { name: 'Tyler Eveland', email: 'j.tyler.eveland@gmail.com' };
  const commit = await githubJson(token, args.repository, '/git/commits', {
    method: 'POST',
    body: {
      message: `Release Audrey ${args.version}`,
      tree: tree.sha,
      parents: [state.remoteBranch],
      author: { ...identity, date: dates.commitIso },
      committer: { ...identity, date: dates.commitIso },
    },
  });

  if (state.expectedReleaseCommit && commit.sha !== state.expectedReleaseCommit) {
    throw new Error(`GitHub release commit ${commit.sha} does not match local source-bundle commit ${state.expectedReleaseCommit}`);
  }

  const branchUpdate = await githubJson(token, args.repository, `/git/refs/heads/${args.branch}`, {
    method: 'PATCH',
    body: {
      sha: commit.sha,
      force: args.force,
    },
  });

  const tagObject = await githubJson(token, args.repository, '/git/tags', {
    method: 'POST',
    body: {
      tag: `v${args.version}`,
      message: `Audrey ${args.version}`,
      object: commit.sha,
      type: 'commit',
      tagger: { ...identity, date: dates.tagIso },
    },
  });

  const tagRef = await githubJson(token, args.repository, '/git/refs', {
    method: 'POST',
    body: {
      ref: `refs/tags/v${args.version}`,
      sha: tagObject.sha,
    },
  });

  return {
    uploadedBlobs: uploaded.length,
    tree: tree.sha,
    commit: commit.sha,
    tagObject: tagObject.sha,
    branchRef: branchUpdate.object?.sha ?? commit.sha,
    tagRef: tagRef.object?.sha ?? tagObject.sha,
  };
}

function printableReport(report, json) {
  if (json) return JSON.stringify(report, null, 2);
  const lines = [
    `Audrey GitHub API source publisher: apply=${report.apply}`,
    `repository=${report.repository}`,
    `branch=${report.branch}`,
    `changed files=${report.changedFiles}`,
    `changed bytes=${report.changedBytes}`,
    `remote branch=${report.remoteBranch ?? 'missing'}`,
    `remote tag=${report.remoteTag ?? 'missing'}`,
    `expected release commit=${report.expectedReleaseCommit ?? 'missing'}`,
  ];
  if (report.blockers.length) {
    lines.push('Blockers:');
    for (const blocker of report.blockers) lines.push(`- ${blocker}`);
  }
  if (report.publish) {
    lines.push(`published commit=${report.publish.commit}`);
    lines.push(`published tag=${report.publish.tagRef}`);
  }
  return lines.join('\n');
}

async function main() {
  const args = parseArgs();
  if (args.help) {
    console.log(usage());
    return;
  }

  const state = localState(args);
  const report = {
    schemaVersion: '1.0.0',
    suite: 'Audrey GitHub API source publication',
    generatedAt: new Date().toISOString(),
    apply: args.apply,
    repository: args.repository,
    branch: args.branch,
    version: args.version,
    tokenEnv: args.tokenEnv,
    localHead: state.localHead,
    localTree: state.localTree,
    expectedReleaseTree: state.expectedReleaseTree,
    expectedReleaseCommit: state.expectedReleaseCommit,
    expectedReleaseTag: state.expectedReleaseTag,
    remoteBranch: state.remoteBranch,
    remoteTag: state.remoteTag,
    changedFiles: state.changedFiles,
    changedBytes: state.changedBytes,
    changedEntrySample: state.entries.slice(0, 12).map(entry => ({
      path: entry.path,
      deleted: entry.deleted,
      mode: entry.mode,
      bytes: entry.bytes,
      sha256: entry.sha256,
    })),
    changedEntries: args.includeEntries
      ? state.entries.map(entry => ({
        path: entry.path,
        deleted: entry.deleted,
        mode: entry.mode,
        bytes: entry.bytes,
        sha256: entry.sha256,
      }))
      : undefined,
    finalizeArtifacts: state.finalizeArtifacts,
    blockers: [...state.blockers],
    publish: null,
  };

  if (args.apply) {
    const token = process.env[args.tokenEnv];
    if (!token) {
      report.blockers.push(`Set ${args.tokenEnv} to a GitHub token with contents:write before applying`);
    } else if (report.blockers.length === 0) {
      report.publish = await publishWithGitHubApi(args, state, token);
    }
  }

  console.log(printableReport(report, args.json));
  if (report.blockers.length) process.exit(1);
}

main().catch(error => {
  console.error(error.stack ?? error.message);
  process.exit(1);
});
