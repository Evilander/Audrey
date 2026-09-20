import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  symlinkSync,
  unlinkSync,
  rmSync,
  chmodSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import {
  Audrey,
  LocalEmbeddingProvider,
  reembedAll,
  addCausalLink,
  runAutopilotHook,
  createApp,
} from '../dist/src/index.js';
import { profileShellCommand } from '../dist/src/shell-command.js';
import { createContradiction } from '../dist/src/validate.js';
import { checkoutRoot, projectNamespace } from '../dist/src/project.js';
import { renderClaudeRule } from '../dist/src/rules-compiler.js';

let root;
let stores;
const initialCwd = process.cwd();
const moduleUrl = pathToFileURL(resolve('dist/src/audrey.js')).href;
const cliPath = resolve('dist/mcp-server/index.js');
const encode = (a, content, extra = {}) =>
  a.encode({ content, source: 'told-by-user', salience: 1, waitForConsolidation: true, ...extra });
const hook = (a, event, input = {}, options = {}) =>
  runAutopilotHook(
    a,
    {
      hook_event_name: event,
      cwd: root,
      session_id: 'regression',
      ...input,
    },
    { host: 'claude-code', ...options },
  );
const decision = result => result.output.hookSpecificOutput?.permissionDecision;

function store(name = `store-${stores.length}`, extra = {}) {
  const a = new Audrey({
    dataDir: join(root, name),
    agent: 'review',
    embedding: { provider: 'mock', dimensions: 8 },
    interference: { enabled: false },
    ...extra,
  });
  stores.push(a);
  return a;
}

function project(name, scripts = { build: 'echo build', test: 'echo test' }) {
  const path = join(root, name);
  mkdirSync(join(path, 'src'), { recursive: true });
  mkdirSync(join(path, '.git'));
  writeFileSync(join(path, 'package.json'), JSON.stringify({ scripts }));
  writeFileSync(join(path, 'src/check.ts'), '// fixture');
  return path;
}

function seedProcedure(a, id = 'procedure') {
  a.db
    .prepare(
      "INSERT INTO procedures(id,content,agent,state,success_count,failure_count,created_at,evidence_episode_ids) VALUES(?,?,?,'active',4,0,?,'[]')",
    )
    .run(id, 'Run the project checks before release.', a.agent, new Date().toISOString());
}

beforeEach(() => {
  root = mkdtempSync(join(process.platform === 'linux' ? '/tmp' : tmpdir(), 'audrey-regression-'));
  stores = [];
});
afterEach(async () => {
  process.chdir(initialCwd);
  vi.unstubAllEnvs();
  for (const a of stores) await a.closeAsync();
  rmSync(root, { recursive: true, force: true });
});

