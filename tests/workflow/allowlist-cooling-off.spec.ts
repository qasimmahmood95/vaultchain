// Allowlist cooling-off (PRD §A.1, DECISIONS.md D9): a newly allowlisted
// address is unusable for 24h of SIM-CLOCK time. The window is crossed via
// chain.advanceClockMs — never by waiting — and the "still inside the window"
// assertion is safe because this project runs serialized (D21).
//
// The 422-inside-the-window assertion is this suite's defence for the
// cooling-off control: precise on status AND problem type.

import { test, expect, ApiClient, PAST_COOLING_OFF_MS } from '../fixtures/index.js';
import { walletBalance, type ProblemResponse, type TxResponse } from './support/helpers.js';

test.describe('allowlist cooling-off', () => {
  test('withdrawal inside the cooling-off window is 422; after the sim clock passes it, the same withdrawal succeeds', async ({
    asOperatorA,
    build,
    chain,
  }) => {
    const operatorA = new ApiClient(asOperatorA);
    const funded = await build.fundedWallet({ asset: 'GBPX', amount: '10000.00' });
    const pending = await build.pendingAddress({ accountId: funded.accountId, asset: 'GBPX' });

    const body = {
      walletId: funded.walletId,
      amount: '1500.00',
      counterpartyAddress: pending.address,
    };

    // Still inside the 24h sim-clock window: the exact cooling-off rejection.
    const inWindow = await operatorA.post<ProblemResponse>('/withdrawals', body);
    expect(inWindow.status).toBe(422);
    expect(inWindow.json.type).toContain('cooling-off');

    // Nothing was created and nothing was debited.
    expect(await walletBalance(operatorA, funded.walletId)).toBe('10000.00');

    // Cross the window on the sim clock (25 sim-hours > 24h cooling-off).
    await chain.advanceClockMs(PAST_COOLING_OFF_MS);

    const afterWindow = await operatorA.post<TxResponse>('/withdrawals', body);
    expect(afterWindow.status).toBe(201);
    expect(afterWindow.json.state).toBe('PENDING_APPROVAL');
  });

  test('withdrawal to a non-allowlisted address is 422', async ({ asOperatorA, build }) => {
    const operatorA = new ApiClient(asOperatorA);
    const funded = await build.fundedWallet({ asset: 'GBPX', amount: '10000.00' });

    const res = await operatorA.post<ProblemResponse>('/withdrawals', {
      walletId: funded.walletId,
      amount: '1500.00',
      counterpartyAddress: build.uniqueRef('never-allowlisted'),
    });
    expect(res.status).toBe(422);
    expect(res.json.type).toContain('address-not-allowlisted');
  });

  test('deleting an allowlist entry makes withdrawals to it 422 again', async ({ asOperatorA, build }) => {
    const operatorA = new ApiClient(asOperatorA);
    const funded = await build.fundedWallet({ asset: 'GBPX', amount: '10000.00' });
    const address = await build.activeAddress({ accountId: funded.accountId, asset: 'GBPX' });

    // Sanity: the entry works while ACTIVE (a real withdrawal succeeds) …
    const before = await operatorA.post<TxResponse>('/withdrawals', {
      walletId: funded.walletId,
      amount: '1500.00',
      counterpartyAddress: address.address,
    });
    expect(before.status).toBe(201);

    // … then remove it.
    const removal = await operatorA.delete(`/accounts/${funded.accountId}/allowlist/${address.entryId}`);
    expect(removal.status).toBe(204);

    const after = await operatorA.post<ProblemResponse>('/withdrawals', {
      walletId: funded.walletId,
      amount: '1500.00',
      counterpartyAddress: address.address,
    });
    expect(after.status).toBe(422);
    expect(after.json.type).toContain('address-not-allowlisted');
  });
});
