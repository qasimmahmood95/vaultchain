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

import { defineConfig } from '@playwright/test';
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
      dependencies: ['setup'],
      // Belt-and-braces: within-file serial even if someone runs this project
      // with more than one worker. The npm script enforces --workers=1.
      fullyParallel: false,
    },
  ],
});
