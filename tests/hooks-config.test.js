import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import {
  applyHostHookConfig,
  defaultHostHookPath,
  formatHostHookConfig,
  mergeHostHookSettings,
  removeHostHookConfig,
  removeHostHookSettings,
} from '../dist/mcp-server/hooks.js';

const TEST_DIR = resolve('.tmp-vitest', 'hooks-config');
const NODE_PATH = 'C:\\Program Files\\nodejs\\node.exe';
const ENTRYPOINT = 'C:\\Program Files\\Audrey Memory\\dist\\mcp-server\\index.js';
const SIDE_EFFECTFUL_MATCHER = '^(Bash|Edit|Write|NotebookEdit|apply_patch)$';

function parseConfig(host) {
  return JSON.parse(
    formatHostHookConfig(host, {
      nodePath: NODE_PATH,
      entrypoint: ENTRYPOINT,
    }),
  );
}

function handlersFor(settings, event) {
  return (settings.hooks?.[event] ?? []).flatMap(group => group.hooks ?? []);
}

function autopilotHandlers(settings, event) {
  return handlersFor(settings, event).filter(handler => {
    const args = Array.isArray(handler.args) ? handler.args.join(' ') : '';
    const commands = `${handler.command ?? ''} ${handler.commandWindows ?? ''}`;
    return `${args} ${commands}`.includes('hook') && `${args} ${commands}`.includes('--host');
  });
}

beforeEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
  mkdirSync(TEST_DIR, { recursive: true });
});

afterEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('formatHostHookConfig', () => {
  it('pins non-secret runtime arguments into every hook command', () => {
    const runtimeArgs = ['--data-dir', 'C:\\Audrey Data', '--agent', 'codex'];
    const config = JSON.parse(
      formatHostHookConfig('claude-code', {
        nodePath: NODE_PATH,
        entrypoint: ENTRYPOINT,
        runtimeArgs,
      }),
    );
    for (const event of Object.keys(config.hooks)) {
      expect(config.hooks[event][0].hooks[0].args).toEqual([
        ENTRYPOINT,
        'hook',
        '--host',
        'claude-code',
        '--event',
        event,
        ...runtimeArgs,
      ]);
    }
  });

  it('uses Claude Code exec-form handlers for the full lifecycle', () => {
    const config = parseConfig('claude-code');
    expect(Object.keys(config.hooks)).toEqual([
      'SessionStart',
      'SubagentStart',
      'UserPromptSubmit',
      'PreToolUse',
      'PostToolUse',
      'PostToolUseFailure',
      'PostCompact',
      'Stop',
    ]);

    for (const [event, groups] of Object.entries(config.hooks)) {
      expect(groups).toHaveLength(1);
      const handler = groups[0].hooks[0];
      expect(handler.type).toBe('command');
      expect(handler.command).toBe(NODE_PATH);
      expect(handler.args).toEqual([ENTRYPOINT, 'hook', '--host', 'claude-code', '--event', event]);
      expect(handler.commandWindows).toBeUndefined();
      expect(handler.timeout).toBeGreaterThan(0);
      expect(handler.statusMessage).toMatch(/^Audrey:/);
    }

    expect(config.hooks.SessionStart[0].matcher).toBe('startup|resume|clear|compact');
    expect(config.hooks.SubagentStart[0].matcher).toBeUndefined();
    expect(config.hooks.UserPromptSubmit[0].matcher).toBeUndefined();
    expect(config.hooks.PreToolUse[0].matcher).toBe(SIDE_EFFECTFUL_MATCHER);
    expect(config.hooks.PostToolUse[0].matcher).toBe(SIDE_EFFECTFUL_MATCHER);
    expect(config.hooks.PostToolUseFailure[0].matcher).toBe(SIDE_EFFECTFUL_MATCHER);
    expect(config.hooks.PostCompact[0].matcher).toBe('manual|auto');
    expect(config.hooks.Stop[0].matcher).toBeUndefined();
    expect(JSON.stringify(config)).not.toContain('"matcher":".*"');
  });

  it('uses Codex command and commandWindows strings with safe path quoting', () => {
    const config = parseConfig('codex');
    expect(Object.keys(config.hooks)).toEqual([
      'SessionStart',
      'SubagentStart',
      'UserPromptSubmit',
      'PreToolUse',
      'PostToolUse',
      'PostCompact',
      'Stop',
    ]);
    expect(config.hooks.PostToolUseFailure).toBeUndefined();

    const handler = config.hooks.SessionStart[0].hooks[0];
    expect(handler.args).toBeUndefined();
    expect(handler.command).toBe(
      "'C:\\Program Files\\nodejs\\node.exe' " +
        "'C:\\Program Files\\Audrey Memory\\dist\\mcp-server\\index.js' " +
        "'hook' '--host' 'codex' '--event' 'SessionStart'",
    );
    expect(handler.commandWindows).toBe(
      "& 'C:\\Program Files\\nodejs\\node.exe' " +
        "'C:\\Program Files\\Audrey Memory\\dist\\mcp-server\\index.js' " +
        "'hook' '--host' 'codex' '--event' 'SessionStart'",
    );
    expect(config.hooks.PreToolUse[0].matcher).toBe(SIDE_EFFECTFUL_MATCHER);
    expect(config.hooks.PostToolUse[0].matcher).toBe(SIDE_EFFECTFUL_MATCHER);
  });
});

