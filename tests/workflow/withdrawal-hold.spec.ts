// Withdrawal-side screening holds (PRD §A.3.2). P2 review Major 3: this is a
// SEPARATE code path from deposit holds — the FLAG lands before broadcast, so
// the debit must NOT have happened while HELD, must happen EXACTLY ONCE on
// release, and must never happen on reject.
//
// Audit entries for hold resolution are deliberately NOT asserted (P4
// compliance-gate territory). Values are fee-exact (1500.00 -> fee 1.50).

import { test, expect, ApiClient } from '../fixtures/index.js';
import {
  decide,
  findOpenHold,
  settlePendingBacklog,
  walletBalance,
  type HoldResponse,
  type TxResponse,
} from './support/helpers.js';

test.describe('withdrawal screening holds', () => {
  test('flagged withdrawal is HELD before any debit; release debits exactly once and broadcasts', async ({
    asOperatorA,
    asOperatorB,
    asAdmin,
    asCompliance,
    build,
    chain,
  }) => {
    const operator = new ApiClient(asOperatorA);
    const compliance = new ApiClient(asCompliance);

    const funded = await build.fundedWallet({ asset: 'GBPX', amount: '10000.00' });
    const dest = await build.activeAddress({ accountId: funded.accountId, asset: 'GBPX' });
    const wd = await build.withdrawal({ walletId: funded.walletId, amount: '1500.00', address: dest.address });

    // Flush other pending settlements FIRST, then queue: the withdrawal's own
    // screening (during approval progression) must be the FLAG's consumer.
    await settlePendingBacklog(chain);
    await chain.queueScreening('FLAG');

    await decide(new ApiClient(asOperatorB), wd.id, 'APPROVE');
    const second = await decide(new ApiClient(asAdmin), wd.id, 'APPROVE');
    expect(second.json.state).toBe('HELD');

    // HELD before broadcast: the balance is UNTOUCHED.
    expect(await walletBalance(operator, funded.walletId)).toBe('10000.00');

    const hold = await findOpenHold(compliance, wd.id);
    const release = await compliance.post<HoldResponse>(`/holds/${hold.id}/release`);
    expect(release.status).toBe(200);

    // Release resumes to broadcast: debited EXACTLY once, amount + fee.
    const detail = await operator.get<TxResponse>(`/withdrawals/${wd.id}`);
    expect(detail.json.state).toBe('PENDING_CONFIRMATION');
    expect(await walletBalance(operator, funded.walletId)).toBe('8498.50');

    await chain.advanceBlocks(1);
    const confirmed = await operator.get<TxResponse>(`/withdrawals/${wd.id}`);
    expect(confirmed.json.state).toBe('CONFIRMED');
    expect(await walletBalance(operator, funded.walletId)).toBe('8498.50');
  });

  test('flagged withdrawal rejected by compliance: transaction REJECTED, balance never debited', async ({
    asOperatorA,
    asOperatorB,
    asAdmin,
    asCompliance,
    build,
    chain,
  }) => {
    const operator = new ApiClient(asOperatorA);
    const compliance = new ApiClient(asCompliance);

    const funded = await build.fundedWallet({ asset: 'GBPX', amount: '4000.00' });
    const dest = await build.activeAddress({ accountId: funded.accountId, asset: 'GBPX' });
    const wd = await build.withdrawal({ walletId: funded.walletId, amount: '1500.00', address: dest.address });

    await settlePendingBacklog(chain);
    await chain.queueScreening('FLAG');

    await decide(new ApiClient(asOperatorB), wd.id, 'APPROVE');
    const second = await decide(new ApiClient(asAdmin), wd.id, 'APPROVE');
    expect(second.json.state).toBe('HELD');
    expect(await walletBalance(operator, funded.walletId)).toBe('4000.00');

    const hold = await findOpenHold(compliance, wd.id);
    const rejection = await compliance.post<HoldResponse>(`/holds/${hold.id}/reject`);
    expect(rejection.status).toBe(200);
    expect(rejection.json.state).toBe('REJECTED');

    const detail = await operator.get<TxResponse>(`/withdrawals/${wd.id}`);
    expect(detail.json.state).toBe('REJECTED');
    expect(await walletBalance(operator, funded.walletId)).toBe('4000.00');
  });
});
