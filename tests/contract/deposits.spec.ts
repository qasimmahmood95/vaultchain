// Contract: POST /wallets/{id}/deposits/simulate (openapi/vaultchain.yaml,
// tag `deposits`) — 201 shape plus the 400/404/409/422 error contract.

import { test, ApiClient } from '../fixtures/index.js';
import { expect, expectProblem } from './support/matchers.js';
import { TransactionSchema } from './schemas/index.js';

test('POST /wallets/{id}/deposits/simulate -> 201 Transaction (PENDING_CONFIRMATION)', async ({
  asOperatorA,
  build,
}) => {
  const account = await build.account({ assets: ['GBPX'] });
  const res = await new ApiClient(asOperatorA).post(
    `/wallets/${account.wallets[0]!.id}/deposits/simulate`,
    { amount: '250.00', chainTxRef: build.uniqueRef('dep-contract') },
  );
  expect(res.status).toBe(201);
  expect(res.json).toMatchSchema(TransactionSchema);
  const tx = res.json as { type: string; state: string; assetSymbol: string };
  expect(tx.type).toBe('DEPOSIT');
  expect(tx.state).toBe('PENDING_CONFIRMATION');
  expect(tx.assetSymbol).toBe('GBPX');
});

test('duplicate chainTxRef on the same wallet -> 409 problem+json', async ({
  asOperatorA,
  build,
}) => {
  const account = await build.account({ assets: ['GBPX'] });
  const api = new ApiClient(asOperatorA);
  const walletId = account.wallets[0]!.id;
  const chainTxRef = build.uniqueRef('dep-dup');

  const first = await api.post(`/wallets/${walletId}/deposits/simulate`, { amount: '250.00', chainTxRef });
  expect(first.status).toBe(201);

  const second = await api.post(`/wallets/${walletId}/deposits/simulate`, { amount: '250.00', chainTxRef });
  expectProblem(second, 409, 'duplicate chainTxRef');
});

test('malformed amount -> 400 problem+json (request-shape validation)', async ({
  asOperatorA,
  build,
}) => {
  const account = await build.account({ assets: ['GBPX'] });
  const res = await new ApiClient(asOperatorA).post(
    `/wallets/${account.wallets[0]!.id}/deposits/simulate`,
    { amount: 'not-a-number', chainTxRef: build.uniqueRef('dep-bad') },
  );
  expectProblem(res, 400);
});

test('zero amount -> 422 problem+json (semantically invalid)', async ({ asOperatorA, build }) => {
  const account = await build.account({ assets: ['GBPX'] });
  const res = await new ApiClient(asOperatorA).post(
    `/wallets/${account.wallets[0]!.id}/deposits/simulate`,
    { amount: '0', chainTxRef: build.uniqueRef('dep-zero') },
  );
  expectProblem(res, 422);
});

test('deposit to an unknown wallet -> 404 problem+json', async ({ asOperatorA, build }) => {
  const res = await new ApiClient(asOperatorA).post(
    `/wallets/${build.uniqueRef('no-such-wallet')}/deposits/simulate`,
    { amount: '250.00', chainTxRef: build.uniqueRef('dep-orphan') },
  );
  expectProblem(res, 404);
});
