// Contract: /accounts create/get/wallets, /wallets/{id}, and the allowlist
// endpoints (openapi/vaultchain.yaml, tag `accounts`). Includes the D18
// regression: an unknown asset symbol must fail request validation (400),
// never fall through to a handler 404.

import { test, ApiClient } from '../fixtures/index.js';
import { expect, expectProblem } from './support/matchers.js';
import {
  AccountSchema,
  AccountWithWalletsSchema,
  AllowlistedAddressSchema,
  WalletSchema,
  itemsOnly,
} from './schemas/index.js';

test('POST /accounts -> 201 AccountWithWallets (one wallet per listed asset)', async ({
  asOperatorA,
  build,
}) => {
  const client = await build.client();
  const res = await new ApiClient(asOperatorA).post('/accounts', {
    clientId: client.id,
    label: build.uniqueRef('contract-acct'),
    segregationModel: 'SEGREGATED',
    assets: ['GBPX', 'BTC'],
  });
  expect(res.status).toBe(201);
  expect(res.json).toMatchSchema(AccountWithWalletsSchema);
  const wallets = (res.json as { wallets: Array<{ assetSymbol: string }> }).wallets;
  expect(new Set(wallets.map((w) => w.assetSymbol))).toEqual(new Set(['GBPX', 'BTC']));
});

test('D18 regression: POST /accounts with an unknown asset symbol -> 400, NOT 404', async ({
  asOperatorA,
  build,
}) => {
  const client = await build.client(); // valid clientId isolates the enum violation
  const res = await new ApiClient(asOperatorA).post('/accounts', {
    clientId: client.id,
    label: build.uniqueRef('doge-acct'),
    segregationModel: 'SEGREGATED',
    assets: ['DOGE'],
  });
  // The spec's `assets` enum is [BTC, ETH, GBPX]: an unknown symbol is a
  // request-SHAPE failure. 404 here would mean the route schema drifted from
  // the contract again (DECISIONS.md D18).
  expect(res.status, 'unknown asset must fail validation (400), not reach the handler (404)').toBe(400);
  expectProblem(res, 400, 'D18');
});

test('POST /accounts for an unknown clientId -> 404 problem+json', async ({ asOperatorA, build }) => {
  const res = await new ApiClient(asOperatorA).post('/accounts', {
    clientId: build.uniqueRef('no-such-client'),
    label: build.uniqueRef('orphan-acct'),
    segregationModel: 'SEGREGATED',
    assets: ['GBPX'],
  });
  expectProblem(res, 404);
});

test('GET /accounts/{id} -> 200 Account', async ({ asOperatorA, build }) => {
  const account = await build.account({ assets: ['GBPX'] });
  const res = await new ApiClient(asOperatorA).get(`/accounts/${account.accountId}`);
  expect(res.status).toBe(200);
  expect(res.json).toMatchSchema(AccountSchema);
});

test('GET /accounts/{id}/wallets -> 200 {items: Wallet[]} with formatted balances', async ({
  asOperatorA,
  build,
}) => {
  const account = await build.account({ assets: ['GBPX', 'ETH'] });
  const res = await new ApiClient(asOperatorA).get(`/accounts/${account.accountId}/wallets`);
  expect(res.status).toBe(200);
  expect(res.json).toMatchSchema(itemsOnly(WalletSchema));
  expect((res.json as { items: unknown[] }).items).toHaveLength(2);
});

test('GET /wallets/{id} -> 200 Wallet', async ({ asOperatorA, build }) => {
  const account = await build.account({ assets: ['GBPX'] });
  const res = await new ApiClient(asOperatorA).get(`/wallets/${account.wallets[0]!.id}`);
  expect(res.status).toBe(200);
  expect(res.json).toMatchSchema(WalletSchema);
});

test('GET /accounts/{unknown} and /wallets/{unknown} -> 404 problem+json', async ({
  asOperatorA,
  build,
}) => {
  const api = new ApiClient(asOperatorA);
  expectProblem(await api.get(`/accounts/${build.uniqueRef('no-such-account')}`), 404, 'account');
  expectProblem(await api.get(`/wallets/${build.uniqueRef('no-such-wallet')}`), 404, 'wallet');
});

