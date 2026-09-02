import { randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { MCP_ENTRYPOINT, SERVER_NAME } from './config.js';

export type HookHost = 'claude-code' | 'codex';
export type HookScope = 'local' | 'project' | 'user';

export interface HostHookConfigOptions {
  nodePath?: string;
  entrypoint?: string;
  runtimeArgs?: readonly string[];
}

export interface ApplyHostHookConfigOptions extends HostHookConfigOptions {
  host: HookHost;
  settingsPath: string;
  dryRun?: boolean;
  now?: Date;
}

export interface RemoveHostHookConfigOptions {
  host: HookHost;
  settingsPath: string;
  dryRun?: boolean;
  now?: Date;
}

export interface HostHookApplyResult {
  settingsPath: string;
  dryRun: boolean;
  changed: boolean;
  backupPath: string | null;
  settings: JsonRecord;
}

export interface HostHookRuntime {
  nodePath: string;
  entrypoint: string;
}

export interface HostHookInspection {
  present: number;
  runtimeUnparseable: number;
  runtimes: HostHookRuntime[];
}

export interface DefaultHostHookPathOptions {
  host: HookHost;
  scope: HookScope;
  projectDir?: string;
  env?: Record<string, string | undefined>;
}

type JsonRecord = Record<string, unknown>;

type HookEvent =
  | 'SessionStart'
  | 'SubagentStart'
  | 'UserPromptSubmit'
  | 'PreToolUse'
  | 'PostToolUse'
  | 'PostToolUseFailure'
  | 'PostCompact'
  | 'Stop';

interface EventDefinition {
  event: HookEvent;
  timeout: number;
  statusMessage: string;
  matcher?: string;
  claudeOnly?: boolean;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Guard treats every mcp__* tool call as side-effectful except Audrey's own
 * server: guarding memory_recall would preflight-check the act of reading
 * memory and let its own outcomes pollute the recentFailures signal used to
 * judge the user's real actions. Third-party MCP tools stay guarded.
 */
export const AUDREY_MCP_TOOL_PREFIX = `mcp__${SERVER_NAME}__`;

const SIDE_EFFECTFUL_TOOL_MATCHER = `^(Bash|Edit|MultiEdit|Write|NotebookEdit|apply_patch|mcp__(?!${escapeRegExp(SERVER_NAME)}__).*)$`;
const CODEX_SIDE_EFFECTFUL_TOOL_MATCHER =
  '^(Bash|Edit|MultiEdit|Write|NotebookEdit|apply_patch|mcp__.*)$';

const EVENT_DEFINITIONS: readonly EventDefinition[] = [
  {
    event: 'SessionStart',
    matcher: 'startup|resume|clear|compact',
    timeout: 30,
    statusMessage: 'Audrey: loading memory',
  },
  {
    event: 'SubagentStart',
    timeout: 30,
    statusMessage: 'Audrey: loading subagent memory',
  },
  {
    event: 'UserPromptSubmit',
    timeout: 30,
    statusMessage: 'Audrey: recalling relevant memory',
  },
  {
    event: 'PreToolUse',
    matcher: SIDE_EFFECTFUL_TOOL_MATCHER,
    timeout: 30,
    statusMessage: 'Audrey: checking memory before action',
  },
  {
    event: 'PostToolUse',
    matcher: SIDE_EFFECTFUL_TOOL_MATCHER,
    timeout: 20,
    statusMessage: 'Audrey: recording action outcome',
  },
  {
    event: 'PostToolUseFailure',
    matcher: SIDE_EFFECTFUL_TOOL_MATCHER,
    timeout: 20,
    statusMessage: 'Audrey: learning from tool failure',
    claudeOnly: true,
  },
  {
    event: 'PostCompact',
    matcher: 'manual|auto',
    timeout: 60,
    statusMessage: 'Audrey: preserving compacted context',
  },
  {
    event: 'Stop',
    timeout: 60,
    statusMessage: 'Audrey: checkpointing memory',
  },
];

const HOOK_TEARDOWN_MARGIN_MS = 5000;

/** The host-declared timeout for a hook event, in milliseconds, or undefined for an unknown event. */
export function declaredHookTimeoutMs(event: string): number | undefined {
  const definition = EVENT_DEFINITIONS.find(def => def.event === event);
  return definition ? definition.timeout * 1000 : undefined;
}

/**
 * The budget Audrey's own per-call timeouts (embedding, LLM) should abort
 * within for a given hook event — the declared host timeout minus a margin
 * left for the process to write its diagnostic and exit cleanly before the
 * host's kill fires. Without this margin, Audrey's internal abort can lose
 * the race to the host's SIGKILL: the finally-block never runs, no
 * diagnostic is produced, and a PreToolUse receipt never gets an outcome.
 */
export function internalCallTimeoutMs(
  event: string,
  marginMs = HOOK_TEARDOWN_MARGIN_MS,
): number | undefined {
  const declared = declaredHookTimeoutMs(event);
  if (declared === undefined) return undefined;
  return Math.max(1000, declared - marginMs);
}

function assertHost(host: string): asserts host is HookHost {
  if (host !== 'claude-code' && host !== 'codex') {
    throw new Error(`Unsupported hook host "${host}". Use claude-code or codex.`);
  }
}

function assertScope(scope: string): asserts scope is HookScope {
  if (scope !== 'local' && scope !== 'project' && scope !== 'user') {
    throw new Error(`Unsupported hook scope "${scope}". Use local, project, or user.`);
  }
}

function asRecord(value: unknown): JsonRecord | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function settingsRecord(value: unknown, label: string): JsonRecord {
  if (value === undefined || value === null || value === '') return {};
  let parsed: unknown = value;
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value) as unknown;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`${label} is not valid JSON: ${message}`, { cause: error });
    }
  }
  const record = asRecord(parsed);
  if (!record) throw new Error(`${label} must be a JSON object.`);
  return record;
}

