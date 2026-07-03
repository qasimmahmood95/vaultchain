// Deposit lifecycle (PRD §A.3.1) — full flow via the API with exact-money
// assertions. Confirmations accrue ONLY via the simulator: this suite runs
// serialized (--workers=1), so "still pending / balance unchanged" assertions
// between explicit chain advances are race-free BY CONSTRUCTION and allowed
// here (and only here — DECISIONS.md D21).
//
// build.fundedWallet already advances blocks, so to observe the
// PENDING_CONFIRMATION resting state these tests register deposits themselves
// via POST /wallets/{id}/deposits/simulate on a build.account wallet.

import { test, expect, ApiClient } from '../fixtures/index.js';
import {
  auditActions,
  firstWallet,
  registerDeposit,
  walletBalance,
  type ProblemResponse,
} from './support/helpers.js';

test.describe('deposit lifecycle', () => {
  test('GBPX deposit rests in PENDING_CONFIRMATION, then 1 block credits it exactly', async ({
    asOperatorA,
    asCompliance,
    build,
    chain,
  }) => {
    const operator = new ApiClient(asOperatorA);
    const compliance = new ApiClient(asCompliance);
    const account = await build.account({ assets: ['GBPX'] });
    const wallet = firstWallet(account);

    const res = await registerDeposit(operator, wallet.id, '2500.00', build.uniqueRef('dep-gbpx'));
    expect(res.status).toBe(201);
    expect(res.json.state).toBe('PENDING_CONFIRMATION');
    expect(res.json.confirmations).toBe(0);
    expect(res.json.amount).toBe('2500.00');
    expect(res.json.fee).toBe('0.00'); // deposits are fee-free (DECISIONS.md D6)

    // Before ANY advance: balance unchanged and no screening/credit has run.
    // Nothing progresses a deposit except the simulator (serialized project,
    // so this observation cannot race with another worker's advance).
    expect(await walletBalance(operator, wallet.id)).toBe('0.00');
    const actionsBefore = await auditActions(compliance, res.json.id);
    expect(actionsBefore).toContain('TRANSACTION_PENDING_CONFIRMATION');
    expect(actionsBefore).not.toContain('TRANSACTION_SCREENING');
    expect(actionsBefore).not.toContain('TRANSACTION_CREDITED');

    // GBPX requires exactly 1 confirmation.
    await chain.advanceBlocks(1);

    expect(await walletBalance(operator, wallet.id)).toBe('2500.00'); // credited EXACTLY
    const actionsAfter = await auditActions(compliance, res.json.id);
    expect(actionsAfter).toContain('TRANSACTION_SCREENING');
    expect(actionsAfter).toContain('TRANSACTION_CREDITED');
  });

  test('duplicate chainTxRef on the same wallet is rejected with 409', async ({ asOperatorA, build }) => {
    const operator = new ApiClient(asOperatorA);
    const account = await build.account({ assets: ['GBPX'] });
    const wallet = firstWallet(account);
    const chainTxRef = build.uniqueRef('dep-dup');

    const first = await registerDeposit(operator, wallet.id, '100.00', chainTxRef);
    expect(first.status).toBe(201);

    const duplicate = await operator.post<ProblemResponse>(`/wallets/${wallet.id}/deposits/simulate`, {
      amount: '100.00',
      chainTxRef,
    });
    expect(duplicate.status).toBe(409);
    expect(duplicate.json.type).toContain('duplicate-chain-tx-ref');
  });

  test('BTC deposit needs 3 confirmations: 1 block is not enough, 3 credit it via screening', async ({
    asOperatorA,
    asCompliance,
    build,
    chain,
  }) => {
    const operator = new ApiClient(asOperatorA);
    const compliance = new ApiClient(asCompliance);
    const account = await build.account({ assets: ['BTC'] });
    const wallet = firstWallet(account);

    const res = await registerDeposit(operator, wallet.id, '0.50000000', build.uniqueRef('dep-btc'));
    expect(res.status).toBe(201);
    expect(res.json.state).toBe('PENDING_CONFIRMATION');

    // 1 confirmation < 3 required: still pending, nothing credited.
    await chain.advanceBlocks(1);
    expect(await walletBalance(operator, wallet.id)).toBe('0.00000000');
    const actionsAtOne = await auditActions(compliance, res.json.id);
    expect(actionsAtOne).not.toContain('TRANSACTION_SCREENING');
    expect(actionsAtOne).not.toContain('TRANSACTION_CREDITED');

    // 2 more blocks reach the requirement: SCREENING (clean) -> CREDITED.
    await chain.advanceBlocks(2);
    expect(await walletBalance(operator, wallet.id)).toBe('0.50000000'); // exact, 8 dp
    const actionsAtThree = await auditActions(compliance, res.json.id);
    expect(actionsAtThree).toContain('TRANSACTION_SCREENING');
    expect(actionsAtThree).toContain('TRANSACTION_CREDITED');
  });
});
