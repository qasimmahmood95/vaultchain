// Money precision (PRD §A.2, DECISIONS.md D6): fee = 10 bps with HALF-EVEN
// rounding on integer minor units; per-asset decimals (GBPX 2, BTC 8, ETH 18).
//
// This file is the ONE place .5-boundary values (15.00, 25.00) are allowed —
// the exact half-even assertion is the point (value discipline: happy paths
// elsewhere use fee-exact amounts). Withdrawals here are SUB-threshold
// (< 1000.00 -> ONE non-maker approval, D7) and domestic, so a single
// operator-B approval broadcasts them (screening clean).

import { test, expect, ApiClient } from '../fixtures/index.js';
import {
  decide,
  firstWallet,
  registerDeposit,
  walletBalance,
  type ProblemResponse,
} from './support/helpers.js';

test.describe('money precision', () => {
  // 10 bps on GBPX minor units:
  //   15.00 -> 1500 minor -> fee 1.5 minor: exactly half, 1 is odd  -> UP  to 2 -> '0.02'
  //   25.00 -> 2500 minor -> fee 2.5 minor: exactly half, 2 is even -> STAY at 2 -> '0.02'
  //   30.00 -> 3000 minor -> fee 3.0 minor: exact, no rounding            -> '0.03'
  const HALF_EVEN_CASES = [
    { amount: '15.00', fee: '0.02', finalBalance: '84.98', label: '1.5 minor rounds up to even 2' },
    { amount: '25.00', fee: '0.02', finalBalance: '74.98', label: '2.5 minor stays at even 2' },
    { amount: '30.00', fee: '0.03', finalBalance: '69.97', label: 'exact 3 minor — non-boundary control' },
  ] as const;

  for (const c of HALF_EVEN_CASES) {
    test(`GBPX withdrawal of ${c.amount}: fee is exactly ${c.fee} (${c.label})`, async ({
      asOperatorA,
      asOperatorB,
      build,
    }) => {
      const operatorA = new ApiClient(asOperatorA);
      const operatorB = new ApiClient(asOperatorB);

      const funded = await build.fundedWallet({ asset: 'GBPX', amount: '100.00' });
      const address = await build.activeAddress({ accountId: funded.accountId, asset: 'GBPX' });

      // Fee is computed at creation — assert the exact string immediately.
      const wd = await build.withdrawal({
        walletId: funded.walletId,
        amount: c.amount,
        address: address.address,
      });
      expect(wd.fee).toBe(c.fee);

      // Sub-threshold: ONE distinct non-maker approval broadcasts it.
      const approval = await decide(operatorB, wd.id, 'APPROVE');
      expect(approval.status).toBe(201);
      expect(approval.json.state).toBe('PENDING_CONFIRMATION');
      expect(approval.json.fee).toBe(c.fee);

      // Final balance EXACT: 100.00 - amount - fee.
      expect(await walletBalance(operatorA, funded.walletId)).toBe(c.finalBalance);
    });
  }

  test('ETH 18dp: a big-number deposit credits with zero precision loss', async ({
    asOperatorA,
    build,
    chain,
  }) => {
    const operator = new ApiClient(asOperatorA);
    const account = await build.account({ assets: ['ETH'] });
    const wallet = firstWallet(account);

    const dep = await registerDeposit(operator, wallet.id, '1.000000000000000005', build.uniqueRef('dep-eth'));
    expect(dep.status).toBe(201);
    expect(dep.json.amount).toBe('1.000000000000000005');

    await chain.advanceBlocks(12); // ETH requires 12 confirmations

    // The 18th decimal place survives end-to-end (integer minor units, never a float).
    expect(await walletBalance(operator, wallet.id)).toBe('1.000000000000000005');
  });

  test('invalid scale: a GBPX amount with 3 decimal places is 422 on deposit and withdrawal', async ({
    asOperatorA,
    build,
  }) => {
    const operator = new ApiClient(asOperatorA);
    const account = await build.account({ assets: ['GBPX'] });
    const wallet = firstWallet(account);

    const deposit = await operator.post<ProblemResponse>(`/wallets/${wallet.id}/deposits/simulate`, {
      amount: '1.234',
      chainTxRef: build.uniqueRef('dep-scale'),
    });
    expect(deposit.status).toBe(422);
    expect(deposit.json.type).toContain('invalid-amount-scale');

    const withdrawal = await operator.post<ProblemResponse>('/withdrawals', {
      walletId: wallet.id,
      amount: '1.234',
      counterpartyAddress: build.uniqueRef('ext-gbpx'),
    });
    expect(withdrawal.status).toBe(422);
    expect(withdrawal.json.type).toContain('invalid-amount-scale');
  });
});
