import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';

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
