#!/usr/bin/env node

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = process.cwd();
const DEFAULT_VERSION = '1.0.0';
const DEFAULT_BUNDLE = '.tmp/release-artifacts/audrey-1.0.0.git.bundle';
const DEFAULT_REMOTE = 'https://github.com/Evilander/Audrey.git';

function parseArgs(argv = process.argv.slice(2)) {
  const args = {
    version: DEFAULT_VERSION,
    bundle: DEFAULT_BUNDLE,
    remote: DEFAULT_REMOTE,
    apply: false,
    json: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if ((token === '--version' || token === '--target-version') && argv[i + 1]) args.version = argv[++i];
    else if (token === '--bundle' && argv[i + 1]) args.bundle = argv[++i];
    else if (token === '--remote' && argv[i + 1]) args.remote = argv[++i];
    else if (token === '--apply') args.apply = true;
    else if (token === '--json') args.json = true;
    else if (token === '--help' || token === '-h') args.help = true;
    else throw new Error(`Unknown argument: ${token}`);
  }

  return args;
}

function usage() {
  return `Usage: node scripts/publish-release-bundle.mjs [options]

Options:
  --bundle <path>     Release Git bundle. Default: ${DEFAULT_BUNDLE}.
  --remote <url>      Push remote. Default: ${DEFAULT_REMOTE}.
  --version <version> Release version. Default: ${DEFAULT_VERSION}.
  --apply             Actually push master and v<version>. Dry-run by default.
  --json              Print the machine-readable report.
`;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? ROOT,
    encoding: 'utf-8',
    timeout: options.timeout ?? 120_000,
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: '0',
      GCM_INTERACTIVE: 'never',
      GIT_ASKPASS: '',
      SSH_ASKPASS: '',
      ...options.env,
    },
  });
  return {
    command: [command, ...args].join(' '),
    ok: result.status === 0,
    status: result.status,
    signal: result.signal ?? null,
    stdout: result.stdout?.trim() ?? '',
    stderr: result.stderr?.trim() ?? '',
    error: result.error?.message ?? null,
  };
}

function firstLine(result) {
  return `${result.stderr}\n${result.stdout}`.split(/\r?\n/).map(line => line.trim()).find(Boolean) ?? '';
}

function parseBundleRefs(output, version) {
  const refs = {};
  for (const line of output.split(/\r?\n/)) {
    const match = line.match(/^([0-9a-f]{40})\s+(refs\/(?:heads\/master|tags\/v[^\s]+))$/);
    if (!match) continue;
    refs[match[2]] = match[1];
  }
  return {
    master: refs['refs/heads/master'] ?? null,
    tag: refs[`refs/tags/v${version}`] ?? null,
  };
}

function parseRemoteRefs(output, version) {
  const refs = {};
  for (const line of output.split(/\r?\n/)) {
    const [sha, ref] = line.trim().split(/\s+/);
    if (sha && ref) refs[ref] = sha;
  }
  return {
    master: refs['refs/heads/master'] ?? null,
    tag: refs[`refs/tags/v${version}`] ?? refs[`refs/tags/v${version}^{}`] ?? null,
  };
}

function remoteHead(args) {
  let result = run('git', ['ls-remote', args.remote, 'refs/heads/master', `refs/tags/v${args.version}`], { timeout: 60_000 });
  if (!result.ok && /schannel|AcquireCredentialsHandle|SEC_E_NO_CREDENTIALS/i.test(firstLine(result))) {
    result = run('git', ['-c', 'http.sslBackend=openssl', 'ls-remote', args.remote, 'refs/heads/master', `refs/tags/v${args.version}`], { timeout: 60_000 });
    result.fallback = 'openssl';
  }
  return result;
}

function publishFromBundle(args, refs) {
  const temp = mkdtempSync(join(tmpdir(), 'audrey-release-push-'));
  try {
    const clone = run('git', ['clone', '--bare', resolve(ROOT, args.bundle), temp], { timeout: 120_000 });
    if (!clone.ok) return [clone];
    const push = run('git', [
      '-c',
      'http.sslBackend=openssl',
      '-c',
      'credential.helper=',
      '-c',
      'core.askPass=',
      'push',
      args.remote,
      `${refs.master}:refs/heads/master`,
      `${refs.tag}:refs/tags/v${args.version}`,
    ], { cwd: temp, timeout: 45_000 });
    return [clone, push];
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

export function planPublish(args) {
  const verify = run('git', ['bundle', 'verify', args.bundle], { timeout: 60_000 });
  const remote = remoteHead(args);
  const bundleRefs = verify.ok ? parseBundleRefs(verify.stdout, args.version) : { master: null, tag: null };
  const remoteRefs = remote.ok ? parseRemoteRefs(remote.stdout, args.version) : { master: null, tag: null };
  const blockers = [];

  if (!verify.ok) blockers.push(`Bundle verification failed: ${firstLine(verify)}`);
  if (!bundleRefs.master) blockers.push('Bundle is missing refs/heads/master');
  if (!bundleRefs.tag) blockers.push(`Bundle is missing refs/tags/v${args.version}`);
  if (!remote.ok) blockers.push(`Remote check failed: ${firstLine(remote)}`);
  if (remoteRefs.tag && remoteRefs.tag !== bundleRefs.tag) blockers.push(`Remote v${args.version} already points at ${remoteRefs.tag}`);
  if (remoteRefs.master === bundleRefs.master && remoteRefs.tag === bundleRefs.tag) blockers.push('Remote already matches the release bundle');

  return {
    schemaVersion: '1.0.0',
    suite: 'Audrey release source publication',
    generatedAt: new Date().toISOString(),
    apply: args.apply,
    version: args.version,
    bundle: args.bundle,
    remote: args.remote,
    bundleRefs,
    remoteRefs,
    checks: {
      bundleVerify: verify,
      remote,
    },
    blockers,
    publishResults: [],
  };
}

async function main() {
  const args = parseArgs();
  if (args.help) {
    console.log(usage());
    return;
  }

  const report = planPublish(args);
  if (args.apply && report.blockers.length === 0) {
    report.publishResults = publishFromBundle(args, report.bundleRefs);
    for (const result of report.publishResults) {
      if (!result.ok) report.blockers.push(`${result.command} failed: ${firstLine(result)}`);
    }
  }

  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`Audrey source publication plan: apply=${report.apply}`);
    console.log(`bundle master=${report.bundleRefs.master ?? 'missing'}`);
    console.log(`bundle tag=${report.bundleRefs.tag ?? 'missing'}`);
    console.log(`remote master=${report.remoteRefs.master ?? 'missing'}`);
    console.log(`remote tag=${report.remoteRefs.tag ?? 'missing'}`);
    if (report.blockers.length) {
      console.log('Blockers:');
      for (const blocker of report.blockers) console.log(`- ${blocker}`);
    }
  }

  if (report.blockers.length) process.exit(1);
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