describe('Guard action boundaries', () => {
  it('guards Git program options and npm lifecycle scripts even during a dry run', async () => {
    const marker = join(root, 'git-marker');
    const command = "git ls-remote --upload-pack='node git-marker.cjs' .";
    expect(profileShellCommand(command).readOnly).toBe(false);
    expect(profileShellCommand('git ls-remote --upload-pa=fixture .').readOnly).toBe(false);
    expect(profileShellCommand('git diff --ext-diff').readOnly).toBe(false);
    execFileSync('git', ['init', '-q'], { cwd: root });
    writeFileSync(
      join(root, 'git-marker.cjs'),
      "require('fs').writeFileSync('git-marker', 'fixture')",
    );
    try {
      execFileSync('git', ['ls-remote', '--upload-pack=node git-marker.cjs', '.'], {
        cwd: root,
        stdio: 'pipe',
      });
    } catch {
      /* The marker command is not an upload-pack protocol server. */
    }
    expect(existsSync(marker)).toBe(true);
    writeFileSync(
      join(root, 'prepack.cjs'),
      "require('fs').writeFileSync('npm-marker', 'fixture')",
    );
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({
        name: 'audrey-lifecycle-fixture',
        version: '1.0.0',
        scripts: { prepack: 'node prepack.cjs' },
      }),
    );
    execFileSync(
      process.platform === 'win32' ? 'npm.cmd' : 'npm',
      ['pack', '--dry-run', '--ignore-scripts=false'],
      { cwd: root, stdio: 'pipe', shell: process.platform === 'win32' },
    );
    expect(existsSync(join(root, 'npm-marker'))).toBe(true);
    expect(profileShellCommand('npm pack --dry-run').readOnly).toBe(false);
    expect(profileShellCommand('ss -K dst 192.0.2.1').readOnly).toBe(false);
    expect(profileShellCommand('ss --kill').readOnly).toBe(false);
    expect(profileShellCommand('ss -lnt').readOnly).toBe(true);
    const a = store();
    await hook(a, 'PreToolUse', { tool_name: 'Bash', tool_input: { command } });
    expect(
      a.db.prepare("SELECT COUNT(*) AS n FROM memory_events WHERE event_type='PreToolUse'").get().n,
    ).toBe(1);
  });

  it('blocks the same failed command despite description and property-order changes', async () => {
    const a = store();
    const input = {
      tool_name: 'Bash',
      tool_use_id: 'first',
      tool_input: {
        command: 'npm run deploy',
        timeout: 1000,
        description: 'Deploy the application',
      },
    };
    await hook(a, 'PreToolUse', input);
    await hook(a, 'PostToolUseFailure', {
      ...input,
      error: 'Deployment failed',
      tool_response: { exit_code: 1, stderr: 'Deployment failed' },
    });
    const retry = await hook(a, 'PreToolUse', {
      ...input,
      tool_use_id: 'retry',
      tool_input: { description: 'Retry deployment', timeout: 1000, command: 'npm run deploy' },
    });
    expect(decision(retry)).toBe('deny');
    const changed = await hook(a, 'PreToolUse', {
      ...input,
      tool_use_id: 'changed',
      tool_input: { command: 'npm run another-task', timeout: 1000 },
    });
    expect(decision(changed)).not.toBe('deny');
  });

  it('excludes foreign rules before deciding, including rules only found by the fallback sweep', async () => {
    const a = store(),
      pa = project('a'),
      pb = project('b');
    await encode(a, 'The build pipeline is probably configured for deployment.', {
      source: 'inference',
      salience: 0.1,
      context: { cwd: pa },
    });
    const input = { cwd: pa, tool_name: 'Bash', tool_input: { command: 'npm run build' } };
    const before = await hook(a, 'PreToolUse', input);
    const foreign = await encode(a, 'Never run npm run deploy before approval in project B.', {
      tags: ['must-follow'],
      context: { cwd: pb, audrey_trust: 'user-verified' },
    });
    const after = await hook(a, 'PreToolUse', input);
    expect(decision(after)).toBe(decision(before));
    expect(decision(after)).not.toBe('deny');
    const fallback = await a.preflight('npm run build', {
      tool: 'Bash',
      cwd: pa,
      strict: true,
      projectNamespace: projectNamespace(pa),
      budgetChars: 0,
    });
    expect(fallback.warnings.some(w => w.evidence_id === foreign)).toBe(false);
  });

  it('does not restore a broken must-follow rule through tagged recall', async () => {
    const a = store(),
      cwd = project('grounding');
    const id = await encode(a, 'Before deployment, run npm run build.', {
      tags: ['must-follow'],
      context: { cwd, audrey_trust: 'user-verified' },
    });
    writeFileSync(join(cwd, 'package.json'), JSON.stringify({ scripts: { test: 'echo test' } }));
    expect(a.ground({ projectRoot: cwd }).broken).toBe(1);
    const result = await a.beforeAction('npm run deploy', { tool: 'Bash', cwd, strict: true });
    expect(result.warnings.some(w => w.evidence_id === id && w.type === 'must_follow')).toBe(false);
  });
});

