// Omnibus wallets (PRD §A.1): deposits and withdrawals on an OMNIBUS wallet
// behave identically to segregated ones — exact credit, exact debit, same
// gates. These tests prove that at the API surface.
//
// NOTE ON SCOPE: per-client ledger attribution on the seeded 5-client omnibus
// pool is NOT testable through the API — §A.4 deliberately exposes no ledger
// endpoint (the LedgerEntry sub-ledger is internal book-keeping). The
// "sum of client ledgers == wallet balance" invariant is covered by the
// DB-level reconciliation sweep in the integration evidence, not here.
//
// build.fundedWallet always creates SEGREGATED accounts, so these tests fund
// their omnibus wallet directly (deposit + advance) — worked around locally.

import { test, expect, ApiClient } from './support/world.js';
import {
  decide,
  firstWallet,
  registerDeposit,
  walletBalance,
  type WalletResponse,
  type WithdrawalDetailResponse,
} from './support/helpers.js';

test.describe('omnibus lifecycle', () => {
  test('deposit on an OMNIBUS wallet credits exactly', async ({ asOperatorA, build, chain }) => {
    const operator = new ApiClient(asOperatorA);
    const account = await build.account({ segregation: 'OMNIBUS', assets: ['GBPX'] });
    const wallet = firstWallet(account);

    // The wallet really is omnibus.
    const walletRead = await operator.get<WalletResponse>(`/wallets/${wallet.id}`);
    expect(walletRead.status).toBe(200);
    expect(walletRead.json.segregationModel).toBe('OMNIBUS');

    const dep = await registerDeposit(operator, wallet.id, '10000.00', build.uniqueRef('dep-omni'));
    expect(dep.status).toBe(201);
    expect(dep.json.state).toBe('PENDING_CONFIRMATION');
    expect(await walletBalance(operator, wallet.id)).toBe('0.00');

    await chain.advanceBlocks(1);
    expect(await walletBalance(operator, wallet.id)).toBe('10000.00'); // credit EXACT
  });

  test('dual-approved withdrawal on an OMNIBUS wallet debits exactly and confirms', async ({
    asOperatorA,
    asOperatorB,
    asAdmin,
    build,
    chain,
  }) => {
    const operatorA = new ApiClient(asOperatorA);
    const operatorB = new ApiClient(asOperatorB);
    const admin = new ApiClient(asAdmin);

    const account = await build.account({ segregation: 'OMNIBUS', assets: ['GBPX'] });
    const wallet = firstWallet(account);

    // Fund the omnibus wallet: deposit + 1 GBPX confirmation.
    const dep = await registerDeposit(operatorA, wallet.id, '10000.00', build.uniqueRef('dep-omni'));
    expect(dep.status).toBe(201);
    await chain.advanceBlocks(1);
    expect(await walletBalance(operatorA, wallet.id)).toBe('10000.00');

    // Same gates as segregated: allowlist, dual approval above threshold.
    const address = await build.activeAddress({ accountId: account.accountId, asset: 'GBPX' });
    const wd = await build.withdrawal({ walletId: wallet.id, amount: '1500.00', address: address.address });
    expect(wd.state).toBe('PENDING_APPROVAL');
    expect(wd.fee).toBe('1.50');

    const first = await decide(operatorB, wd.id, 'APPROVE');
    expect(first.status).toBe(201);
    expect(first.json.state).toBe('PENDING_APPROVAL');

    const second = await decide(admin, wd.id, 'APPROVE');
    expect(second.status).toBe(201);
    expect(second.json.state).toBe('PENDING_CONFIRMATION'); // domestic: no travel-rule stop

    // Debit EXACT: 10000.00 - 1500.00 - 1.50.
    expect(await walletBalance(operatorA, wallet.id)).toBe('8498.50');

    await chain.advanceBlocks(1);
    const detail = await operatorA.get<WithdrawalDetailResponse>(`/withdrawals/${wd.id}`);
    expect(detail.json.state).toBe('CONFIRMED');
  });
});
