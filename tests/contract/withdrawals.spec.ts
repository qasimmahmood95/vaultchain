// Contract: /withdrawals create/list/get/approvals/cancel/travel-rule
// (openapi/vaultchain.yaml, tag `withdrawals`) — happy-path shapes plus the
// 400/404/409/422 error contract.
//
// Value discipline: amounts sit AWAY from fee-rounding boundaries (1500.00
// GBPX -> fee exactly 1.50 at 10 bps). Boundary probes belong to workflow.
// Travel-Rule THRESHOLD boundary values are P4 territory — 1500.00 here only
// exercises the endpoint's response shape.

import { test, ApiClient, type Build } from '../fixtures/index.js';
import { expect, expectProblem } from './support/matchers.js';
import { createWithdrawal, postWithdrawal } from './support/robust.js';
import { page, TransactionSchema, WithdrawalDetailSchema } from './schemas/index.js';

/** Fresh funded GBPX wallet + ACTIVE allowlisted address (own data per test). */
async function withdrawalWorld(build: Build) {
  const funded = await build.fundedWallet(); // GBPX, 10000.00
  const addr = await build.activeAddress({ accountId: funded.accountId, asset: 'GBPX' });
  return { funded, addr };
}

test('POST /withdrawals -> 201 Transaction in PENDING_APPROVAL', async ({
  asOperatorA,
  build,
  chain,
}) => {
  const { funded, addr } = await withdrawalWorld(build);
  const res = await postWithdrawal(
    new ApiClient(asOperatorA),
    chain,
    { walletId: funded.walletId, amount: '1500.00', counterpartyAddress: addr.address },
    addr.activatesAt,
  );
  expect(res.status).toBe(201);
  expect(res.json).toMatchSchema(TransactionSchema);
  const tx = res.json as { type: string; state: string; fee: string };
  expect(tx.type).toBe('WITHDRAWAL');
  expect(tx.state).toBe('PENDING_APPROVAL');
});

test('idempotent replay -> 200 with the SAME withdrawal returned', async ({
  asOperatorA,
  build,
  chain,
}) => {
  const { funded, addr } = await withdrawalWorld(build);
  const api = new ApiClient(asOperatorA);
  const body = {
    walletId: funded.walletId,
    amount: '1500.00',
    counterpartyAddress: addr.address,
    idempotencyKey: build.uniqueRef('idem-replay'),
  };

  const created = await postWithdrawal(api, chain, body, addr.activatesAt);
  expect(created.status).toBe(201);

  const replayed = await api.post('/withdrawals', body);
  expect(replayed.status, 'replay returns 200, not 201').toBe(200);
  expect(replayed.json).toMatchSchema(TransactionSchema);
  expect((replayed.json as { id: string }).id).toBe((created.json as { id: string }).id);
});

test('GET /withdrawals?walletId= -> 200 page envelope of Transaction', async ({
  asOperatorA,
  build,
  chain,
}) => {
  const { funded, addr } = await withdrawalWorld(build);
  const created = await createWithdrawal(build, chain, {
    walletId: funded.walletId,
    amount: '1500.00',
    address: addr.address,
  }, addr.activatesAt);
  const res = await new ApiClient(asOperatorA).get(`/withdrawals?walletId=${funded.walletId}`);
  expect(res.status).toBe(200);
  expect(res.json).toMatchSchema(page(TransactionSchema));
  const items = (res.json as { items: Array<{ id: string }> }).items;
  expect(items.map((i) => i.id)).toContain(created.id);
});

test('GET /withdrawals/{id} -> 200 WithdrawalDetail (approvals + travelRule arrays)', async ({
  asOperatorA,
  build,
  chain,
}) => {
  const { funded, addr } = await withdrawalWorld(build);
  const created = await createWithdrawal(build, chain, {
    walletId: funded.walletId,
    amount: '1500.00',
    address: addr.address,
  }, addr.activatesAt);
  const res = await new ApiClient(asOperatorA).get(`/withdrawals/${created.id}`);
  expect(res.status).toBe(200);
  expect(res.json).toMatchSchema(WithdrawalDetailSchema);
  const detail = res.json as { approvals: unknown[]; travelRule: unknown[] };
  expect(detail.approvals).toEqual([]); // fresh withdrawal: no decisions yet
  expect(detail.travelRule).toEqual([]);
});

test('POST /withdrawals/{id}/approvals (distinct checker) -> 201 Transaction; detail lists the decision', async ({
  asOperatorA,
  asOperatorB,
  build,
  chain,
  identities,
}) => {
  const { funded, addr } = await withdrawalWorld(build);
  const created = await createWithdrawal(build, chain, {
    walletId: funded.walletId,
    amount: '1500.00',
    address: addr.address,
  }, addr.activatesAt);

  // Maker is operatorA (builder contract); operatorB is the distinct checker.
  const res = await new ApiClient(asOperatorB).post(`/withdrawals/${created.id}/approvals`, {
    decision: 'APPROVE',
  });
  expect(res.status).toBe(201);
  expect(res.json).toMatchSchema(TransactionSchema);

  const detail = await new ApiClient(asOperatorA).get(`/withdrawals/${created.id}`);
  expect(detail.status).toBe(200);
  expect(detail.json).toMatchSchema(WithdrawalDetailSchema);
  const approvals = (detail.json as { approvals: Array<{ approverApiKeyId: string; decision: string }> })
    .approvals;
  expect(approvals).toHaveLength(1);
  expect(approvals[0]!.approverApiKeyId).toBe(identities['operatorB']!.apiKeyId);
  expect(approvals[0]!.decision).toBe('APPROVE');
});

