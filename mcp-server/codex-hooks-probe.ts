import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

export interface CodexReportedHook {
  sourcePath: string;
  enabled: boolean;
  trustStatus: string;
  statusMessage: string;
  command: string;
}

export interface CodexHooksProbeResult {
  hooks: CodexReportedHook[];
  warnings: string[];
  errors: string[];
}

export interface CodexHooksProbeInvocation {
  command: string;
  argsPrefix: string[];
  cwd: string;
  version: string;
  timeoutMs?: number;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

export function parseCodexHooksListResponse(response: unknown): CodexHooksProbeResult {
  const envelope = asRecord(response);
  const responseError = asRecord(envelope?.['error']);
  if (responseError) {
    const message =
      typeof responseError['message'] === 'string'
        ? responseError['message']
        : 'Codex hooks/list returned an error.';
    throw new Error(message);
  }
  const result = asRecord(envelope?.['result']);
  const data = result?.['data'];
  if (!Array.isArray(data))
    throw new Error('Codex hooks/list response did not contain result.data.');

  const parsed: CodexHooksProbeResult = { hooks: [], warnings: [], errors: [] };
  for (const cwdValue of data) {
    const cwdResult = asRecord(cwdValue);
    if (!cwdResult) continue;
    parsed.warnings.push(...stringList(cwdResult['warnings']));
    parsed.errors.push(...stringList(cwdResult['errors']));
    const hooks = cwdResult['hooks'];
    if (!Array.isArray(hooks)) continue;
    for (const hookValue of hooks) {
      const hook = asRecord(hookValue);
      if (!hook) continue;
      parsed.hooks.push({
        sourcePath: typeof hook['sourcePath'] === 'string' ? hook['sourcePath'] : '',
        enabled: hook['enabled'] === true,
        trustStatus: typeof hook['trustStatus'] === 'string' ? hook['trustStatus'] : 'unknown',
        statusMessage: typeof hook['statusMessage'] === 'string' ? hook['statusMessage'] : '',
        command: typeof hook['command'] === 'string' ? hook['command'] : '',
      });
    }
  }
  return parsed;
}

export function probeCodexHooks(
  invocation: CodexHooksProbeInvocation,
): Promise<CodexHooksProbeResult> {
  return new Promise((resolveProbe, rejectProbe) => {
    const child = spawn(invocation.command, [...invocation.argsPrefix, 'app-server', '--stdio'], {
      cwd: invocation.cwd,
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const stdout = createInterface({ input: child.stdout });
    let stderr = '';
    let settled = false;

    const settle = (error: Error | null, result?: CodexHooksProbeResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stdout.close();
      child.stdin.end();
      child.kill();
      if (error) rejectProbe(error);
      else resolveProbe(result!);
    };

    const timer = setTimeout(() => {
      settle(new Error('Codex app-server hooks/list probe timed out.'));
    }, invocation.timeoutMs ?? 8_000);

    child.stderr.on('data', chunk => {
      if (stderr.length < 4_000) stderr += String(chunk).slice(0, 4_000 - stderr.length);
    });
    child.on('error', error => settle(error));
    // Without these, a broken/removed binary or a pipe closed after spawn (EPIPE) raises an
    // unhandled 'error' event on stdin/stdout and crashes the host process instead of
    // rejecting this probe.
    child.stdin.on('error', error => settle(error));
    child.stdout.on('error', error => settle(error));
    child.on('exit', code => {
      if (!settled) {
        const detail = stderr.trim() ? `: ${stderr.trim()}` : '';
        settle(new Error(`Codex app-server exited before hooks/list completed (${code})${detail}`));
      }
    });
    stdout.on('line', line => {
      let message: unknown;
      try {
        message = JSON.parse(line) as unknown;
      } catch {
        return;
      }
      const record = asRecord(message);
      if (record?.['id'] === 0) {
        child.stdin.write(`${JSON.stringify({ method: 'initialized', params: {} })}\n`);
        child.stdin.write(
          `${JSON.stringify({
            method: 'hooks/list',
            id: 1,
            params: { cwds: [invocation.cwd] },
          })}\n`,
        );
      } else if (record?.['id'] === 1) {
        try {
          settle(null, parseCodexHooksListResponse(message));
        } catch (error) {
          settle(error instanceof Error ? error : new Error(String(error)));
        }
      }
    });

    child.stdin.write(
      `${JSON.stringify({
        method: 'initialize',
        id: 0,
        params: {
          clientInfo: {
            name: 'audrey_doctor',
            title: 'Audrey Doctor',
            version: invocation.version,
          },
        },
      })}\n`,
    );
  });
}

function isMainModule(): boolean {
  const invoked = process.argv[1];
  if (!invoked) return false;
  const actual = resolve(fileURLToPath(import.meta.url));
  const requested = resolve(invoked);
  return process.platform === 'win32'
    ? actual.toLowerCase() === requested.toLowerCase()
    : actual === requested;
}

if (isMainModule()) {
  const encoded = process.argv[2];
  try {
    if (!encoded) throw new Error('Codex hooks probe invocation is missing.');
    const invocation = JSON.parse(
      Buffer.from(encoded, 'base64url').toString('utf8'),
    ) as CodexHooksProbeInvocation;
    const result = await probeCodexHooks(invocation);
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message.replace(/[\r\n]+/g, ' ')}\n`);
    process.exitCode = 1;
  }
}
