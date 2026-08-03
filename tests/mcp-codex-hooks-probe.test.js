import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseCodexHooksListResponse,
  probeCodexHooks,
} from '../dist/mcp-server/codex-hooks-probe.js';

function writeFakeCodex(dir, source) {
  const path = join(dir, 'fake-codex.mjs');
  writeFileSync(path, source, 'utf8');
  return path;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// probeCodexHooks settles as soon as it calls child.kill(), before Windows has actually
// finished tearing down the child process. Since that process still has workDir as its
// cwd, an rmSync run in the same tick sees the directory as locked and throws EPERM.
// Node's own maxRetries/retryDelay don't help here (they retry synchronously, with no
// event-loop turn for the child's exit to land), so retry manually across real turns.
async function rmDirWithRetry(dir, { attempts = 20, delayMs = 50 } = {}) {
  for (let attempt = 1; ; attempt++) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch (error) {
      if (attempt >= attempts) throw error;
      await sleep(delayMs);
    }
  }
}

const FAKE_CODEX_HAPPY_PATH = `
import { createInterface } from 'node:readline';
const rl = createInterface({ input: process.stdin });
rl.on('line', line => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    process.stdout.write('not-json-garbage-that-should-be-ignored\\n');
    return;
  }
  if (msg.id === 0) {
    process.stdout.write('also-not-json\\n');
    process.stdout.write(JSON.stringify({ id: 0, result: {} }) + '\\n');
  } else if (msg.id === 1) {
    process.stdout.write(
      JSON.stringify({
        id: 1,
        result: {
          data: [
            {
              cwd: process.cwd(),
              hooks: [
                {
                  sourcePath: 'fake-hooks.json',
                  enabled: true,
                  trustStatus: 'trusted',
                  statusMessage: 'Audrey: loading memory',
                  command: 'node audrey.js hook',
                },
              ],
              warnings: ['clamped a timeout'],
              errors: [],
            },
          ],
        },
      }) + '\\n',
    );
  }
});
`;

const FAKE_CODEX_EMPTY_DATA = `
import { createInterface } from 'node:readline';
const rl = createInterface({ input: process.stdin });
rl.on('line', line => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.id === 0) {
    process.stdout.write(JSON.stringify({ id: 0, result: {} }) + '\\n');
  } else if (msg.id === 1) {
    process.stdout.write(JSON.stringify({ id: 1, result: { data: [] } }) + '\\n');
  }
});
`;

// Acks the initialize handshake, then destroys its own stdin before the probe's next
// write (the "initialized" notification + hooks/list request). On POSIX that write raises
// an EPIPE-style error on the probe's side of the pipe; on Windows the write is silently
// dropped instead, so the probe's own timeout is what ends up rejecting. Either way the
// invariant under test holds: the host process must not crash. setInterval keeps the
// process alive so the exit event doesn't race the stream error on platforms that raise one.
const FAKE_CODEX_DESTROYED_STDIN = `
import { createInterface } from 'node:readline';
const rl = createInterface({ input: process.stdin });
let responded = false;
rl.on('line', line => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.id === 0 && !responded) {
    responded = true;
    process.stdout.write(JSON.stringify({ id: 0, result: {} }) + '\\n');
    process.stdin.destroy();
  }
});
setInterval(() => {}, 1000);
`;

