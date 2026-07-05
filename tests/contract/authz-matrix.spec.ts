// AUTHZ MATRIX (PRD §B.3 / DECISIONS D19): a data-driven role x endpoint table
// asserting EXACT statuses.
//
// Conventions encoded here:
//   - Role denial is 403 with a Problem body (requireRole allowlists).
//   - Cross-tenant reads are 404, never 403: existence is not leaked.
//   - Missing X-Api-Key is 401 with a Problem body ("anon" rows).
//   - Segregation of duties: ONLY COMPLIANCE_OFFICER resolves holds — probed
//     against a SEEDED hold that the denial rows cannot mutate. This suite
//     never releases/rejects a hold (workflow owns positive hold flows).
//   - Maker-cannot-check: the maker's own approval is 403.
//   - D19: idempotency-key replays are tenant-scoped (404 cross-tenant,
//     200 + same id within the tenant).
//
// Every row is written to be non-mutating: denial rows are rejected before the
// handler runs, and the only 2xx rows are reads. Positive mutating shapes live
// in the per-endpoint response-shape specs.

import { randomUUID } from 'node:crypto';
import type { APIRequestContext } from '@playwright/test';
import { test, ApiClient } from '../fixtures/index.js';
import { expect, expectProblem } from './support/matchers.js';
import { TransactionSchema } from './schemas/index.js';
import { getShared, type SharedWorld } from './support/shared.js';

type RoleName = 'admin' | 'operatorA' | 'operatorB' | 'compliance' | 'clientA' | 'clientB' | 'anon';

interface Probe {
  /** Row label, e.g. "POST /holds/{id}/release". */
  endpoint: string;
  method: 'GET' | 'POST' | 'DELETE';
  path: (s: SharedWorld) => string;
  /** Valid request body (Fastify validates BEFORE preHandler role checks). */
  body?: (s: SharedWorld) => unknown;
  cases: ReadonlyArray<readonly [RoleName, number]>;
  note?: string;
}

