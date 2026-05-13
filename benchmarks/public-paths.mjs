import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WINDOWS_DRIVE_PATTERN = /(^|[^a-z])[A-Z]:[\\/]/i;
const EXTENDED_PATH_PATTERN = /\\\\\?\\/;
const FILE_URL_PATTERN = /file:\/\//i;

function isUrl(value) {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(value);
}

export function publicPath(value) {
  if (typeof value !== 'string') return value;
  if (value === process.execPath) return 'node';
  if (isUrl(value)) return value;

  const resolved = resolve(value);
  const rel = relative(ROOT, resolved);
  if (rel && !rel.startsWith('..') && !isAbsolute(rel)) {
    return rel.replaceAll('\\', '/');
  }
  if (value.includes('\\') || value.includes('/') || isAbsolute(value)) {
    return `[LOCAL-PATH:${basename(value) || 'path'}]`;
  }
  return value;
}

export function publicCommand(command = []) {
  return command.map(part => publicPath(part));
}

export function publicArtifactValue(value) {
  if (Array.isArray(value)) return value.map(item => publicArtifactValue(item));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, publicArtifactValue(item)]));
  }
  return publicPath(value);
}

export function containsLocalPath(text) {
  return WINDOWS_DRIVE_PATTERN.test(text)
    || EXTENDED_PATH_PATTERN.test(text)
    || FILE_URL_PATTERN.test(text);
}

export function findLocalPathLeaks(value, path = '$') {
  if (typeof value === 'string') {
    return containsLocalPath(value) ? [`${path}: ${value}`] : [];
  }
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => findLocalPathLeaks(item, `${path}[${index}]`));
  }
  if (value && typeof value === 'object') {
    return Object.entries(value).flatMap(([key, item]) => findLocalPathLeaks(item, `${path}.${key}`));
  }
  return [];
}

export function walkFiles(dir, root = dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return walkFiles(path, root);
    return relative(root, path).replaceAll('\\', '/');
  });
}

export function scanFilesForLocalPaths(root, files) {
  const leaks = [];
  for (const file of files) {
    const path = join(root, file);
    if (!existsSync(path)) continue;
    const content = readFileSync(path, 'utf-8');
    if (containsLocalPath(content)) leaks.push(file);
  }
  return leaks;
}
