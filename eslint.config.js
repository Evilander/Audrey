import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';
import globals from 'globals';

// Vitest injects these into the global scope when `test.globals` is enabled
// (see vitest.config.js). Most test files import them explicitly, but a few
// rely on the globals, so the test override declares them.
const vitestGlobals = {
  describe: 'readonly',
  it: 'readonly',
  test: 'readonly',
  expect: 'readonly',
  vi: 'readonly',
  beforeAll: 'readonly',
  afterAll: 'readonly',
  beforeEach: 'readonly',
  afterEach: 'readonly',
};

export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      '.tmp-vitest/**',
      '.tmp/**',
      '.archive/**',
      '.worktrees/**',
      'coverage/**',
      'benchmarks/output/**',
      'benchmarks/.tmp/**',
      'benchmarks/.tmp-guardbench/**',
      'docs/paper/output/**',
      'python/**',
    ],
  },

  // Type-checked linting for the shipped TypeScript surface. This is where the
  // high-value correctness rules (no-floating-promises, no-misused-promises)
  // earn their keep on an async-heavy codebase.
  {
    files: ['src/**/*.ts', 'mcp-server/**/*.ts'],
    extends: [js.configs.recommended, ...tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
      globals: { ...globals.node },
    },
    rules: {
      // Audrey deliberately declares `async` functions that contain no `await`
      // because their signatures are fixed by an interface or runtime contract:
      // the EmbeddingProvider / LLMProvider provider interfaces, the MCP SDK's
      // async tool handlers, and Audrey's own Promise-returning public API
      // (e.g. `promote`). `require-await` directly penalizes that conformance.
      // A genuine forgotten `await` is still caught by `no-floating-promises`
      // and `await-thenable`, which remain enabled.
      '@typescript-eslint/require-await': 'off',
      // The codebase uses `_`-prefixed identifiers to mark intentional
      // throwaways (e.g. `_db`, destructured-and-ignored fields).
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          ignoreRestSiblings: true,
        },
      ],
    },
  },

  // Tests, benchmarks, scripts, examples, and root config files are plain ESM
  // JavaScript. Lint them for correctness only (no type information), with Node
  // and Vitest globals available.
  {
    files: [
      'tests/**/*.js',
      'benchmarks/**/*.{js,mjs}',
      'scripts/**/*.{js,mjs}',
      'examples/**/*.js',
      '*.js',
      '*.mjs',
    ],
    extends: [js.configs.recommended],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.node, ...vitestGlobals },
    },
    rules: {
      'no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          ignoreRestSiblings: true,
        },
      ],
    },
  },

  // Keep ESLint out of Prettier's lane: disable all formatting-related rules so
  // formatting is owned exclusively by `npm run format`. Must stay last.
  prettier,
);