describe('mergeHostHookSettings', () => {
  it('preserves unrelated settings while replacing legacy and prior autopilot handlers', () => {
    const existing = {
      permissions: { allow: ['Bash(npm test)'] },
      hooks: {
        PreToolUse: [
          {
            matcher: 'Bash',
            hooks: [{ type: 'command', command: 'existing-policy' }],
          },
          {
            matcher: '.*',
            hooks: [
              {
                type: 'command',
                command: '"C:\\audrey\\dist\\mcp-server\\index.js" guard --hook --fail-on-warn',
              },
            ],
          },
        ],
        PostToolUse: [
          {
            matcher: '.*',
            hooks: [
              { type: 'command', command: 'existing-observer' },
              {
                type: 'command',
                command:
                  '"C:\\audrey\\dist\\mcp-server\\index.js" observe-tool --event PostToolUse',
              },
            ],
          },
        ],
        Stop: [
          {
            hooks: [
              {
                type: 'command',
                command: "'node' 'old.js' 'hook' '--host' 'claude-code' '--event' 'Stop'",
              },
            ],
          },
        ],
        Notification: [
          {
            matcher: 'idle_prompt',
            hooks: [{ type: 'command', command: 'notify-me' }],
          },
        ],
      },
    };
    const generated = formatHostHookConfig('claude-code', {
      nodePath: NODE_PATH,
      entrypoint: ENTRYPOINT,
    });

    const merged = mergeHostHookSettings('claude-code', existing, generated);
    expect(merged.permissions).toEqual(existing.permissions);
    expect(merged.hooks.Notification).toEqual(existing.hooks.Notification);
    expect(handlersFor(merged, 'PreToolUse')).toContainEqual({
      type: 'command',
      command: 'existing-policy',
    });
    expect(handlersFor(merged, 'PostToolUse')).toContainEqual({
      type: 'command',
      command: 'existing-observer',
    });
    expect(JSON.stringify(merged)).not.toContain('guard --hook');
    expect(JSON.stringify(merged)).not.toContain('observe-tool --event');
    expect(JSON.stringify(merged)).not.toContain('old.js');

    for (const event of Object.keys(JSON.parse(generated).hooks)) {
      expect(autopilotHandlers(merged, event)).toHaveLength(1);
    }
  });

  it('is idempotent and replaces an older Codex autopilot command', () => {
    const existing = {
      hooks: {
        Stop: [
          {
            hooks: [
              {
                type: 'command',
                command: "'node' 'old.js' 'hook' '--host' 'codex' '--event' 'Stop'",
              },
            ],
          },
        ],
      },
    };
    const generated = formatHostHookConfig('codex', {
      nodePath: NODE_PATH,
      entrypoint: ENTRYPOINT,
    });
    const once = mergeHostHookSettings('codex', existing, generated);
    const twice = mergeHostHookSettings('codex', once, generated);

    expect(twice).toEqual(once);
    for (const event of Object.keys(JSON.parse(generated).hooks)) {
      expect(autopilotHandlers(twice, event)).toHaveLength(1);
    }
    expect(JSON.stringify(twice)).not.toContain('old.js');
  });
});

describe('removeHostHookSettings', () => {
  it('removes current and legacy Audrey handlers without disturbing unrelated handlers', () => {
    const generated = parseConfig('claude-code');
    generated.hooks.PreToolUse[0].hooks.unshift({ type: 'command', command: 'team-policy' });
    generated.hooks.PostToolUse.push({
      matcher: 'Bash',
      hooks: [
        {
          type: 'command',
          command: 'C:\\audrey\\index.js observe-tool --event PostToolUse',
        },
      ],
    });
    generated.hooks.Notification = [
      {
        hooks: [{ type: 'command', command: 'notify-me' }],
      },
    ];

    const removed = removeHostHookSettings('claude-code', generated);
    expect(handlersFor(removed, 'PreToolUse')).toEqual([
      { type: 'command', command: 'team-policy' },
    ]);
    expect(removed.hooks.PostToolUse).toBeUndefined();
    expect(removed.hooks.Notification).toEqual(generated.hooks.Notification);
    expect(JSON.stringify(removed)).not.toContain('Audrey:');
  });
});