function posixQuote(value: string): string {
  return `'${value.replace(/'/g, "'\"'\"'")}'`;
}

function powershellQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function hookArguments(host: HookHost, event: HookEvent, runtimeArgs: readonly string[]): string[] {
  return ['hook', '--host', host, '--event', event, ...runtimeArgs];
}

function claudeHandler(
  host: HookHost,
  definition: EventDefinition,
  nodePath: string,
  entrypoint: string,
  runtimeArgs: readonly string[],
): JsonRecord {
  return {
    type: 'command',
    command: nodePath,
    args: [entrypoint, ...hookArguments(host, definition.event, runtimeArgs)],
    timeout: definition.timeout,
    statusMessage: definition.statusMessage,
  };
}

function codexHandler(
  host: HookHost,
  definition: EventDefinition,
  nodePath: string,
  entrypoint: string,
  runtimeArgs: readonly string[],
): JsonRecord {
  const argv = [nodePath, entrypoint, ...hookArguments(host, definition.event, runtimeArgs)];
  return {
    type: 'command',
    command: argv.map(posixQuote).join(' '),
    commandWindows: `& ${argv.map(powershellQuote).join(' ')}`,
    timeout: definition.timeout,
    statusMessage: definition.statusMessage,
  };
}

function eventGroup(
  host: HookHost,
  definition: EventDefinition,
  nodePath: string,
  entrypoint: string,
  runtimeArgs: readonly string[],
): JsonRecord {
  const handler =
    host === 'claude-code'
      ? claudeHandler(host, definition, nodePath, entrypoint, runtimeArgs)
      : codexHandler(host, definition, nodePath, entrypoint, runtimeArgs);
  const matcher =
    host === 'codex' && definition.matcher === SIDE_EFFECTFUL_TOOL_MATCHER
      ? CODEX_SIDE_EFFECTFUL_TOOL_MATCHER
      : definition.matcher;
  return {
    ...(matcher ? { matcher } : {}),
    hooks: [handler],
  };
}