const PROBES: Probe[] = [
  // --- clients ---------------------------------------------------------------
  {
    endpoint: 'POST /clients',
    method: 'POST',
    path: () => '/clients',
    body: () => ({ legalName: 'AuthZ probe (fictional)', type: 'INSTITUTION', jurisdiction: 'GB' }),
    cases: [
      ['operatorA', 403],
      ['compliance', 403],
      ['clientA', 403],
      ['anon', 401],
    ],
    note: 'ADMIN-only create (positive 201 lives in clients.spec)',
  },
  {
    endpoint: 'GET /clients',
    method: 'GET',
    path: () => '/clients?limit=1',
    cases: [
      ['admin', 200],
      ['operatorA', 200],
      ['compliance', 200],
      ['clientA', 200],
      ['anon', 401],
    ],
  },
  {
    endpoint: 'GET /clients/{clientA}',
    method: 'GET',
    path: (s) => `/clients/${s.clientAId}`,
    cases: [
      ['clientA', 200],
      ['clientB', 404], // tenant isolation: existence is not leaked
      ['operatorA', 200],
      ['admin', 200],
    ],
  },

  // --- accounts / wallets ----------------------------------------------------
  {
    endpoint: 'POST /accounts',
    method: 'POST',
    path: () => '/accounts',
    body: (s) => ({
      clientId: s.clientAId,
      label: `authz-probe-${randomUUID()}`,
      segregationModel: 'SEGREGATED',
      assets: ['GBPX'],
    }),
    cases: [
      ['clientA', 403],
      ['clientB', 403],
      ['compliance', 403],
      ['anon', 401],
    ],
  },
  {
    endpoint: 'GET /accounts/{clientA-account}',
    method: 'GET',
    path: (s) => `/accounts/${s.accountId}`,
    cases: [
      ['clientA', 200],
      ['clientB', 404],
      ['operatorA', 200],
      ['compliance', 200],
      ['anon', 401],
    ],
  },
  {
    endpoint: 'GET /accounts/{clientA-account}/wallets',
    method: 'GET',
    path: (s) => `/accounts/${s.accountId}/wallets`,
    cases: [
      ['clientA', 200],
      ['clientB', 404],
      ['operatorA', 200],
    ],
  },
  {
    endpoint: 'GET /wallets/{clientA-wallet}',
    method: 'GET',
    path: (s) => `/wallets/${s.walletId}`,
    cases: [
      ['clientA', 200],
      ['clientB', 404],
      ['operatorA', 200],
    ],
  },
  {
    endpoint: 'POST /accounts/{id}/allowlist',
    method: 'POST',
    path: (s) => `/accounts/${s.accountId}/allowlist`,
    body: () => ({ assetSymbol: 'GBPX', address: `authz-${randomUUID()}`, label: 'authz probe' }),
    cases: [
      ['clientA', 403],
      ['clientB', 403],
      ['compliance', 403],
      ['anon', 401],
    ],
  },
  {
    endpoint: 'DELETE /accounts/{id}/allowlist/{addrId}',
    method: 'DELETE',
    path: (s) => `/accounts/${s.accountId}/allowlist/${s.allowlistEntryId}`,
    cases: [
      ['clientA', 403],
      ['compliance', 403],
    ],
    note: 'denials only — an allowed role would remove the shared address',
  },

  // --- deposits ----------------------------------------------------------------
  {
    endpoint: 'POST /wallets/{id}/deposits/simulate',
    method: 'POST',
    path: (s) => `/wallets/${s.walletId}/deposits/simulate`,
    body: () => ({ amount: '250.00', chainTxRef: `authz-dep-${randomUUID()}` }),
    cases: [
      ['clientA', 403],
      ['clientB', 403],
      ['compliance', 403],
      ['anon', 401],
    ],
  },

  // --- withdrawals -------------------------------------------------------------
  {
    endpoint: 'POST /withdrawals (clientA-owned wallet)',
    method: 'POST',
    path: () => '/withdrawals',
    body: (s) => ({ walletId: s.walletId, amount: '1500.00', counterpartyAddress: s.address }),
    cases: [
      ['compliance', 403], // COMPLIANCE_OFFICER may not create withdrawals
      ['clientB', 404], // tenant isolation on create: wallet existence not leaked
      ['anon', 401],
    ],
  },
  {
    endpoint: 'GET /withdrawals',
    method: 'GET',
    path: () => '/withdrawals?limit=1',
    cases: [
      ['clientA', 200],
      ['clientB', 200],
      ['compliance', 200],
      ['anon', 401],
    ],
  },
  {
    endpoint: 'GET /withdrawals/{clientA-withdrawal}',
    method: 'GET',
    path: (s) => `/withdrawals/${s.withdrawalId}`,
    cases: [
      ['clientA', 200],
      ['clientB', 404],
      ['operatorA', 200],
      ['compliance', 200],
    ],
  },
  {
    endpoint: 'POST /withdrawals/{id}/approvals',
    method: 'POST',
    path: (s) => `/withdrawals/${s.withdrawalId}/approvals`,
    body: () => ({ decision: 'APPROVE' }),
    cases: [
      ['clientA', 403],
      ['clientB', 403],
      ['compliance', 403],
      ['operatorA', 403], // MAKER-CANNOT-CHECK: operatorA created it
      ['anon', 401],
    ],
    note: 'no allowed-role row — a real decision would mutate the shared withdrawal',
  },
  {
    endpoint: 'POST /withdrawals/{id}/cancel',
    method: 'POST',
    path: (s) => `/withdrawals/${s.withdrawalId}/cancel`,
    cases: [
      ['compliance', 403],
      ['clientB', 404], // tenant isolation before any cancel semantics
      ['anon', 401],
    ],
  },
  {
    endpoint: 'POST /withdrawals/{id}/travel-rule',
    method: 'POST',
    path: (s) => `/withdrawals/${s.withdrawalId}/travel-rule`,
    body: () => ({
      originator: { name: 'AuthZ probe (fictional)', accountRef: 'ref-1', physicalAddress: '1 Mock Lane' },
      beneficiary: { name: 'AuthZ probe beneficiary (fictional)', accountRef: 'ref-2' },
    }),
    cases: [
      ['clientA', 403],
      ['clientB', 403],
      ['anon', 401],
    ],
  },

  // --- holds (segregation of duties) --------------------------------------------
  {
    endpoint: 'GET /holds',
    method: 'GET',
    path: () => '/holds?limit=1',
    cases: [
      ['clientA', 403],
      ['clientB', 403],
      ['operatorA', 200],
      ['compliance', 200],
      ['admin', 200],
      ['anon', 401],
    ],
  },
  {
    endpoint: 'GET /holds/{seeded}',
    method: 'GET',
    path: (s) => `/holds/${s.holdId}`,
    cases: [
      ['clientA', 403],
      ['compliance', 200],
      ['operatorA', 200],
    ],
  },
  {
    endpoint: 'POST /holds/{id}/release',
    method: 'POST',
    path: (s) => `/holds/${s.holdId}/release`,
    cases: [
      ['clientA', 403],
      ['clientB', 403],
      ['operatorA', 403],
      ['operatorB', 403],
      ['admin', 403], // even ADMIN may not resolve holds — compliance only
      ['anon', 401],
    ],
    note: 'COMPLIANCE_OFFICER is deliberately absent: a 200 would resolve the seeded hold',
  },
  {
    endpoint: 'POST /holds/{id}/reject',
    method: 'POST',
    path: (s) => `/holds/${s.holdId}/reject`,
    cases: [
      ['clientA', 403],
      ['operatorA', 403],
      ['admin', 403],
      ['anon', 401],
    ],
  },

  // --- audit ---------------------------------------------------------------------
  {
    endpoint: 'GET /audit',
    method: 'GET',
    path: () => '/audit?limit=1',
    cases: [
      ['clientA', 403],
      ['operatorA', 403],
      ['compliance', 200],
      ['admin', 200],
      ['anon', 401],
    ],
  },

  // --- webhooks --------------------------------------------------------------------
  {
    endpoint: 'POST /webhooks/subscriptions',
    method: 'POST',
    path: () => '/webhooks/subscriptions',
    body: () => ({
      url: `https://hooks.example/authz-${randomUUID()}`,
      secret: 'authz-probe-secret',
      events: ['hold.opened'],
    }),
    cases: [
      ['clientA', 403],
      ['compliance', 403],
      ['anon', 401],
    ],
  },
  {
    endpoint: 'GET /webhooks/subscriptions',
    method: 'GET',
    path: () => '/webhooks/subscriptions',
    cases: [
      ['clientA', 403],
      ['compliance', 403],
      ['operatorA', 200],
    ],
  },
  {
    endpoint: 'GET /webhooks/deliveries',
    method: 'GET',
    path: () => '/webhooks/deliveries?event=hold.opened',
    cases: [
      ['clientA', 403],
      ['compliance', 403],
      ['operatorA', 200],
    ],
  },

  // --- simulator (ADMIN-only control plane) -------------------------------------------
  {
    endpoint: 'GET /simulator/state',
    method: 'GET',
    path: () => '/simulator/state',
    cases: [
      ['operatorA', 403],
      ['clientA', 403],
      ['compliance', 403],
      ['admin', 200],
      ['anon', 401],
    ],
  },
  {
    endpoint: 'POST /simulator/chain/advance',
    method: 'POST',
    path: () => '/simulator/chain/advance',
    body: () => ({ blocks: 1 }),
    cases: [
      ['operatorA', 403],
      ['clientA', 403],
    ],
  },
  {
    endpoint: 'POST /simulator/clock/set',
    method: 'POST',
    path: () => '/simulator/clock/set',
    // A far-FORWARD value: even if a broken guard let it through, the global
    // clock convention (forward-only, D22) would survive.
    body: () => ({ ms: '9999999999999' }),
    cases: [
      ['operatorA', 403],
      ['clientA', 403],
    ],
  },
  {
    endpoint: 'POST /simulator/clock/advance',
    method: 'POST',
    // The D26 relative-advance endpoint is ADMIN-only like every other
    // simulator route — pin the denial (P3 review Minor 1). Relative + tiny,
    // so a broken guard letting it through can't disrupt other tests.
    path: () => '/simulator/clock/advance',
    body: () => ({ ms: '1000' }),
    cases: [
      ['operatorA', 403],
      ['clientA', 403],
    ],
  },
  {
    endpoint: 'POST /simulator/screening/next',
    method: 'POST',
    path: () => '/simulator/screening/next',
    body: () => ({ outcome: 'CLEAN' }), // safe default, were the guard ever broken
    cases: [
      ['operatorA', 403],
      ['clientA', 403],
      ['compliance', 403],
    ],
  },
  {
    endpoint: 'POST /simulator/webhooks/delay',
    method: 'POST',
    path: () => '/simulator/webhooks/delay',
    body: () => ({ ms: '0' }), // safe default, were the guard ever broken
    cases: [
      ['operatorA', 403],
      ['clientA', 403],
    ],
  },
  {
    endpoint: 'POST /simulator/reset',
    method: 'POST',
    path: () => '/simulator/reset',
    cases: [
      ['operatorA', 403],
      ['clientA', 403],
      ['compliance', 403],
      ['anon', 401],
    ],
  },
];