describe('applyHostHookConfig', () => {
  it('backs up before updating and is idempotent on the second apply', () => {
    const settingsPath = join(TEST_DIR, '.claude', 'settings.json');
    mkdirSync(dirname(settingsPath), { recursive: true });
    const original = `${JSON.stringify(
      {
        theme: 'dark',
        hooks: {
          PreToolUse: [
            {
              matcher: '.*',
              hooks: [
                {
                  type: 'command',
                  command: 'C:\\audrey\\index.js guard --hook --fail-on-warn',
                },
              ],
            },
          ],
        },
      },
      null,
      2,
    )}\n`;
    writeFileSync(settingsPath, original, 'utf8');

    const first = applyHostHookConfig({
      host: 'claude-code',
      settingsPath,
      nodePath: NODE_PATH,
      entrypoint: ENTRYPOINT,
      now: new Date('2026-07-09T12:34:56.789Z'),
    });
    expect(first.changed).toBe(true);
    expect(first.backupPath).toBe(`${resolve(settingsPath)}.audrey-2026-07-09T12-34-56-789Z.bak`);
    expect(readFileSync(first.backupPath, 'utf8')).toBe(original);
    if (process.platform !== 'win32') expect(statSync(first.backupPath).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(settingsPath, 'utf8')).theme).toBe('dark');

    const second = applyHostHookConfig({
      host: 'claude-code',
      settingsPath,
      nodePath: NODE_PATH,
      entrypoint: ENTRYPOINT,
    });
    expect(second.changed).toBe(false);
    expect(second.backupPath).toBeNull();
  });

  it('does not create a settings file during a dry run', () => {
    const settingsPath = join(TEST_DIR, '.codex', 'hooks.json');
    const result = applyHostHookConfig({
      host: 'codex',
      settingsPath,
      dryRun: true,
      nodePath: NODE_PATH,
      entrypoint: ENTRYPOINT,
    });
    expect(result.changed).toBe(true);
    expect(result.dryRun).toBe(true);
    expect(result.backupPath).toBeNull();
    expect(existsSync(settingsPath)).toBe(false);
  });

  it('atomically removes only Audrey-owned hooks and keeps a backup', () => {
    const settingsPath = join(TEST_DIR, '.codex', 'hooks.json');
    mkdirSync(dirname(settingsPath), { recursive: true });
    const settings = parseConfig('codex');
    settings.theme = 'dark';
    settings.hooks.Stop.push({ hooks: [{ type: 'command', command: 'team-stop-hook' }] });
    writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');

    const result = removeHostHookConfig({
      host: 'codex',
      settingsPath,
      now: new Date('2026-07-09T13:00:00.000Z'),
    });
    const written = JSON.parse(readFileSync(settingsPath, 'utf8'));
    expect(result.changed).toBe(true);
    expect(result.backupPath).toContain('.audrey-2026-07-09T13-00-00-000Z.bak');
    expect(written.theme).toBe('dark');
    expect(handlersFor(written, 'Stop')).toEqual([{ type: 'command', command: 'team-stop-hook' }]);
    expect(JSON.stringify(written)).not.toContain('Audrey:');
  });
});

describe('defaultHostHookPath', () => {
  it('maps Claude Code scopes to their documented files', () => {
    const projectDir = join(TEST_DIR, 'project');
    expect(defaultHostHookPath({ host: 'claude-code', scope: 'local', projectDir })).toBe(
      join(resolve(projectDir), '.claude', 'settings.local.json'),
    );
    expect(defaultHostHookPath({ host: 'claude-code', scope: 'project', projectDir })).toBe(
      join(resolve(projectDir), '.claude', 'settings.json'),
    );
    expect(defaultHostHookPath({ host: 'claude-code', scope: 'user', projectDir })).toBe(
      join(homedir(), '.claude', 'settings.json'),
    );
  });

  it('maps Codex project and user scopes and rejects local scope', () => {
    const projectDir = join(TEST_DIR, 'project');
    expect(defaultHostHookPath({ host: 'codex', scope: 'project', projectDir })).toBe(
      join(resolve(projectDir), '.codex', 'hooks.json'),
    );
    expect(defaultHostHookPath({ host: 'codex', scope: 'user', projectDir })).toBe(
      join(homedir(), '.codex', 'hooks.json'),
    );
    expect(() => defaultHostHookPath({ host: 'codex', scope: 'local', projectDir })).toThrow(
      'Codex hooks do not support local scope',
    );
  });

  it('honors host-specific configuration roots for user hooks', () => {
    const projectDir = join(TEST_DIR, 'project');
    const env = {
      CLAUDE_CONFIG_DIR: join(TEST_DIR, 'claude-home'),
      CODEX_HOME: join(TEST_DIR, 'codex-home'),
    };
    expect(defaultHostHookPath({ host: 'claude-code', scope: 'user', projectDir, env })).toBe(
      join(env.CLAUDE_CONFIG_DIR, 'settings.json'),
    );
    expect(defaultHostHookPath({ host: 'codex', scope: 'user', projectDir, env })).toBe(
      join(env.CODEX_HOME, 'hooks.json'),
    );
  });
});