export function formatHostHookConfig(host: HookHost, options: HostHookConfigOptions = {}): string {
  assertHost(host);
  const nodePath = options.nodePath ?? process.execPath;
  const entrypoint = options.entrypoint ?? MCP_ENTRYPOINT;
  const runtimeArgs = options.runtimeArgs ?? [];
  const hooks: JsonRecord = {};

  for (const definition of EVENT_DEFINITIONS) {
    if (definition.claudeOnly && host !== 'claude-code') continue;
    hooks[definition.event] = [eventGroup(host, definition, nodePath, entrypoint, runtimeArgs)];
  }

  return JSON.stringify({ hooks }, null, 2);
}

function handlerText(handler: JsonRecord): string {
  const args = Array.isArray(handler.args)
    ? handler.args.filter((item): item is string => typeof item === 'string')
    : [];
  return [handler.command, handler.commandWindows, ...args]
    .filter((item): item is string => typeof item === 'string')
    .join(' ');
}

function isAudreyHandler(value: unknown): boolean {
  const handler = asRecord(value);
  if (!handler) return false;

  const statusMessage = typeof handler.statusMessage === 'string' ? handler.statusMessage : '';
  if (/^Audrey(?::|\s)/i.test(statusMessage)) return true;

  const text = handlerText(handler);
  const normalized = text.replace(/['"]/g, ' ');
  const isAutopilot =
    /\bhook\b/i.test(normalized) &&
    /--host(?:\s+|=)(?:claude-code|codex)\b/i.test(normalized) &&
    /--event(?:\s+|=)(?:SessionStart|SubagentStart|UserPromptSubmit|PreToolUse|PostToolUse|PostToolUseFailure|PostCompact|Stop)\b/i.test(
      normalized,
    );
  if (isAutopilot) return true;
  if (/\bguard\s+--hook\b/i.test(normalized)) return true;
  // Any observe-tool event, not just PostToolUse(Failure): legacy configs
  // registered StopFailure, SubagentStart/Stop, TaskCreated/Completed too.
  if (/\bobserve-tool\s+--event(?:\s+|=)[A-Za-z]+\b/i.test(normalized)) return true;
  if (/(?:audrey[^\r\n]*autopilot|autopilot[^\r\n]*audrey)/i.test(normalized)) return true;
  // Legacy handlers predate statusMessage and ran bare CLI verbs (greeting,
  // reflect) with no --host/--event flags. Recognize them by the entrypoint
  // they invoke — a path whose directory segment starts with "audrey"
  // (repo checkout, npm global, npx cache, "Audrey Memory" installs) leading
  // into an mcp-server build — so an unrelated tool that merely mentions
  // audrey somewhere, or lives in "my-audrey-fork", is never claimed.
  if (/[\\/]audrey[^\\/]*[\\/](?:dist[\\/])?mcp-server[\\/]index\.[cm]?js\b/i.test(normalized)) {
    return true;
  }
  // CLI-via-package forms ("npx audrey reflect", "audrey greeting"). Only
  // the verbs that never appear with flags — hook/guard forms always carry
  // --host/--hook and are matched by the stricter rules above, so keeping
  // them out of this list shrinks the false-positive surface.
  if (/\baudrey\b\s+(?:greeting|reflect|observe-tool|dream)\b/i.test(normalized)) {
    return true;
  }
  return false;
}

function quotedCommandArguments(command: string): string[] {
  return Array.from(command.matchAll(/'((?:''|[^'])*)'/g), match =>
    (match[1] ?? '').replace(/''/g, "'"),
  );
}

