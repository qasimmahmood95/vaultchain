// ---------------------------------------------------------------------------
// TEMPORARY LOCAL SHIM — FIXTURE GAP WORKAROUND (report filed with integrator)
// ---------------------------------------------------------------------------
// tests/fixtures/auth.fixtures.ts cannot LOAD under Playwright: workerRole()
// returns `async (_args, use) => …`, and Playwright requires a fixture
// function's first parameter to be an object-destructuring pattern —
// `base.extend()` throws "First argument must use the object destructuring
// pattern: _args" the moment the module is imported. Because
// tests/fixtures/index.ts re-exports world.fixture -> auth.fixtures, EVERY
// import of '../fixtures/index.js' fails at load time.
//
// tests/fixtures/** is FROZEN during P2b, so this suite composes its `test`
// locally instead: the frozen chain-clock fixture and builders are reused
// UNCHANGED (all domain/builder logic stays in fixtures/); only the
// role-context fixtures are re-declared here, with the destructured-`{}`
// signature Playwright requires, using the same deterministic keys from
// scripts/seed-lib.ts that the frozen fixture uses.
//
// UPSTREAM FIX (one line, in tests/fixtures/auth.fixtures.ts#workerRole):
//     async (_args, use) => {            // broken: identifier param
//     async ({}, use) => {               // fixed: destructuring pattern
// Once fixed, delete this file and point the suite back at
// '../fixtures/index.js' (this module mirrors its export surface).
// ---------------------------------------------------------------------------

import { mergeTests, request, test as base, type APIRequestContext } from '@playwright/test';
import { RAW_KEYS, clientKey } from '../../../scripts/seed-lib.js';
import { API_BASE } from '../../fixtures/api-client.js';
import { chainClockTest } from '../../fixtures/chain-clock.fixture.js';
import { makeBuilders, type Build } from '../../fixtures/builders/index.js';

interface AuthWorkerFixtures {
  /** ADMIN — full control incl. /simulator. */
  asAdmin: APIRequestContext;
  /** OPERATOR A — the default maker in tests. */
  asOperatorA: APIRequestContext;
  /** OPERATOR B — the default (distinct) checker. */
  asOperatorB: APIRequestContext;
  /** COMPLIANCE_OFFICER — the only role that may resolve holds. */
  asCompliance: APIRequestContext;
  /** CLIENT key tenant-bound to seed client #1 (parity with the frozen fixture). */
  asClientA: APIRequestContext;
  /** CLIENT key tenant-bound to seed client #2 (cross-tenant probes). */
  asClientB: APIRequestContext;
}

const KEYS: Record<keyof AuthWorkerFixtures, string> = {
  asAdmin: RAW_KEYS.admin,
  asOperatorA: RAW_KEYS.operatorA,
  asOperatorB: RAW_KEYS.operatorB,
  asCompliance: RAW_KEYS.compliance,
  asClientA: clientKey(1),
  asClientB: clientKey(2),
};

type WorkerFixtureTuple = [
  (args: Record<never, never>, use: (ctx: APIRequestContext) => Promise<void>) => Promise<void>,
  { scope: 'worker' },
];

function workerRole(name: keyof AuthWorkerFixtures): WorkerFixtureTuple {
  return [
    // NB: the first parameter MUST be a destructuring pattern ({}) — Playwright
    // rejects identifier params at load time (the very bug this shim fixes).
    async ({}, use) => {
      const ctx = await request.newContext({
        baseURL: API_BASE,
        extraHTTPHeaders: { 'x-api-key': KEYS[name] },
      });
      await use(ctx);
      await ctx.dispose();
    },
    { scope: 'worker' },
  ];
}

const authTest = base.extend<Record<never, never>, AuthWorkerFixtures>({
  asAdmin: workerRole('asAdmin'),
  asOperatorA: workerRole('asOperatorA'),
  asOperatorB: workerRole('asOperatorB'),
  asCompliance: workerRole('asCompliance'),
  asClientA: workerRole('asClientA'),
  asClientB: workerRole('asClientB'),
});

// Composition mirrors tests/fixtures/world.fixture.ts exactly.
export const test = mergeTests(authTest, chainClockTest).extend<{ build: Build }>({
  build: async ({ asAdmin, asOperatorA, chain }, use) => {
    await use(makeBuilders({ asAdmin, asOperatorA, chain }));
  },
});

export { expect } from '@playwright/test';

// Mirror the fixtures/index.ts export surface the suite consumes, so the
// eventual switch back is a one-line import change per file.
export { ApiClient, API_BASE, type ApiResult } from '../../fixtures/api-client.js';
export type { ChainApi, ChainState } from '../../fixtures/chain-clock.fixture.js';
export type {
  Build,
  AssetSymbol,
  ClientHandle,
  AccountHandle,
  FundedWalletHandle,
  AddressHandle,
  TxHandle,
} from '../../fixtures/builders/index.js';
export { PAST_COOLING_OFF_MS } from '../../fixtures/builders/index.js';
