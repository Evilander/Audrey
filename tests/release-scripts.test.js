import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';

function publicationPlan(args) {
  const result = spawnSync(
    process.execPath,
    [
      'scripts/publish-release-bundle.mjs',
      '--json',
      '--remote',
      'file:///nonexistent-audrey-release-remote',
      ...args,
    ],
    { cwd: process.cwd(), encoding: 'utf8' },
  );
  return JSON.parse(result.stdout);
}

describe('release source bundle defaults', () => {
  it('derives the default bundle from the selected release version', () => {
    expect(publicationPlan(['--version', '2.0.0']).bundle).toBe(
      '.tmp/release-artifacts/audrey-2.0.0.git.bundle',
    );
  });

  it('preserves an explicit bundle path', () => {
    expect(publicationPlan(['--version', '2.0.0', '--bundle', 'release.git.bundle']).bundle).toBe(
      'release.git.bundle',
    );
  });
});

describe('release finalization readiness version', () => {
  it('uses the selected version in the displayed plan and executed readiness command', () => {
    const root = mkdtempSync(join(tmpdir(), 'audrey-finalize-version-'));
    try {
      mkdirSync(join(root, 'scripts'));
      copyFileSync(
        resolve('scripts/finalize-release.mjs'),
        join(root, 'scripts/finalize-release.mjs'),
      );
      writeFileSync(
        join(root, 'package.json'),
        JSON.stringify({ name: 'audrey', version: '9.8.7' }),
      );
      writeFileSync(
        join(root, 'scripts/verify-release-readiness.mjs'),
        `
        import { writeFileSync } from 'node:fs';
        writeFileSync('readiness-args.json', JSON.stringify(process.argv.slice(2)));
        console.error('intentional fixture stop before release actions');
        process.exit(19);
      `,
      );
      const args = [
        join(root, 'scripts/finalize-release.mjs'),
        '--version',
        '9.8.7',
        '--pack',
        '--json',
      ];
      const env = { ...process.env };
      const pathKey = Object.keys(env).find(key => key.toLowerCase() === 'path') ?? 'PATH';
      env[pathKey] = `${dirname(process.execPath)}${delimiter}${env[pathKey] ?? ''}`;
      const options = { cwd: root, env, encoding: 'utf8', timeout: 5000 };
      const plan = spawnSync(process.execPath, args, options);
      expect(plan.status, plan.stderr).toBe(0);
      expect(JSON.parse(plan.stdout).commands[0]).toContain('--version 9.8.7');
      expect(existsSync(join(root, 'readiness-args.json'))).toBe(false);

      const executed = spawnSync(process.execPath, [...args, '--apply'], options);
      expect(executed.status).toBe(1);
      expect(executed.stderr).toContain('intentional fixture stop');
      expect(JSON.parse(readFileSync(join(root, 'readiness-args.json'), 'utf8'))).toEqual([
        '--version',
        '9.8.7',
        '--allow-pending',
        '--json',
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