function handlerRuntime(value: unknown): HostHookRuntime | null {
  const handler = asRecord(value);
  if (!handler) return null;

  const args = Array.isArray(handler.args)
    ? handler.args.filter((item): item is string => typeof item === 'string')
    : [];
  if (typeof handler.command === 'string' && args.length > 0) {
    return { nodePath: handler.command, entrypoint: args[0]! };
  }

  const command =
    typeof handler.commandWindows === 'string'
      ? handler.commandWindows
      : typeof handler.command === 'string'
        ? handler.command
        : '';
  const argv = quotedCommandArguments(command);
  if (argv.length < 2) return null;
  return { nodePath: argv[0]!, entrypoint: argv[1]! };
}

export function inspectHostHookDiagnostics(host: HookHost, existing: unknown): HostHookInspection {
  assertHost(host);
  const settings = settingsRecord(existing, 'Existing hook settings');
  const hooks = asRecord(settings.hooks);
  if (!hooks) return { present: 0, runtimeUnparseable: 0, runtimes: [] };

  const runtimes: HostHookRuntime[] = [];
  const seen = new Set<string>();
  let present = 0;
  let runtimeUnparseable = 0;
  for (const groupsValue of Object.values(hooks)) {
    if (!Array.isArray(groupsValue)) continue;
    for (const groupValue of groupsValue) {
      const group = asRecord(groupValue);
      if (!group || !Array.isArray(group.hooks)) continue;
      for (const handler of group.hooks) {
        if (!isAudreyHandler(handler)) continue;
        present += 1;
        const runtime = handlerRuntime(handler);
        if (!runtime) {
          runtimeUnparseable += 1;
          continue;
        }
        const key = `${runtime.nodePath}\0${runtime.entrypoint}`;
        if (seen.has(key)) continue;
        seen.add(key);
        runtimes.push(runtime);
      }
    }
  }
  return { present, runtimeUnparseable, runtimes };
}

function withoutAudreyHandlers(settings: JsonRecord): JsonRecord {
  const next: JsonRecord = { ...settings };
  const hooks = asRecord(settings.hooks);
  if (!hooks) return next;

  const nextHooks: JsonRecord = { ...hooks };
  for (const [event, groupsValue] of Object.entries(hooks)) {
    if (!Array.isArray(groupsValue)) continue;
    const groups: unknown[] = [];

    for (const groupValue of groupsValue) {
      const group = asRecord(groupValue);
      if (!group || !Array.isArray(group.hooks)) {
        groups.push(groupValue);
        continue;
      }
      const handlers = group.hooks.filter(handler => !isAudreyHandler(handler));
      if (handlers.length > 0) groups.push({ ...group, hooks: handlers });
    }

    if (groups.length > 0) nextHooks[event] = groups;
    else delete nextHooks[event];
  }

  next.hooks = nextHooks;
  return next;
}

export function removeHostHookSettings(host: HookHost, existing: unknown): JsonRecord {
  assertHost(host);
  return withoutAudreyHandlers(settingsRecord(existing, 'Existing hook settings'));
}

export function mergeHostHookSettings(
  host: HookHost,
  existing: unknown,
  generated: unknown = formatHostHookConfig(host),
): JsonRecord {
  assertHost(host);
  const merged = removeHostHookSettings(host, existing);
  const mergedHooks = asRecord(merged.hooks) ?? {};
  const generatedRecord = settingsRecord(generated, 'Generated hook settings');
  const generatedHooks = asRecord(generatedRecord.hooks);
  if (!generatedHooks) throw new Error('Generated hook settings must contain a hooks object.');

  const nextHooks: JsonRecord = { ...mergedHooks };
  for (const [event, groups] of Object.entries(generatedHooks)) {
    if (!Array.isArray(groups)) {
      throw new Error(`Generated hook event "${event}" must be an array.`);
    }
    const existingGroups = Array.isArray(nextHooks[event]) ? (nextHooks[event] as unknown[]) : [];
    const generatedGroups: unknown[] = groups;
    nextHooks[event] = [...existingGroups, ...generatedGroups];
  }
  merged.hooks = nextHooks;
  return merged;
}

