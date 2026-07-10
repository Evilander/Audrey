import { createHash } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { isAbsolute, normalize, resolve } from 'node:path';
import { redact } from './redact.js';

export interface GuardActionFingerprintInput {
  tool?: string;
  command?: string;
  action: string;
  actionDigest?: string;
  cwd?: string;
  files?: string[];
}

function redactedText(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return redact(value).text.replace(/\s+/g, ' ').trim();
}

function normalizePathForKey(value: string | undefined, base?: string): string {
  if (!value) return '';
  const resolved = isAbsolute(value) ? value : resolve(base || process.cwd(), value);
  let out = normalize(resolved)
    .replace(/^\\\\\?\\/, '')
    .replace(/\\/g, '/');
  try {
    if (existsSync(resolved)) {
      out = normalize(realpathSync(resolved))
        .replace(/^\\\\\?\\/, '')
        .replace(/\\/g, '/');
    }
  } catch {
    // Keep the normalized fallback when realpath is unavailable.
  }
  return process.platform === 'win32' ? out.toLowerCase() : out;
}

export function guardActionKey(action: GuardActionFingerprintInput): string {
  const tool = action.tool ?? 'unknown';
  const commandOrAction = action.command ?? action.action;
  const actionIdentity = action.actionDigest
    ? `digest:${action.actionDigest.trim().toLowerCase()}`
    : (redactedText(commandOrAction) ?? commandOrAction);
  const cwd = normalizePathForKey(action.cwd);
  const files = [...(action.files ?? [])]
    .map(file => file.trim())
    .filter(Boolean)
    .map(file => normalizePathForKey(file, cwd || action.cwd))
    .sort()
    .join('\n');
  return createHash('sha256')
    .update(
      [
        tool.toLowerCase(),
        actionIdentity.replace(/\s+/g, ' ').trim().toLowerCase(),
        cwd,
        files,
      ].join('\n'),
    )
    .digest('hex');
}
