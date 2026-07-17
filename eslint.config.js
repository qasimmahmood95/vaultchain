// ESLint flat config (PRD §B.5's `lint` job). DELIBERATELY MINIMAL: this is a
// late-project addition to a codebase written in strict TypeScript with hand
// formatting and no Prettier, so it enforces CORRECTNESS rules only and carries
// NO stylistic/formatting rules that would fight the existing hand layout.
//
// The one rule the project's flake policy specifically wants is
// `no-floating-promises` (§B.5): a missing `await` before a Playwright call is a
// latent race, exactly the class the API layers must never hide. That rule is
// type-aware, so this config enables the typescript-eslint project service.
//
// Where a recommended rule would force broad churn across src/ or tests/ this
// late, it is turned OFF here with a one-line rationale rather than mass-edited.

import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      'node_modules/',
      'dist/',
      'build/',
      'playwright-report/',
      'blob-report/',
      'all-blob-reports/',
      'test-results/',
      'prisma/migrations/',
      'tests/**/.auth/',
      'gate-summary.html',
      '.claude/', // agent definitions (markdown) + stale parallel-build worktrees
      'eslint.config.js', // self: not in tsconfig's project, and it has no runtime logic to lint
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // The load-bearing rule (§B.6/§B.5): an un-awaited promise before a
      // Playwright assertion or an async domain call is a real race.
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/await-thenable': 'error',

      // Respect the codebase's existing conventions rather than mass-editing:
      // an underscore prefix marks a deliberately-unused binding (e.g. the
      // `_reply` in a requireRole preHandler, `_result` in the reporter).
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      // `async ({}, use) => …` is the REQUIRED Playwright fixture idiom for "this
      // fixture uses no other fixtures" — an identifier first param is rejected at
      // extend() time. Allow the empty pattern as a parameter; still catch it in
      // destructuring assignments.
      'no-empty-pattern': ['error', { allowObjectPatternsAsParameters: true }],

      // --- Rules turned OFF to avoid broad late-project churn (documented) ---
      // The audit/webhook payloads and Prisma JSON columns are genuinely `unknown`
      // shaped; the code already narrows them at the boundaries. Enabling these
      // would force a sweep of assertions across serialize/audit/webhook paths for
      // no correctness gain — the strict zod contract layer already pins the shapes.
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
  {
    // The reporter, scripts, and perf runner emit human-readable output on
    // stdout by design.
    files: ['reporters/**/*.ts', 'scripts/**/*.ts', 'perf/**/*.ts'],
    rules: { 'no-console': 'off' },
  },
);
