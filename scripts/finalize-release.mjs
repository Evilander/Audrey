#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_VERSION = '1.0.0';
const DEFAULT_ARTIFACT_DIR = '.tmp/release-artifacts';
const NPM_REGISTRY = 'https://registry.npmjs.org/';

function fromRoot(path) {
  return resolve(ROOT, path);
}

function readJson(path) {
  return JSON.parse(readFileSync(fromRoot(path), 'utf-8'));
}

function parseArgs(argv = process.argv.slice(2)) {
  const args = {
    version: DEFAULT_VERSION,
    artifactDir: DEFAULT_ARTIFACT_DIR,
    apply: false,
    json: false,
    commit: false,
    tag: false,
    push: false,
    pack: false,
    sourceBundle: false,
    publishNpm: false,
    publishPypi: false,
    npmOtp: null,
    commitMessage: null,
  };

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if ((token === '--version' || token === '--target-version') && argv[i + 1]) args.version = argv[++i];
    else if (token === '--artifact-dir' && argv[i + 1]) args.artifactDir = argv[++i];
    else if (token === '--commit-message' && argv[i + 1]) args.commitMessage = argv[++i];
    else if (token === '--npm-otp' && argv[i + 1]) args.npmOtp = argv[++i];
    else if (token === '--apply') args.apply = true;
    else if (token === '--json') args.json = true;
    else if (token === '--commit') args.commit = true;
    else if (token === '--tag') args.tag = true;
    else if (token === '--push') args.push = true;
    else if (token === '--pack') args.pack = true;
    else if (token === '--source-bundle') args.sourceBundle = true;
    else if (token === '--publish-npm') args.publishNpm = true;
    else if (token === '--publish-pypi') args.publishPypi = true;
    else if (token === '--all') {
      args.commit = true;
      args.tag = true;
      args.push = true;
      args.pack = true;
      args.sourceBundle = true;
      args.publishNpm = true;
      args.publishPypi = true;
    } else if (token === '--help' || token === '-h') args.help = true;
    else throw new Error(`Unknown argument: ${token}`);
  }

  return args;
}

