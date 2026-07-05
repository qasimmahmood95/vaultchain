// Playwright config (PRD §B.4). P2 ships the setup/contract/workflow
// projects; ui (P3) and compliance (P4) arrive with their phases.
//
// Retries are 0: the API layers are deterministic by construction (simulator,
// no real network) and a retried pass would hide real races (PRD §B.6). The
// P3 UI project will carry its own retries.
//
// Parallelism: contract runs fully parallel. workflow owns every
// time-SENSITIVE assertion (the sim clock is platform-global state) and is
// executed serialized — `pnpm test` chains it with --workers=1 (DECISIONS.md
// D21/D22). CI splits the projects into separate jobs anyway (PRD §B.5).

import { defineConfig, devices } from '@playwright/test';
import { API_BASE } from './tests/fixtures/api-client.js';

export default defineConfig({
  testDir: 'tests',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: [['list'], ['html', { open: 'never' }], ['blob']],
  use: {
    baseURL: API_BASE,
    trace: 'on-first-retry',
  },
  webServer: {
    // Fresh DB + deterministic seed + server boot (scripts/test-serve.ts).
    command: 'pnpm test:serve',
    url: `${API_BASE}/health`,
    reuseExistingServer: !process.env.CI,
    timeout: 90_000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
  projects: [
    { name: 'setup', testDir: 'tests/fixtures', testMatch: /global\.setup\.ts/ },
    { name: 'contract', testDir: 'tests/contract', dependencies: ['setup'] },
    {
      name: 'workflow',
      testDir: 'tests/workflow',
      // Depends on contract so the two NEVER interleave in a single bare
      // invocation: contract's builder-driven clock jumps would race
      // workflow's time-sensitive assertions (same defect class as
      // CRITICAL-1). Fast iteration: --project=workflow --no-deps.
      dependencies: ['setup', 'contract'],
      // Serialization enforced HERE, not in npm scripts: the sim clock is
      // platform-global, and every invocation path (npx playwright test,
      // --project=workflow, IDE runners) must be safe (D21; P2 review
      // CRITICAL-1 — fullyParallel:false alone only serializes within a file).
      workers: 1,
      fullyParallel: false,
    },
    {
      name: 'ui',
      testDir: 'tests/ui',
      // Runs AFTER workflow (strict project pipeline): UI journeys share the
      // same global platform state, and one journey (hold release) uses the
      // screening queue. Serialized for the same reason workflow is.
      dependencies: ['setup', 'workflow'],
      workers: 1,
      fullyParallel: false,
      // The one legitimately timing-prone layer gets retries ON CI ONLY,
      // with traces for triage (PRD §B.6). Locally a flake must fail loudly.
      retries: process.env.CI ? 2 : 0,
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
