import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

const vitestTmp = resolve('.tmp-vitest');
mkdirSync(vitestTmp, { recursive: true });
process.env.TEMP = vitestTmp;
process.env.TMP = vitestTmp;
process.env.TMPDIR = vitestTmp;

export default defineConfig({
  test: {
    globals: true,
    testTimeout: 10000,
    // Bootstrap the canonical release artifacts the publication/readiness
    // integration tests read, so `vitest run` is self-contained without the
    // heavy `pretest` -> `test:artifacts` chain. See the file header for the
    // two steps it intentionally skips.
    globalSetup: ['./tests/setup/ensure-release-artifacts.js'],
    include: ['tests/**/*.test.js'],
    exclude: [
      '**/node_modules/**',
      '**/.claude/**',
      '.archive/**',
      '.tmp-vitest/**',
      'memorybench/**',
    ],
  },
});