for (const probe of PROBES) {
  for (const [role, expected] of probe.cases) {
    test(`${probe.endpoint} as ${role} -> ${expected}`, async ({
      asAdmin,
      asOperatorA,
      asOperatorB,
      asCompliance,
      asClientA,
      asClientB,
      request,
      build,
      chain,
      identities,
    }) => {
      const shared = await getShared({ build, chain, identities, asCompliance });
      const contexts: Record<RoleName, APIRequestContext> = {
        admin: asAdmin,
        operatorA: asOperatorA,
        operatorB: asOperatorB,
        compliance: asCompliance,
        clientA: asClientA,
        clientB: asClientB,
        anon: request, // built-in context: no X-Api-Key header
      };
      const api = new ApiClient(contexts[role]);
      const path = probe.path(shared);
      const res =
        probe.method === 'GET'
          ? await api.get(path)
          : probe.method === 'DELETE'
            ? await api.delete(path)
            : await api.post(path, probe.body?.(shared));

      if (expected >= 400) {
        // Every denial is an RFC 9457 problem with the exact status.
        expectProblem(res, expected, `${probe.endpoint} as ${role}`);
      } else {
        expect(res.status, `${probe.endpoint} as ${role}`).toBe(expected);
      }
    });
  }
}

// --- D19 regression: idempotent replays are tenant-scoped -----------------------