describe('privacy and local deployment', () => {
  it('redacts reflection before both provider completion and legacy chat', async () => {
    const a = store(),
      secret = 'sk-ant-abcdefghij1234567890';
    for (const method of ['complete', 'chat']) {
      let sent;
      a.llmProvider = {
        [method]: async prompt => {
          sent = JSON.stringify(prompt);
          return method === 'complete' ? { content: '{"memories":[]}' } : '{"memories":[]}';
        },
      };
      await a.reflect([{ role: 'user', content: `My token is ${secret}` }]);
      expect(sent).not.toContain(secret);
      expect(sent).toContain('[REDACTED:');
    }
  });

  it('redacts tags and causal text in storage, FTS, background work and encode events', async () => {
    const a = store(),
      secret = 'sk-ant-abcdefghij1234567890';
    const events = [];
    a.on('encode', event => events.push(event));
    const id = await encode(a, 'ordinary content', {
      tags: [secret],
      causal: { trigger: secret, consequence: secret },
    });
    const row = a.db
      .prepare('SELECT tags, causal_trigger, causal_consequence FROM episodes WHERE id=?')
      .get(id);
    const fts = a.db.prepare('SELECT * FROM fts_episodes WHERE id=?').get(id);
    expect(JSON.stringify([row, fts, events])).not.toContain(secret);
    expect(row.tags).toContain('[REDACTED:');
  });

  it.skipIf(process.platform === 'win32')(
    'creates private files under umask 022 and repairs existing file permissions',
    async () => {
      const data = join(root, 'private');
      const script = `process.umask(0o022); const {Audrey}=await import(${JSON.stringify(moduleUrl)}); const a=new Audrey({dataDir:${JSON.stringify(data)}}); await a.encode({content:'private fixture',source:'told-by-user',waitForConsolidation:true}); const {statSync}=await import('node:fs'); console.log(JSON.stringify(['','/audrey.db','/audrey.db-wal','/audrey.db-shm'].map(s=>statSync(${JSON.stringify(data)}+s).mode&0o777))); await a.closeAsync();`;
      const modes = JSON.parse(
        execFileSync(process.execPath, ['--input-type=module', '-e', script], {
          encoding: 'utf8',
          env: { ...process.env, NODE_NO_WARNINGS: '1' },
        }),
      );
      expect(modes).toEqual([0o700, 0o600, 0o600, 0o600]);
      chmodSync(join(data, 'audrey.db'), 0o644);
      const a = store('private');
      expect(statSync(join(data, 'audrey.db')).mode & 0o777).toBe(0o600);
      await a.closeAsync();
      chmodSync(join(data, 'audrey.db'), 0o660);
      store('private', { sharedStore: true });
      expect(statSync(join(data, 'audrey.db')).mode & 0o777).toBe(0o660);
    },
  );

  it('recovers from a transient model initialization failure and uses a per-user cache', async () => {
    vi.stubEnv('XDG_CACHE_HOME', join(root, 'cache'));
    vi.stubEnv('AUDREY_MODEL_CACHE_DIR', '');
    const factory = vi
      .fn()
      .mockRejectedValueOnce(new Error('interrupted'))
      .mockRejectedValueOnce(new Error('interrupted'))
      .mockResolvedValue(async () => ({ data: new Float32Array(384).fill(0.5) }));
    const provider = new LocalEmbeddingProvider({ pipelineFactory: factory });
    await expect(provider.embed('first')).rejects.toThrow('interrupted');
    const [one, two] = await Promise.all([provider.embed('second'), provider.embed('third')]);
    expect(one).toHaveLength(384);
    expect(two).toHaveLength(384);
    expect(factory).toHaveBeenCalledTimes(3);
    expect(factory.mock.calls[2][2].cache_dir).toBe(join(root, 'cache', 'audrey', 'models'));
  });

  it('rejects cross-origin, rebound-host and non-JSON sidecar writes', async () => {
    const app = createApp(store());
    const body = JSON.stringify({ content: 'fixture', source: 'inference' });
    expect(
      (
        await app.request('/v1/encode', {
          method: 'POST',
          headers: { 'Content-Type': 'text/plain', Origin: 'https://foreign.example' },
          body,
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await app.request('http://foreign.example/v1/encode', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body,
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await app.request('/v1/encode', {
          method: 'POST',
          headers: { 'Content-Type': 'text/plain' },
          body,
        })
      ).status,
    ).toBe(415);
    expect(
      (
        await app.request('/v1/encode', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body,
        })
      ).status,
    ).toBe(200);
  });
});

describe('database lifecycle', () => {
  it.each(['fresh', 'upgrade'])(
    'serializes six simultaneous %s opens',
    async kind => {
      const data = join(root, 'concurrent');
      if (kind === 'upgrade') {
        const a = store('concurrent');
        a.db.exec(
          'DROP INDEX idx_memory_anchors_checked; ALTER TABLE memory_anchors DROP COLUMN last_checked_at; ALTER TABLE consolidation_runs DROP COLUMN rollback_data;',
        );
        a.db.prepare("UPDATE audrey_config SET value='16' WHERE key='schema_version'").run();
        await a.closeAsync();
      }
      const script = `import {Audrey} from ${JSON.stringify(moduleUrl)}; process.on('message',async()=>{try{const a=new Audrey({dataDir:${JSON.stringify(data)},embedding:{provider:'mock',dimensions:8}}); await a.closeAsync(); process.disconnect();}catch(e){console.error(e);process.exit(1);}});process.send('ready');`;
      const children = Array.from({ length: 6 }, () => {
        const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
          stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
          env: { ...process.env, NODE_NO_WARNINGS: '1' },
        });
        let stderr = '';
        child.stderr.on('data', data => {
          stderr += data;
        });
        const ready = new Promise((resolve, reject) => {
          child.once('message', resolve);
          child.once('error', reject);
          child.once('exit', code => {
            if (code) reject(new Error(stderr));
          });
        });
        const done = new Promise((resolve, reject) => {
          child.once('error', reject);
          child.once('exit', code => resolve({ code, stderr }));
        });
        return { child, ready, done };
      });
      try {
        await Promise.all(children.map(c => c.ready));
        for (const { child } of children) child.send('go');
        expect(await Promise.all(children.map(c => c.done))).toEqual(
          Array.from({ length: 6 }, () => ({ code: 0, stderr: '' })),
        );
      } finally {
        for (const { child } of children) if (child.exitCode === null) child.kill();
      }
    },
    30_000,
  );

  it.each(['semantic', 'procedural'])(
    'rolls back only a %s merge and restores episode index flags',
    async type => {
      const a = store();
      const options = {
        minClusterSize: 3,
        similarityThreshold: 0.99,
        extractPrinciple: () => ({ content: 'Review fixed principle', type }),
      };
      const batch = async () => {
        for (let i = 0; i < 3; i++) await encode(a, 'same evidence');
      };
      await batch();
      const first = await a.consolidate(options);
      const table = type === 'semantic' ? 'semantics' : 'procedures';
      const before = a.db.prepare(`SELECT * FROM ${table}`).get();
      await batch();
      const second = await a.consolidate(options);
      const target = store('restored');
      await target.import(a.export());
      target.rollback(second.runId);
      const after = target.db.prepare(`SELECT * FROM ${table}`).get();
      expect(after.state).toBe('active');
      expect(after.evidence_episode_ids).toBe(before.evidence_episode_ids);
      if (type === 'semantic') expect(after.evidence_count).toBe(before.evidence_count);
      else expect(after.success_count).toBe(before.success_count);
      const mismatches = target.db
        .prepare(
          'SELECT e.id FROM episodes e JOIN vec_episodes v ON e.id=v.id WHERE e.consolidated != v.consolidated',
        )
        .all();
      expect(mismatches).toEqual([]);
      target.rollback(first.runId);
      expect((await target.consolidate(options)).clustersFound).toBeGreaterThan(0);
    },
  );

  it.each([false, true])(
    'purges superseded history without breaking the replacement (bulk=%s)',
    async bulk => {
      const a = store();
      const old = await encode(a, 'old requirement');
      const replacement = await encode(a, 'new requirement', { supersedes: old });
      if (bulk) a.purge();
      else a.forget(old, { purge: true });
      expect(a.db.prepare('SELECT id FROM episodes WHERE id=?').get(old)).toBeUndefined();
      expect(
        a.db.prepare('SELECT supersedes FROM episodes WHERE id=?').get(replacement).supersedes,
      ).toBeNull();
    },
  );

  it('erases free-text graph explanations incident to a purged memory', async () => {
    const a = store(),
      secret = 'Synthetic confidential codename blue-orchid-fixture';
    const id = await encode(a, secret),
      other = await encode(a, 'related observation');
    addCausalLink(a.db, { causeId: id, effectId: other, mechanism: secret, confidence: 0.9 });
    createContradiction(a.db, id, 'episodic', other, 'episodic', { explanation: secret });
    a.forget(id, { purge: true });
    expect(JSON.stringify(a.export())).not.toContain(secret);
    expect(a.db.prepare('SELECT * FROM causal_links').all()).toEqual([]);
    expect(a.db.prepare('SELECT * FROM contradictions').all()).toEqual([]);
  });

  it('does not reinsert a vector after concurrent purge or overwrite current liveness', async () => {
    const a = store();
    const deleted = await encode(a, 'removed during migration');
    const forgotten = await encode(a, 'forgotten during migration');
    let entered, resume;
    const arrived = new Promise(resolve => {
      entered = resolve;
    });
    const gate = new Promise(resolve => {
      resume = resolve;
    });
    const original = a.embeddingProvider.embedBatch.bind(a.embeddingProvider);
    a.embeddingProvider.embedBatch = async texts => {
      entered();
      await gate;
      return original(texts);
    };
    const migrating = reembedAll(a.db, a.embeddingProvider);
    await arrived;
    a.forget(deleted, { purge: true });
    a.forget(forgotten);
    resume();
    await migrating;
    expect(a.db.prepare('SELECT id FROM vec_episodes').all()).toEqual([]);
    expect(a.memoryStatus().healthy).toBe(true);
  });

  it('preserves the old index when an explicit re-embedding fails', async () => {
    const a = store(),
      id = await encode(a, 'retained vector');
    a.embeddingProvider.embedBatch = async () => {
      throw new Error('offline');
    };
    await expect(reembedAll(a.db, a.embeddingProvider, { dropAndRecreate: true })).rejects.toThrow(
      'offline',
    );
    expect(a.db.prepare('SELECT id FROM vec_episodes').all()).toEqual([{ id }]);
  });
});

