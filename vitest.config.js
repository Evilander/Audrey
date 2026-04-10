import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    testTimeout: 10000,
    exclude: ['**/node_modules/**', '**/.claude/**', 'Audrey/**', 'Audrey-release/**', '.tmp-release-head-*/**', 'memorybench/**', 'python-sdk/**'],
  },
});