describe('parseCodexHooksListResponse (response parser unit tests)', () => {
  it('parses a well-formed hooks/list response', () => {
    const parsed = parseCodexHooksListResponse({
      id: 1,
      result: {
        data: [
          {
            cwd: '/repo',
            hooks: [
              {
                sourcePath: '/home/.codex/hooks.json',
                enabled: true,
                trustStatus: 'trusted',
                statusMessage: 'Audrey: loading memory',
                command: 'node audrey.js hook',
              },
            ],
            warnings: ['w1'],
            errors: ['e1'],
          },
        ],
      },
    });

    expect(parsed).toEqual({
      hooks: [
        {
          sourcePath: '/home/.codex/hooks.json',
          enabled: true,
          trustStatus: 'trusted',
          statusMessage: 'Audrey: loading memory',
          command: 'node audrey.js hook',
        },
      ],
      warnings: ['w1'],
      errors: ['e1'],
    });
  });

  it('throws with the server-reported message when the response is a JSON-RPC error', () => {
    expect(() =>
      parseCodexHooksListResponse({ id: 1, error: { message: 'hooks/list is unsupported' } }),
    ).toThrow('hooks/list is unsupported');
  });

  it('throws a clear error on a malformed response missing result.data', () => {
    expect(() => parseCodexHooksListResponse({ id: 1, result: {} })).toThrow(
      'Codex hooks/list response did not contain result.data.',
    );
  });

  it('throws on a truncated/garbage response instead of returning a partial result', () => {
    expect(() => parseCodexHooksListResponse(null)).toThrow(
      'Codex hooks/list response did not contain result.data.',
    );
    expect(() => parseCodexHooksListResponse('not even an object')).toThrow(
      'Codex hooks/list response did not contain result.data.',
    );
    expect(() => parseCodexHooksListResponse(42)).toThrow(
      'Codex hooks/list response did not contain result.data.',
    );
  });

  it('returns empty hooks/warnings/errors for an empty response', () => {
    const parsed = parseCodexHooksListResponse({ id: 1, result: { data: [] } });
    expect(parsed).toEqual({ hooks: [], warnings: [], errors: [] });
  });

  it('skips malformed hook entries within an otherwise valid response instead of throwing', () => {
    const parsed = parseCodexHooksListResponse({
      id: 1,
      result: {
        data: [
          {
            cwd: '/repo',
            hooks: ['not-an-object', null, { sourcePath: '/ok/hooks.json' }],
            warnings: [],
            errors: [],
          },
        ],
      },
    });
    expect(parsed.hooks).toEqual([
      {
        sourcePath: '/ok/hooks.json',
        enabled: false,
        trustStatus: 'unknown',
        statusMessage: '',
        command: '',
      },
    ]);
  });
});

describe('probeCodexHooks (integration, spawns a real child process)', () => {
  let workDir;

  afterEach(async () => {
    if (workDir) await rmDirWithRetry(workDir);
    workDir = undefined;
  });

  it('completes the handshake and tolerates malformed/truncated lines from the child', async () => {
    workDir = mkdtempSync(join(tmpdir(), 'audrey-codex-probe-'));
    const fakeCodex = writeFakeCodex(workDir, FAKE_CODEX_HAPPY_PATH);

    const result = await probeCodexHooks({
      command: process.execPath,
      argsPrefix: [fakeCodex],
      cwd: workDir,
      version: '1.0.0-test',
      timeoutMs: 8000,
    });

    expect(result.hooks).toHaveLength(1);
    expect(result.hooks[0]).toMatchObject({ enabled: true, trustStatus: 'trusted' });
    expect(result.warnings).toEqual(['clamped a timeout']);
    expect(result.errors).toEqual([]);
  }, 15000);

  it('resolves an empty result set without throwing', async () => {
    workDir = mkdtempSync(join(tmpdir(), 'audrey-codex-probe-'));
    const fakeCodex = writeFakeCodex(workDir, FAKE_CODEX_EMPTY_DATA);

    const result = await probeCodexHooks({
      command: process.execPath,
      argsPrefix: [fakeCodex],
      cwd: workDir,
      version: '1.0.0-test',
      timeoutMs: 8000,
    });

    expect(result).toEqual({ hooks: [], warnings: [], errors: [] });
  }, 15000);

  it('rejects cleanly when the Codex CLI is not installed', async () => {
    await expect(
      probeCodexHooks({
        command: 'definitely-not-a-real-codex-binary-audrey-test',
        argsPrefix: [],
        cwd: process.cwd(),
        version: '1.0.0-test',
        timeoutMs: 4000,
      }),
    ).rejects.toThrow();
  }, 10000);

  it('rejects instead of crashing the host process when the child destroys its stdin', async () => {
    workDir = mkdtempSync(join(tmpdir(), 'audrey-codex-probe-'));
    const fakeCodex = writeFakeCodex(workDir, FAKE_CODEX_DESTROYED_STDIN);

    // Before the fix, an unhandled 'error' event on child.stdin/stdout here would crash
    // the whole process instead of rejecting this promise.
    await expect(
      probeCodexHooks({
        command: process.execPath,
        argsPrefix: [fakeCodex],
        cwd: workDir,
        version: '1.0.0-test',
        timeoutMs: 5000,
      }),
    ).rejects.toThrow();
  }, 12000);
});