// --- Allowlist ---------------------------------------------------------------

test('POST /accounts/{id}/allowlist -> 201 AllowlistedAddress in PENDING (cooling-off)', async ({
  asOperatorA,
  build,
}) => {
  const account = await build.account({ assets: ['GBPX'] });
  const res = await new ApiClient(asOperatorA).post(`/accounts/${account.accountId}/allowlist`, {
    assetSymbol: 'GBPX',
    address: build.uniqueRef('ext-gbpx'),
    label: 'contract payout destination',
  });
  expect(res.status).toBe(201);
  expect(res.json).toMatchSchema(AllowlistedAddressSchema);
  // Snapshot of the CREATE response only: a new entry starts its cooling-off.
  // (Later effectiveStatus reads are clock-dependent — workflow territory.)
  expect((res.json as { status: string }).status).toBe('PENDING');
});

test('GET /accounts/{id}/allowlist -> 200 {items} including the new entry', async ({
  asOperatorA,
  build,
}) => {
  const account = await build.account({ assets: ['GBPX'] });
  const entry = await build.pendingAddress({ accountId: account.accountId, asset: 'GBPX' });
  const res = await new ApiClient(asOperatorA).get(`/accounts/${account.accountId}/allowlist`);
  expect(res.status).toBe(200);
  expect(res.json).toMatchSchema(itemsOnly(AllowlistedAddressSchema));
  const items = (res.json as { items: Array<{ id: string }> }).items;
  expect(items.map((i) => i.id)).toContain(entry.entryId);
});

test('DELETE /accounts/{id}/allowlist/{addrId} -> 204 with no body', async ({
  asOperatorA,
  build,
}) => {
  const account = await build.account({ assets: ['GBPX'] });
  const entry = await build.pendingAddress({ accountId: account.accountId, asset: 'GBPX' });
  const res = await new ApiClient(asOperatorA).delete(
    `/accounts/${account.accountId}/allowlist/${entry.entryId}`,
  );
  expect(res.status).toBe(204);
  expect(res.json).toEqual({}); // ApiClient maps an empty body to {}
});

test('DELETE /accounts/{id}/allowlist/{unknown} -> 404 problem+json', async ({
  asOperatorA,
  build,
}) => {
  const account = await build.account({ assets: ['GBPX'] });
  const res = await new ApiClient(asOperatorA).delete(
    `/accounts/${account.accountId}/allowlist/${build.uniqueRef('no-such-entry')}`,
  );
  expectProblem(res, 404);
});

test('POST /accounts/{id}/allowlist with a malformed body -> 400 problem+json', async ({
  asOperatorA,
  build,
}) => {
  const account = await build.account({ assets: ['GBPX'] });
  // address below minLength 4: request-shape validation failure.
  const res = await new ApiClient(asOperatorA).post(`/accounts/${account.accountId}/allowlist`, {
    assetSymbol: 'GBPX',
    address: 'ab',
    label: 'too short',
  });
  expectProblem(res, 400);
});

test('D18 regression (2nd occurrence): allowlist with an unknown asset symbol -> 400, NOT 404', async ({
  asOperatorA,
  build,
}) => {
  const account = await build.account({ assets: ['GBPX'] });
  // The spec's allowlist assetSymbol enum is [BTC, ETH, GBPX]: an unknown
  // symbol is a request-SHAPE failure. Found by the P2b contract agent as a
  // second instance of the D18 drift class; route schema aligned to the spec.
  const res = await new ApiClient(asOperatorA).post(`/accounts/${account.accountId}/allowlist`, {
    assetSymbol: 'DOGE',
    address: build.uniqueRef('ext-doge'),
    label: 'unknown asset',
  });
  expect(res.status, 'unknown asset must fail validation (400), not reach the handler (404)').toBe(400);
  expectProblem(res, 400, 'D18');
});
