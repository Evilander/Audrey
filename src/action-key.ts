import { createHash } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { isAbsolute, normalize, resolve } from 'node:path';
import { redact, truncateRedactedText, type RedactionHit } from './redact.js';

export interface GuardActionFingerprintInput {
  tool?: string;
  command?: string;
  action: string;
  cwd?: string;
  files?: string[];
}

function compact(
  value: string | undefined,
  max = 2000,
  redactions: RedactionHit[] = [],
): string | undefined {
  if (!value) return undefined;
  const text = value.replace(/\s+/g, ' ').trim();
  if (text.length <= max) return text;
  return truncateRedactedText(text, max, redactions);
}

function redactedText(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const result = redact(value);
  return compact(result.text, 2000, result.redactions);
}

function normalizePathForKey(value: string | undefined, base?: string): string {
  if (!value) return '';
  const resolved = isAbsolute(value) ? value : resolve(base || process.cwd(), value);
  let out = normalize(resolved).replace(/^\\\\\?\\/, '').replace(/\\/g, '/');
  try {
    if (existsSync(resolved)) {
      out = normalize(realpathSync(resolved)).replace(/^\\\\\?\\/, '').replace(/\\/g, '/');
    }
  } catch {
    // Keep the normalized fallback when realpath is unavailable.
  }
  return process.platform === 'win32' ? out.toLowerCase() : out;
}

export function guardActionKey(action: GuardActionFingerprintInput): string {
  const tool = action.tool ?? 'unknown';
  const commandOrAction = action.command ?? action.action;
  const safeCommand = redactedText(commandOrAction) ?? commandOrAction;
  const cwd = normalizePathForKey(action.cwd);
  const files = [...(action.files ?? [])]
    .map(file => file.trim())
    .filter(Boolean)
    .map(file => normalizePathForKey(file, cwd || action.cwd))
    .sort()
    .join('\n');
  return createHash('sha256')
    .update([tool.toLowerCase(), safeCommand.replace(/\s+/g, ' ').trim().toLowerCase(), cwd, files].join('\n'))
    .digest('hex');
}
