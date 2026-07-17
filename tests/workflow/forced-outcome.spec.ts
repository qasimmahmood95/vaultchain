// Forced transaction outcomes (PRD §A.7, DECISIONS D14): a withdrawal forced
// to FAILED after its debit is refunded amount + fee, restoring the balance
// EXACTLY; forced CONFIRMED keeps the debit. P2 review Major 2: this is the
// one simulator control that moves money, so it gets exact-value pinning.
//
// Values are fee-exact (1500.00 @ 10bps -> 1.50) so behaviour is identical on
// main and the planted-defect branch.

import { test, expect, ApiClient } from '../fixtures/index.js';
import {
  auditActions,
  decide,
  findOpenHold,
  settlePendingBacklog,
  walletBalance,
  type TxResponse,
} from './support/helpers.js';

test.describe('forced outcomes', () => {
  test('forced FAILED after broadcast refunds amount + fee exactly and audits the transition', async ({
    asOperatorA,
    asOperatorB,
    asAdmin,
    asCompliance,
    build,
  }) => {
    const operator = new ApiClient(asOperatorA);
    const admin = new ApiClient(asAdmin);
    const compliance = new ApiClient(asCompliance);

    const funded = await build.fundedWallet({ asset: 'GBPX', amount: '10000.00' });
    const dest = await build.activeAddress({ accountId: funded.accountId, asset: 'GBPX' });
    const wd = await build.withdrawal({ walletId: funded.walletId, amount: '1500.00', address: dest.address });

    // Domestic above-policy: two distinct checkers -> broadcast (screening clean).
    await decide(new ApiClient(asOperatorB), wd.id, 'APPROVE');
    const second = await decide(admin, wd.id, 'APPROVE');
    expect(second.json.state).toBe('PENDING_CONFIRMATION');
    expect(await walletBalance(operator, funded.walletId)).toBe('8498.50'); // 10000 - 1500 - 1.50

    // Force FAILED: the debit must be compensated IN FULL (amount + fee, D14).
    const forced = await admin.post<TxResponse>(`/simulator/tx/${wd.id}/force`, { outcome: 'FAILED' });
    expect(forced.status).toBe(200);
    expect(forced.json.state).toBe('FAILED');
    expect(await walletBalance(operator, funded.walletId)).toBe('10000.00');

    // The FAILED transition is audited like every other state change.
    const actions = await auditActions(compliance, wd.id);
    expect(actions).toContain('TRANSACTION_FAILED');
  });

  test('forced CONFIRMED keeps the debit: no refund, state CONFIRMED', async ({
    asOperatorA,
    asOperatorB,
    asAdmin,
    build,
  }) => {
    const operator = new ApiClient(asOperatorA);
    const admin = new ApiClient(asAdmin);

    const funded = await build.fundedWallet({ asset: 'GBPX', amount: '5000.00' });
    const dest = await build.activeAddress({ accountId: funded.accountId, asset: 'GBPX' });
    const wd = await build.withdrawal({ walletId: funded.walletId, amount: '1500.00', address: dest.address });

    await decide(new ApiClient(asOperatorB), wd.id, 'APPROVE');
    const second = await decide(admin, wd.id, 'APPROVE');
    expect(second.json.state).toBe('PENDING_CONFIRMATION');

    const forced = await admin.post<TxResponse>(`/simulator/tx/${wd.id}/force`, { outcome: 'CONFIRMED' });
    expect(forced.status).toBe(200);
    expect(forced.json.state).toBe('CONFIRMED');

    // Confirmed money is spent money: the debit stays.
    expect(await walletBalance(operator, funded.walletId)).toBe('3498.50'); // 5000 - 1500 - 1.50
  });

  // Adversarial-gate guards: force can only settle a broadcast withdrawal.
  test('force CONFIRMED is refused before broadcast — no confirm-without-debit (F1)', async ({
    asOperatorA,
    asAdmin,
    build,
  }) => {
    const operator = new ApiClient(asOperatorA);
    const admin = new ApiClient(asAdmin);

    const funded = await build.fundedWallet({ asset: 'GBPX', amount: '3000.00' });
    const dest = await build.activeAddress({ accountId: funded.accountId, asset: 'GBPX' });
    // PENDING_APPROVAL — never broadcast, never debited.
    const wd = await build.withdrawal({ walletId: funded.walletId, amount: '1500.00', address: dest.address });

    const forced = await admin.post(`/simulator/tx/${wd.id}/force`, { outcome: 'CONFIRMED' });
    expect(forced.status).toBe(409);
    // The withdrawal is untouched: no money confirmed that never left the wallet.
    expect(await walletBalance(operator, funded.walletId)).toBe('3000.00');
    const detail = await operator.get<TxResponse>(`/withdrawals/${wd.id}`);
    expect(detail.json.state).toBe('PENDING_APPROVAL');
  });

  test('force CONFIRMED is refused for a deposit — deposits settle via chain advance (F5)', async ({
    asOperatorA,
    asAdmin,
    build,
  }) => {
    const operator = new ApiClient(asOperatorA);
    const admin = new ApiClient(asAdmin);

    const account = await build.account({ assets: ['GBPX'] });
    const wallet = account.wallets[0]!;
    const dep = await operator.post<{ id: string }>(`/wallets/${wallet.id}/deposits/simulate`, {
      amount: '500.00',
      chainTxRef: build.uniqueRef('f5-dep'),
    });
    // The deposit is PENDING_CONFIRMATION (registered, not yet credited).
    const forced = await admin.post(`/simulator/tx/${dep.json.id}/force`, { outcome: 'CONFIRMED' });
    expect(forced.status).toBe(409);
  });

  test('a HELD withdrawal cannot be forced terminal — the compliance hold is not orphaned (F4)', async ({
    asOperatorB,
    asAdmin,
    asCompliance,
    build,
    chain,
  }) => {
    const operatorB = new ApiClient(asOperatorB);
    const admin = new ApiClient(asAdmin);
    const compliance = new ApiClient(asCompliance);

    const funded = await build.fundedWallet({ asset: 'GBPX', amount: '10000.00' });
    const dest = await build.activeAddress({ accountId: funded.accountId, asset: 'GBPX' });
    // Arm the FLAG only after all deposit settlement is done, so it lands on THIS
    // withdrawal's screening (serialized project; no other test can consume it).
    await settlePendingBacklog(chain);
    await chain.queueScreening('FLAG');
    // Domestic, above policy threshold -> 2 approvals -> screening -> HELD (flagged).
    const wd = await build.withdrawal({ walletId: funded.walletId, amount: '1500.00', address: dest.address });
    await decide(operatorB, wd.id, 'APPROVE');
    const second = await decide(admin, wd.id, 'APPROVE');
    expect(second.json.state).toBe('HELD');

    // Force must be refused: a held tx is compliance's to resolve, not the chain's.
    const forced = await admin.post(`/simulator/tx/${wd.id}/force`, { outcome: 'FAILED' });
    expect(forced.status).toBe(409);

    // The hold is still OPEN and the transaction still HELD — nothing orphaned.
    const hold = await findOpenHold(compliance, wd.id);
    expect(hold.state).toBe('OPEN');
    const detail = await admin.get<TxResponse>(`/withdrawals/${wd.id}`);
    expect(detail.json.state).toBe('HELD');
  });
});