function atomicReplace(settingsPath: string, nextText: string, expectedText: string): void {
  const tempPath = `${settingsPath}.audrey-${process.pid}-${randomUUID()}.tmp`;
  let fd: number | undefined;
  try {
    fd = openSync(tempPath, 'wx', 0o600);
    writeFileSync(fd, nextText, 'utf8');
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;

    const currentText = existsSync(settingsPath) ? readFileSync(settingsPath, 'utf8') : '';
    if (currentText !== expectedText) {
      throw new Error(
        `Hook settings changed while Audrey was updating ${settingsPath}; retry the install.`,
      );
    }
    renameSync(tempPath, settingsPath);
  } finally {
    if (fd !== undefined) closeSync(fd);
    rmSync(tempPath, { force: true });
  }
}

function writePrivateBackup(path: string, content: string): void {
  writeFileSync(path, content, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
}

export function applyHostHookConfig(options: ApplyHostHookConfigOptions): HostHookApplyResult {
  assertHost(options.host);
  const settingsPath = resolve(options.settingsPath);
  const existingText = existsSync(settingsPath) ? readFileSync(settingsPath, 'utf8') : '';
  const existing = settingsRecord(existingText, `Hook settings at ${settingsPath}`);
  const generated = formatHostHookConfig(options.host, {
    nodePath: options.nodePath,
    entrypoint: options.entrypoint,
    runtimeArgs: options.runtimeArgs,
  });
  const settings = mergeHostHookSettings(options.host, existing, generated);
  const nextText = `${JSON.stringify(settings, null, 2)}\n`;
  const changed = existingText !== nextText;
  const dryRun = options.dryRun ?? false;
  let backupPath: string | null = null;

  if (changed && !dryRun) {
    mkdirSync(dirname(settingsPath), { recursive: true });
    if (existingText) {
      const stamp = (options.now ?? new Date()).toISOString().replace(/[:.]/g, '-');
      backupPath = `${settingsPath}.audrey-${stamp}.bak`;
      writePrivateBackup(backupPath, existingText);
    }
    atomicReplace(settingsPath, nextText, existingText);
  }

  return {
    settingsPath,
    dryRun,
    changed,
    backupPath,
    settings,
  };
}

export function removeHostHookConfig(options: RemoveHostHookConfigOptions): HostHookApplyResult {
  assertHost(options.host);
  const settingsPath = resolve(options.settingsPath);
  const existingText = existsSync(settingsPath) ? readFileSync(settingsPath, 'utf8') : '';
  const settings = removeHostHookSettings(options.host, existingText);
  const nextText = `${JSON.stringify(settings, null, 2)}\n`;
  const changed = Boolean(existingText) && existingText !== nextText;
  const dryRun = options.dryRun ?? false;
  let backupPath: string | null = null;

  if (changed && !dryRun) {
    const stamp = (options.now ?? new Date()).toISOString().replace(/[:.]/g, '-');
    backupPath = `${settingsPath}.audrey-${stamp}.bak`;
    writePrivateBackup(backupPath, existingText);
    atomicReplace(settingsPath, nextText, existingText);
  }

  return { settingsPath, dryRun, changed, backupPath, settings };
}

export function defaultHostHookPath(options: DefaultHostHookPathOptions): string {
  assertHost(options.host);
  assertScope(options.scope);
  const projectDir = resolve(options.projectDir ?? process.cwd());
  const env = options.env ?? process.env;

  if (options.host === 'claude-code') {
    if (options.scope === 'user') {
      return join(env['CLAUDE_CONFIG_DIR'] || join(homedir(), '.claude'), 'settings.json');
    }
    const filename = options.scope === 'project' ? 'settings.json' : 'settings.local.json';
    return join(projectDir, '.claude', filename);
  }

  if (options.scope === 'local') {
    throw new Error('Codex hooks do not support local scope. Use project or user.');
  }
  if (options.scope === 'user') {
    return join(env['CODEX_HOME'] || join(homedir(), '.codex'), 'hooks.json');
  }
  return join(projectDir, '.codex', 'hooks.json');
}