describe('grounding and session changes', () => {
  it('grounds every memory owner during the dream CLI sweep', async () => {
    const a = store('dream-store', { embedding: { provider: 'mock', dimensions: 64 } });
    const cwd = project('dream-project');
    await encode(a, 'See src/check.ts.', { agent: 'alice', context: { cwd } });
    await encode(a, 'See src/check.ts.', { agent: 'bob', context: { cwd } });
    unlinkSync(join(cwd, 'src/check.ts'));
    await a.closeAsync();
    const output = execFileSync(process.execPath, [cliPath, 'dream'], {
      cwd,
      encoding: 'utf8',
      env: {
        ...process.env,
        AUDREY_DATA_DIR: join(root, 'dream-store'),
        AUDREY_EMBEDDING_PROVIDER: 'mock',
        AUDREY_LLM_PROVIDER: 'mock',
      },
    });
    expect(output).toContain('Grounding: checked 2 anchors, 2 broken');
    const reopened = store('dream-store', { embedding: { provider: 'mock', dimensions: 64 } });
    expect(
      reopened.db.prepare('SELECT agent,state FROM memory_anchors ORDER BY agent').all(),
    ).toEqual([
      { agent: 'alice', state: 'broken' },
      { agent: 'bob', state: 'broken' },
    ]);
  });

  it('detects removal of the last script and retains broken anchors in a snapshot', async () => {
    const a = store(),
      cwd = project('scripts', { build: 'echo build' });
    const id = await encode(a, 'Run npm run build.', { context: { cwd } });
    writeFileSync(join(cwd, 'package.json'), JSON.stringify({ scripts: {} }));
    expect(a.ground({ projectRoot: cwd }).broken).toBe(1);
    const snapshot = a.export();
    expect(snapshot.formatVersion).toBe(2);
    const b = store('restored');
    await b.import(snapshot);
    expect(b.db.prepare('SELECT memory_id,state FROM memory_anchors').all()).toEqual([
      { memory_id: id, state: 'broken' },
    ]);
    const unsafe = structuredClone(snapshot);
    unsafe.memoryAnchors[0].value = '../../outside';
    unsafe.memoryAnchors[0].kind = 'path';
    const c = store('unsafe');
    await expect(c.import(unsafe)).rejects.toThrow();
    expect(c.db.prepare('SELECT id FROM episodes').all()).toEqual([]);
  });

  it('assigns anchors to the per-call agent and repairs old anchor owners on upgrade', async () => {
    const a = store(),
      cwd = project('ownership');
    const id = await encode(a, 'See src/check.ts.', { agent: 'other', context: { cwd } });
    expect(a.db.prepare('SELECT agent FROM memory_anchors WHERE memory_id=?').get(id).agent).toBe(
      'other',
    );
    unlinkSync(join(cwd, 'src/check.ts'));
    expect(a.ground({ agent: 'other', projectRoot: cwd }).broken).toBe(1);
    a.db.prepare("UPDATE memory_anchors SET agent='review' WHERE memory_id=?").run(id);
    a.db.prepare("UPDATE audrey_config SET value='16' WHERE key='schema_version'").run();
    await a.closeAsync();
    const reopened = store('store-0');
    expect(
      reopened.db.prepare('SELECT agent FROM memory_anchors WHERE memory_id=?').get(id).agent,
    ).toBe('other');
  });

  it('sweeps each project independently during the same interval', async () => {
    const a = store(),
      pa = project('a'),
      pb = project('b');
    for (const cwd of [pa, pb]) await encode(a, 'See src/check.ts.', { context: { cwd } });
    unlinkSync(join(pb, 'src/check.ts'));
    const now = new Date();
    await hook(a, 'Stop', { cwd: pa }, { now });
    await hook(a, 'Stop', { cwd: pb }, { now });
    expect(
      a.db.prepare('SELECT state FROM memory_anchors WHERE project_root=?').get(pb).state,
    ).toBe('broken');
  });

  it('verifies the checkout where a memory was learned, while sharing repository identity', async () => {
    const a = store(),
      main = project('main'),
      branch = join(root, 'branch');
    const git = args => execFileSync('git', args, { cwd: main, stdio: 'pipe' });
    git(['init', '-q']);
    git(['add', '.']);
    git([
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@localhost',
      'commit',
      '-qm',
      'fixture',
    ]);
    git(['worktree', 'add', '-qb', 'fixture-branch', branch]);
    expect(projectNamespace(main)).toBe(projectNamespace(branch));
    const id = await encode(a, 'Run npm run build.', { context: { cwd: branch } });
    writeFileSync(join(branch, 'package.json'), JSON.stringify({ scripts: { test: 'echo test' } }));
    expect(a.ground({ projectRoot: checkoutRoot(branch) }).broken).toBe(1);
    expect(
      a.db.prepare('SELECT project_root FROM memory_anchors WHERE memory_id=?').get(id)
        .project_root,
    ).toBe(branch);
  });

  it('advances past unknown anchors without changing their last known truth', async () => {
    const a = store(),
      gone = project('gone'),
      live = project('live');
    const old = await encode(a, 'See src/check.ts.', { context: { cwd: gone } });
    const current = await encode(a, 'See src/check.ts.', { context: { cwd: live } });
    const now = new Date();
    a.db.prepare('UPDATE memory_anchors SET last_checked_at = ?').run(now.toISOString());
    rmSync(gone, { recursive: true });
    unlinkSync(join(live, 'src/check.ts'));
    expect(a.ground({ limit: 1, now }).checked).toBe(0);
    expect(a.ground({ limit: 1, now }).broken).toBe(1);
    expect(a.db.prepare('SELECT state FROM memory_anchors WHERE memory_id=?').get(old).state).toBe(
      'intact',
    );
    expect(
      a.db.prepare('SELECT state FROM memory_anchors WHERE memory_id=?').get(current).state,
    ).toBe('broken');
  });

  it.each(['leaf', 'directory'])(
    'refuses promotion through a %s symlink without overwriting its target',
    async (kind, ctx) => {
      const a = store(),
        cwd = project('promotion'),
        outside = project('outside');
      seedProcedure(a);
      const doc = renderClaudeRule(a.findPromotionCandidates()[0], new Date().toISOString());
      const victim = join(outside, 'existing.txt');
      writeFileSync(victim, 'keep this');
      if (kind === 'leaf') {
        mkdirSync(join(cwd, '.claude/rules'), { recursive: true });
        try {
          symlinkSync(victim, join(cwd, doc.relativePath));
        } catch (error) {
          if (process.platform === 'win32' && error.code === 'EPERM') {
            ctx.skip();
            return;
          }
          throw error;
        }
      } else {
        symlinkSync(outside, join(cwd, '.claude'), 'junction');
      }
      process.chdir(cwd);
      await expect(a.promote({ yes: true, projectDir: cwd })).rejects.toThrow(/symlink|outside/);
      expect(readFileSync(victim, 'utf8')).toBe('keep this');
      expect(existsSync(join(outside, 'rules'))).toBe(false);
    },
  );

  it('reinjects changed standing and then suppresses the unchanged version', async () => {
    const a = store(),
      cwd = project('delta'),
      content = 'Release checks require a successful build.';
    const evidence = await encode(a, content, { context: { cwd } });
    const id = 'semantic-delta-fixture',
      buffer = a.embeddingProvider.vectorToBuffer(await a.embeddingProvider.embed(content));
    a.db
      .prepare(
        "INSERT INTO semantics(id,content,agent,embedding,state,evidence_episode_ids,evidence_count,supporting_count,source_type_diversity,created_at,last_reinforced_at,salience) VALUES(?,?,?,?,'active',?,4,4,2,?,?,1)",
      )
      .run(
        id,
        content,
        a.agent,
        buffer,
        JSON.stringify([evidence]),
        new Date().toISOString(),
        new Date().toISOString(),
      );
    a.db
      .prepare("INSERT INTO vec_semantics(id,agent,embedding,state) VALUES(?,?,?,'active')")
      .run(id, a.agent, buffer);
    expect(JSON.stringify(await hook(a, 'SessionStart', { cwd }))).toContain(id);
    a.db.prepare("UPDATE semantics SET state='context_dependent' WHERE id=?").run(id);
    a.db.prepare("UPDATE vec_semantics SET state='context_dependent' WHERE id=?").run(id);
    expect(JSON.stringify(await hook(a, 'UserPromptSubmit', { cwd, prompt: content }))).toContain(
      id,
    );
    expect(
      JSON.stringify(await hook(a, 'UserPromptSubmit', { cwd, prompt: content })),
    ).not.toContain(id);
  });
});