test('POST /withdrawals/{id}/cancel -> 200 CANCELLED; approvals afterwards -> 409', async ({
  asOperatorA,
  asOperatorB,
  build,
  chain,
}) => {
  const { funded, addr } = await withdrawalWorld(build);
  const created = await createWithdrawal(build, chain, {
    walletId: funded.walletId,
    amount: '1500.00',
    address: addr.address,
  }, addr.activatesAt);

  const cancelled = await new ApiClient(asOperatorA).post(`/withdrawals/${created.id}/cancel`);
  expect(cancelled.status).toBe(200);
  expect(cancelled.json).toMatchSchema(TransactionSchema);
  expect((cancelled.json as { state: string }).state).toBe('CANCELLED');

  // State conflict (approvals closed) — NOT the duplicate-approval case (P4).
  const late = await new ApiClient(asOperatorB).post(`/withdrawals/${created.id}/approvals`, {
    decision: 'APPROVE',
  });
  expectProblem(late, 409, 'approvals closed after cancel');
});

test('POST /withdrawals/{id}/travel-rule -> 201 Transaction; detail lists both records', async ({
  asCompliance,
  asOperatorA,
  build,
  chain,
}) => {
  const { funded, addr } = await withdrawalWorld(build);
  const created = await createWithdrawal(build, chain, {
    walletId: funded.walletId,
    amount: '1500.00', // above-threshold amount only exercises the SHAPE (boundaries are P4)
    address: addr.address,
    vaspId: build.uniqueRef('vasp-counterparty'),
  }, addr.activatesAt);

  const res = await new ApiClient(asCompliance).post(`/withdrawals/${created.id}/travel-rule`, {
    originator: {
      name: 'Aldgate Digital Partners LLP (fictional)',
      accountRef: funded.walletId,
      physicalAddress: '1 Mock Lane, London (fictional)',
    },
    beneficiary: { name: 'Far Side Custody GmbH (fictional)', accountRef: addr.address },
  });
  expect(res.status).toBe(201);
  expect(res.json).toMatchSchema(TransactionSchema);

  const detail = await new ApiClient(asOperatorA).get(`/withdrawals/${created.id}`);
  expect(detail.json).toMatchSchema(WithdrawalDetailSchema);
  const directions = (detail.json as { travelRule: Array<{ direction: string }> }).travelRule.map(
    (r) => r.direction,
  );
  expect(directions.sort()).toEqual(['BENEFICIARY', 'ORIGINATOR']);
});

test('travel-rule originator with neither physicalAddress nor dateOfBirth -> 422', async ({
  asOperatorA,
  build,
  chain,
}) => {
  const { funded, addr } = await withdrawalWorld(build);
  const created = await createWithdrawal(build, chain, {
    walletId: funded.walletId,
    amount: '1500.00',
    address: addr.address,
    vaspId: build.uniqueRef('vasp-counterparty'),
  }, addr.activatesAt);
  const res = await new ApiClient(asOperatorA).post(`/withdrawals/${created.id}/travel-rule`, {
    originator: { name: 'No Address Given (fictional)', accountRef: funded.walletId },
    beneficiary: { name: 'Far Side Custody GmbH (fictional)', accountRef: addr.address },
  });
  expectProblem(res, 422, 'originator incomplete');
});

test('semantic rejections -> 422 problem+json (scale, below-minimum, not allowlisted)', async ({
  asOperatorA,
  build,
}) => {
  const { funded, addr } = await withdrawalWorld(build);
  const api = new ApiClient(asOperatorA);

  // 3 dp on GBPX (decimals=2): passes the request pattern, fails semantically.
  const badScale = await api.post('/withdrawals', {
    walletId: funded.walletId,
    amount: '10.123',
    counterpartyAddress: addr.address,
  });
  expectProblem(badScale, 422, 'amount scale');

  // Below the GBPX minimum withdrawal (1.00).
  const belowMin = await api.post('/withdrawals', {
    walletId: funded.walletId,
    amount: '0.50',
    counterpartyAddress: addr.address,
  });
  expectProblem(belowMin, 422, 'below minimum');

  // Never-allowlisted counterparty address.
  const notAllowlisted = await api.post('/withdrawals', {
    walletId: funded.walletId,
    amount: '1500.00',
    counterpartyAddress: build.uniqueRef('never-allowlisted'),
  });
  expectProblem(notAllowlisted, 422, 'address not allowlisted');
});

test('POST /withdrawals with a malformed body -> 400 problem+json', async ({
  asOperatorA,
  build,
}) => {
  const { funded } = await withdrawalWorld(build);
  // amount missing entirely: request-shape validation failure.
  const res = await new ApiClient(asOperatorA).post('/withdrawals', {
    walletId: funded.walletId,
    counterpartyAddress: 'ext-somewhere',
  });
  expectProblem(res, 400);
});

test('GET /withdrawals/{unknown} -> 404 problem+json', async ({ asOperatorA, build }) => {
  const res = await new ApiClient(asOperatorA).get(`/withdrawals/${build.uniqueRef('no-such-wd')}`);
  expectProblem(res, 404);
});
