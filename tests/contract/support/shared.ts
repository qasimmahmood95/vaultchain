// Per-worker memoized clientA-tenant world for the authz matrix.
//
// Local helper (not a fixture — fixtures are frozen): the matrix probes one
// clientA-owned withdrawal from many roles, so the data is created ONCE per
// worker via the real API and reused by every row. Playwright runs tests
// sequentially within a worker, so the first test to ask builds it; later
// tests reuse the resolved handles (plain ids/strings — no live contexts).
//
// Everything here is DENIAL-probe material: 403/404 rows never mutate it.

import type { APIRequestContext } from '@playwright/test';
import { ApiClient, type Build, type ChainApi, type Identity } from '../../fixtures/index.js';
import { createWithdrawal } from './robust.js';

export interface SharedWorld {
  /** The SEEDED clientA tenant id (identities.clientA.clientId). */
  clientAId: string;
  /** Account under the seeded clientA tenant (built via the builders). */
  accountId: string;
  /** Funded GBPX wallet under that account. */
  walletId: string;
  /** ACTIVE allowlisted address on the account. */
  allowlistEntryId: string;
  address: string;
  /** PENDING_APPROVAL withdrawal, maker = operatorA, with an idempotencyKey (D19). */
  withdrawalId: string;
  idemKey: string;
  /** An (unfunded) GBPX wallet under the SEEDED clientB tenant — D19 probe. */
  walletBId: string;
  /** A seeded hold for role probes (403s never touch its state). */
  holdId: string;
}

let memo: Promise<SharedWorld> | undefined;

export function getShared(deps: {
  build: Build;
  chain: ChainApi;
  identities: Record<string, Identity>;
  asCompliance: APIRequestContext;
}): Promise<SharedWorld> {
  memo ??= create(deps);
  return memo;
}

async function create(deps: {
  build: Build;
  chain: ChainApi;
  identities: Record<string, Identity>;
  asCompliance: APIRequestContext;
}): Promise<SharedWorld> {
  const { build, chain, identities } = deps;
  const clientAId = identities['clientA']?.clientId;
  const clientBId = identities['clientB']?.clientId;
  if (!clientAId || !clientBId) {
    throw new Error('identities.clientA/clientB clientId missing — did the setup project run?');
  }

  // Tenant-isolation probes need data under the SEEDED clientA tenant, so the
  // builders are pointed at that clientId instead of a fresh fixture client.
  const funded = await build.fundedWallet({ clientId: clientAId }); // GBPX, 10000.00
  const addr = await build.activeAddress({ accountId: funded.accountId, asset: 'GBPX' });
  const idemKey = build.uniqueRef('idem-authz');
  const withdrawal = await createWithdrawal(
    build,
    chain,
    {
      walletId: funded.walletId,
      amount: '1500.00', // away from fee-rounding boundaries: fee is exactly 1.50 at 10 bps
      address: addr.address,
      idempotencyKey: idemKey,
    },
    addr.activatesAt,
  );

  // A clientB-tenant wallet (unfunded is enough): the D19 replay probe must
  // pass the route's own-wallet pre-check so the SERVICE's idempotency lookup
  // — where the tenant check lives — is the code under test.
  const accountB = await build.account({ clientId: clientBId, assets: ['GBPX'] });
  const walletB = accountB.wallets[0];
  if (!walletB) throw new Error('clientB probe account created without a wallet');

  // A SEEDED open hold for the segregation-of-duties rows. The 403 probes do
  // not mutate it, and this suite NEVER releases/rejects holds (workflow owns
  // positive hold flows on its own data).
  const compliance = new ApiClient(deps.asCompliance);
  type HoldPage = { items: Array<{ id: string }> };
  const open = await compliance.get<HoldPage>('/holds?state=OPEN&limit=1');
  let holdId = open.json.items?.[0]?.id;
  if (!holdId) {
    // Fall back to any hold: requireRole rejects before any state check, so
    // denial rows hold regardless of the hold's state.
    const any = await compliance.get<HoldPage>('/holds?limit=1');
    holdId = any.json.items?.[0]?.id;
  }
  if (!holdId) {
    throw new Error('No seeded compliance hold found — scripts/seed.ts is expected to create open holds');
  }

  return {
    clientAId,
    accountId: funded.accountId,
    walletId: funded.walletId,
    allowlistEntryId: addr.entryId,
    address: addr.address,
    withdrawalId: withdrawal.id,
    idemKey,
    walletBId: walletB.id,
    holdId,
  };
}