test('D19: POST /withdrawals replay with a foreign idempotencyKey -> 404 for the other tenant', async ({
  asClientB,
  asCompliance,
  build,
  chain,
  identities,
}) => {
  const shared = await getShared({ build, chain, identities, asCompliance });
  // operatorA created shared.withdrawalId on a clientA-tenant wallet using
  // shared.idemKey. clientB replays the SAME key against its OWN wallet, so
  // the request passes the route's own-wallet pre-check and the SERVICE's
  // idempotency lookup — where D19's tenant check lives — is what answers:
  // 404, never another tenant's withdrawal by key.
  const res = await new ApiClient(asClientB).post('/withdrawals', {
    walletId: shared.walletBId,
    amount: '1500.00',
    counterpartyAddress: shared.address,
    idempotencyKey: shared.idemKey,
  });
  expectProblem(res, 404, 'cross-tenant idempotency replay');
});

test('D19: the same replay as clientA -> 200 with the SAME withdrawal id', async ({
  asClientA,
  asCompliance,
  build,
  chain,
  identities,
}) => {
  const shared = await getShared({ build, chain, identities, asCompliance });
  const res = await new ApiClient(asClientA).post('/withdrawals', {
    walletId: shared.walletId,
    amount: '1500.00',
    counterpartyAddress: shared.address,
    idempotencyKey: shared.idemKey,
  });
  expect(res.status, 'in-tenant replay returns the existing withdrawal').toBe(200);
  expect(res.json).toMatchSchema(TransactionSchema);
  expect((res.json as { id: string }).id).toBe(shared.withdrawalId);
});