function usage() {
  return `Usage: node scripts/finalize-release.mjs [options]

Options:
  --apply                         Execute selected release actions. Dry-run by default.
  --version <version>             Release version. Default: ${DEFAULT_VERSION}.
  --artifact-dir <path>           Local ignored artifact directory. Default: ${DEFAULT_ARTIFACT_DIR}.
  --commit                        git add + commit the release candidate.
  --tag                           Create annotated v<version> tag.
  --push                          Push HEAD and tags to origin/master.
  --pack                          Create npm tarball and artifact manifest.
  --source-bundle                 Create ignored Git bundle for external source publication.
  --publish-npm                   Publish the packaged npm tarball.
  --publish-pypi                  Upload Python wheel/sdist with twine.
  --npm-otp <code>                Optional npm one-time password.
  --commit-message <message>      Override the default release commit message.
  --all                           Commit, tag, push, pack, and publish npm/PyPI.
  --json                          Print the machine-readable plan/report.
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
    stdio: options.stdio ?? 'pipe',
    timeout: options.timeout ?? 120_000,
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: '0',
      GCM_INTERACTIVE: 'never',
      GIT_ASKPASS: '',
      SSH_ASKPASS: '',
      TWINE_NON_INTERACTIVE: '1',
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

function commandFailure(result) {
  return result.error || result.stderr || result.stdout || `exited ${result.status}`;
}

function assertOk(result) {
  if (!result.ok) throw new Error(`${result.command} failed: ${commandFailure(result)}`);
  return result;
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function listArtifacts(artifactDir, version) {
  const files = [];
  const npmTarball = join(artifactDir, `audrey-${version}.tgz`);
  const gitBundle = join(artifactDir, `audrey-${version}.git.bundle`);
  if (existsSync(npmTarball)) files.push(npmTarball);
  if (existsSync(gitBundle)) files.push(gitBundle);

  const pythonDist = fromRoot('python/dist');
  if (existsSync(pythonDist)) {
    for (const name of readdirSync(pythonDist)) {
      if (name.includes(version) && (name.endsWith('.whl') || name.endsWith('.tar.gz'))) {
        files.push(join(pythonDist, name));
      }
    }
  }

  return files.map(path => ({
    path: path.startsWith(ROOT) ? path.slice(ROOT.length + 1).replaceAll('\\', '/') : path.replaceAll('\\', '/'),
    sha256: sha256(path),
    bytes: readFileSync(path).byteLength,
  }));
}

function npmTarballPath(artifactDir, version) {
  return join(artifactDir, `audrey-${version}.tgz`);
}

function pythonArtifactPaths(version) {
  const dist = fromRoot('python/dist');
  if (!existsSync(dist)) return [];
  return readdirSync(dist)
    .filter(name => name.includes(version) && (name.endsWith('.whl') || name.endsWith('.tar.gz')))
    .map(name => join('python/dist', name));
}

function pypiCredentialEnv() {
  if (process.env.TWINE_PASSWORD) return {};
  const token = process.env.PYPI_API_TOKEN ?? process.env.UV_PUBLISH_TOKEN;
  if (!token) return null;
  return {
    TWINE_USERNAME: process.env.TWINE_USERNAME ?? '__token__',
    TWINE_PASSWORD: token,
  };
}

function selectedActions(args) {
  return [
    args.commit && 'commit',
    args.tag && 'tag',
    args.push && 'push',
    args.pack && 'pack',
    args.sourceBundle && 'source-bundle',
    args.publishNpm && 'publish-npm',
    args.publishPypi && 'publish-pypi',
  ].filter(Boolean);
}

function ensurePackageVersion(version) {
  const pkg = readJson('package.json');
  if (pkg.version !== version) {
    throw new Error(`package.json version is ${pkg.version}, expected ${version}`);
  }
  return pkg;
}

function buildPlan(args) {
  const pkg = ensurePackageVersion(args.version);
  const tagName = `v${args.version}`;
  const artifactDir = fromRoot(args.artifactDir);
  const commitMessage = args.commitMessage ?? `Release Audrey ${args.version}`;
  const actions = selectedActions(args);
  const commands = [];
  const blockers = [];

  commands.push('node scripts/verify-release-readiness.mjs --allow-pending --json');
  if (args.commit) commands.push('git add --all', `git commit -m "${commitMessage}"`);
  if (args.tag) commands.push(`git tag -a ${tagName} -m "Audrey ${args.version}"`);
  if (args.push) commands.push(`git push origin HEAD:master --follow-tags`);
  if (args.pack) commands.push(`npm pack --pack-destination ${args.artifactDir}`);
  if (args.sourceBundle) commands.push(`git bundle create ${args.artifactDir}/audrey-${args.version}.git.bundle refs/heads/master refs/tags/v${args.version}`);
  if (args.publishNpm) {
    const otp = args.npmOtp ? ' --otp <provided>' : '';
    commands.push(`npm publish ${args.artifactDir}/audrey-${args.version}.tgz --access public --registry ${NPM_REGISTRY}${otp}`);
  }
  if (args.publishPypi) commands.push(`python -m twine upload python/dist/audrey_memory-${args.version}*`);

  if (actions.length === 0) {
    blockers.push('Select at least one action such as --pack, --source-bundle, --commit, --tag, --push, --publish-npm, or --publish-pypi');
  }
  if (args.publishPypi && !pypiCredentialEnv()) {
    blockers.push('Set TWINE_PASSWORD, PYPI_API_TOKEN, or UV_PUBLISH_TOKEN before --publish-pypi');
  }

  return {
    schemaVersion: '1.0.0',
    suite: 'Audrey release finalization',
    generatedAt: new Date().toISOString(),
    apply: args.apply,
    version: args.version,
    packageName: pkg.name,
    tagName,
    artifactDir: args.artifactDir,
    actions,
    commands,
    blockers,
    results: [],
    artifacts: listArtifacts(artifactDir, args.version),
  };
}

function runReadiness(plan) {
  const readiness = run('node', ['scripts/verify-release-readiness.mjs', '--allow-pending', '--json'], { timeout: 180_000 });
  plan.results.push(readiness);
  assertOk(readiness);
  const report = JSON.parse(readiness.stdout);
  if (!report.ok) {
    throw new Error(`release readiness failed: ${report.failures?.join('; ') || 'unknown failure'}`);
  }
  plan.readiness = {
    ok: report.ok,
    ready: report.ready,
    blockers: report.blockers ?? [],
  };
}

function gitObjectEnv(timestamp) {
  const objectDir = fromRoot('.tmp/git-object-store');
  const indexFile = fromRoot('.tmp/release.index');
  return {
    GIT_OBJECT_DIRECTORY: objectDir,
    GIT_ALTERNATE_OBJECT_DIRECTORIES: fromRoot('.git/objects'),
    GIT_INDEX_FILE: indexFile,
    GIT_AUTHOR_NAME: 'Tyler Eveland',
    GIT_AUTHOR_EMAIL: 'j.tyler.eveland@gmail.com',
    GIT_COMMITTER_NAME: 'Tyler Eveland',
    GIT_COMMITTER_EMAIL: 'j.tyler.eveland@gmail.com',
    GIT_AUTHOR_DATE: `${timestamp} -0500`,
    GIT_COMMITTER_DATE: `${timestamp} -0500`,
  };
}

function createSourceBundle(args, plan) {
  const objectDir = fromRoot('.tmp/git-object-store');
  const indexFile = fromRoot('.tmp/release.index');
  const gitDir = fromRoot('.tmp/release-gitdir');
  const artifactDir = fromRoot(args.artifactDir);
  const bundlePath = join(artifactDir, `audrey-${args.version}.git.bundle`);
  const headTime = assertOk(run('git', ['show', '-s', '--format=%ct', 'HEAD'])).stdout;
  const timestamp = Number.parseInt(headTime, 10) + 1;
  const env = gitObjectEnv(timestamp);

  rmSync(objectDir, { recursive: true, force: true });
  rmSync(indexFile, { force: true });
  rmSync(gitDir, { recursive: true, force: true });
  mkdirSync(objectDir, { recursive: true });
  mkdirSync(artifactDir, { recursive: true });

  for (const result of [
    run('git', ['read-tree', 'HEAD'], { env }),
    run('git', ['add', '--all'], { env }),
  ]) {
    plan.results.push(result);
    assertOk(result);
  }

  const tree = assertOk(run('git', ['write-tree'], { env })).stdout;
  const commit = assertOk(run('git', ['commit-tree', tree, '-p', 'HEAD', '-m', args.commitMessage ?? `Release Audrey ${args.version}`], { env })).stdout;
  const tagContent = [
    `object ${commit}`,
    'type commit',
    `tag v${args.version}`,
    `tagger Tyler Eveland <j.tyler.eveland@gmail.com> ${timestamp + 1} -0500`,
    '',
    `Audrey ${args.version}`,
    '',
  ].join('\n');
  const tagFile = fromRoot('.tmp/release-tag.txt');
  writeFileSync(tagFile, tagContent, 'utf-8');
  const tag = assertOk(run('git', ['hash-object', '-t', 'tag', '-w', tagFile], { env })).stdout;

  mkdirSync(join(gitDir, 'refs', 'heads'), { recursive: true });
  mkdirSync(join(gitDir, 'refs', 'tags'), { recursive: true });
  writeFileSync(join(gitDir, 'HEAD'), 'ref: refs/heads/master\n', 'utf-8');
  writeFileSync(join(gitDir, 'config'), '[core]\n\trepositoryformatversion = 0\n\tfilemode = false\n\tbare = true\n', 'utf-8');
  writeFileSync(join(gitDir, 'refs', 'heads', 'master'), `${commit}\n`, 'utf-8');
  writeFileSync(join(gitDir, 'refs', 'tags', `v${args.version}`), `${tag}\n`, 'utf-8');

  const bundle = run('git', ['--git-dir', gitDir, 'bundle', 'create', bundlePath, 'refs/heads/master', `refs/tags/v${args.version}`], {
    env: {
      GIT_OBJECT_DIRECTORY: objectDir,
      GIT_ALTERNATE_OBJECT_DIRECTORIES: fromRoot('.git/objects'),
    },
    timeout: 180_000,
  });
  plan.results.push(bundle);
  assertOk(bundle);

  const verify = run('git', ['bundle', 'verify', bundlePath], { timeout: 60_000 });
  plan.results.push(verify);
  assertOk(verify);

  const objectReport = {
    tree,
    commit,
    tag,
    objectDir: '.tmp/git-object-store',
    indexFile: '.tmp/release.index',
    bundle: args.artifactDir.replaceAll('\\', '/') + `/audrey-${args.version}.git.bundle`,
  };
  writeFileSync(fromRoot('.tmp/release-git-object-report.json'), `${JSON.stringify(objectReport, null, 2)}\n`, 'utf-8');
  plan.sourceControl = objectReport;
}

function execute(args, plan) {
  const artifactDir = fromRoot(args.artifactDir);
  mkdirSync(artifactDir, { recursive: true });
  runReadiness(plan);

  if (args.commit) {
    assertOk(run('git', ['add', '--all']));
    const commitMessage = args.commitMessage ?? `Release Audrey ${args.version}`;
    const commit = run('git', ['commit', '-m', commitMessage]);
    plan.results.push(commit);
    assertOk(commit);
  }

  if (args.tag) {
    const tag = run('git', ['tag', '-a', `v${args.version}`, '-m', `Audrey ${args.version}`]);
    plan.results.push(tag);
    assertOk(tag);
  }

  if (args.push) {
    const push = run('git', [
      '-c',
      'http.sslBackend=openssl',
      '-c',
      'credential.helper=',
      '-c',
      'core.askPass=',
      'push',
      'origin',
      'HEAD:master',
      '--follow-tags',
    ], { timeout: 45_000 });
    plan.results.push(push);
    assertOk(push);
  }

  if (args.pack || args.publishNpm) {
    const pack = run('npm', ['pack', '--pack-destination', args.artifactDir], { timeout: 180_000 });
    plan.results.push(pack);
    assertOk(pack);
  }

  if (args.sourceBundle) {
    createSourceBundle(args, plan);
  }

  if (args.publishNpm) {
    const whoami = run('npm', ['whoami', '--registry', NPM_REGISTRY]);
    plan.results.push(whoami);
    assertOk(whoami);
    const publishArgs = ['publish', npmTarballPath(args.artifactDir, args.version), '--access', 'public', '--registry', NPM_REGISTRY];
    if (args.npmOtp) publishArgs.push('--otp', args.npmOtp);
    const publish = run('npm', publishArgs, { timeout: 180_000 });
    plan.results.push(publish);
    assertOk(publish);
  }

  if (args.publishPypi) {
    const uploadEnv = pypiCredentialEnv();
    if (!uploadEnv) throw new Error('Missing PyPI credentials: set TWINE_PASSWORD, PYPI_API_TOKEN, or UV_PUBLISH_TOKEN');
    const build = run('npm', ['run', 'python:release:check'], { timeout: 180_000 });
    plan.results.push(build);
    assertOk(build);
    const artifacts = pythonArtifactPaths(args.version);
    if (artifacts.length === 0) throw new Error(`No Python artifacts found for ${args.version}`);
    const upload = run('python', ['-m', 'twine', 'upload', ...artifacts], { timeout: 180_000, env: uploadEnv });
    plan.results.push(upload);
    assertOk(upload);
  }

  plan.artifacts = listArtifacts(artifactDir, args.version);
  writeFileSync(join(artifactDir, 'release-finalize-report.json'), `${JSON.stringify(plan, null, 2)}\n`, 'utf-8');
}

function printPlan(plan, json) {
  if (json) {
    console.log(JSON.stringify(plan, null, 2));
    return;
  }

  console.log(`${plan.apply ? 'Ran' : 'Planned'} Audrey ${plan.version} release finalization`);
  console.log(`Actions: ${plan.actions.length ? plan.actions.join(', ') : 'none selected'}`);
  for (const command of plan.commands) console.log(`- ${command}`);
  if (plan.blockers.length) {
    console.log('Blockers:');
    for (const blocker of plan.blockers) console.log(`- ${blocker}`);
  }
  if (plan.artifacts.length) {
    console.log('Artifacts:');
    for (const artifact of plan.artifacts) console.log(`- ${artifact.path} sha256=${artifact.sha256}`);
  }
}

async function main() {
  const args = parseArgs();
  if (args.help) {
    console.log(usage());
    return;
  }

  const plan = buildPlan(args);
  if (args.apply && plan.blockers.length === 0) execute(args, plan);
  printPlan(plan, args.json);
  if (plan.blockers.length) process.exit(1);
}

main().catch(error => {
  console.error(error.message);
  process.exit(1);
});
