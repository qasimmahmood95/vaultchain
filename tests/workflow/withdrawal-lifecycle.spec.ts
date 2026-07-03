// Withdrawal lifecycle (PRD §A.3.2) — dual approval, Travel Rule gate,
// broadcast debit, confirmation, plus reject/cancel paths. Exact money
// everywhere: 1500.00 GBPX at 10 bps has an EXACT 1.50 fee (no rounding
// boundary — those live in money-precision.spec.ts by design).
//
// Out of scope here (P4 compliance-gate territory): the Travel-Rule THRESHOLD
// boundary (999.99 / 1000.00 / 1000.01) and duplicate-approval 409 semantics.

import { test, expect, ApiClient } from './support/world.js';
import {
  auditActions,
  decide,
  travelRulePayload,
  walletBalance,
  type TxResponse,
  type WithdrawalDetailResponse,
} from './support/helpers.js';

test.describe('withdrawal lifecycle', () => {
  test('cross-VASP happy path: dual approval, travel rule, exact debit, confirmation, audit trail', async ({
    asOperatorA,
    asOperatorB,
    asAdmin,
    asCompliance,
    build,
    chain,
  }) => {
    const operatorA = new ApiClient(asOperatorA); // the maker
    const operatorB = new ApiClient(asOperatorB); // checker 1
    const admin = new ApiClient(asAdmin); // checker 2
    const compliance = new ApiClient(asCompliance);

    const funded = await build.fundedWallet({ asset: 'GBPX', amount: '10000.00' });
    const address = await build.activeAddress({ accountId: funded.accountId, asset: 'GBPX' });

    // Maker (operator A) creates: 1500.00 cross-VASP, above the 1000.00 policy
    // threshold -> 2 distinct non-maker approvals required.
    const wd = await build.withdrawal({
      walletId: funded.walletId,
      amount: '1500.00',
      address: address.address,
      vaspId: build.uniqueRef('vasp'),
    });
    expect(wd.state).toBe('PENDING_APPROVAL');
    expect(wd.fee).toBe('1.50'); // 150000 minor x 10 bps = exactly 150 minor

    // Maker cannot check: the creator's own approval attempt is 403.
    const makerAttempt = await decide(operatorA, wd.id, 'APPROVE');
    expect(makerAttempt.status).toBe(403);

    // First distinct checker: recorded, but 1 of 2 -> still PENDING_APPROVAL.
    const first = await decide(operatorB, wd.id, 'APPROVE');
    expect(first.status).toBe(201);
    expect(first.json.state).toBe('PENDING_APPROVAL');

    // Second distinct checker: policy met -> cross-VASP above threshold gates
    // on the Travel Rule before screening/broadcast.
    const second = await decide(admin, wd.id, 'APPROVE');
    expect(second.status).toBe(201);
    expect(second.json.state).toBe('TRAVEL_RULE_CHECK');

    // Nothing is debited until broadcast.
    expect(await walletBalance(operatorA, funded.walletId)).toBe('10000.00');

    // Attach originator + beneficiary data (as compliance): the gate clears,
    // screening runs clean, and the withdrawal broadcasts in the same call.
    const tr = await compliance.post<TxResponse>(`/withdrawals/${wd.id}/travel-rule`, travelRulePayload());
    expect(tr.status).toBe(201);
    expect(tr.json.state).toBe('PENDING_CONFIRMATION');

    // EXACT debit at broadcast: 10000.00 - 1500.00 - 1.50 fee.
    expect(await walletBalance(operatorA, funded.walletId)).toBe('8498.50');

    // GBPX needs 1 confirmation.
    await chain.advanceBlocks(1);
    const detail = await operatorA.get<WithdrawalDetailResponse>(`/withdrawals/${wd.id}`);
    expect(detail.status).toBe(200);
    expect(detail.json.state).toBe('CONFIRMED');
    expect(detail.json.travelRule.map((r) => r.direction).sort()).toEqual(['BENEFICIARY', 'ORIGINATOR']);

    // Audit completeness for the whole lifecycle (entity-scoped query).
    const actions = await auditActions(compliance, wd.id);
    expect(actions).toEqual(
      expect.arrayContaining([
        'WITHDRAWAL_CREATED',
        'WITHDRAWAL_APPROVAL_RECORDED',
        'TRANSACTION_APPROVED',
        'TRANSACTION_TRAVEL_RULE_CHECK',
        'TRAVEL_RULE_ATTACHED',
        'TRANSACTION_SCREENING',
        'TRANSACTION_BROADCAST',
        'TRANSACTION_PENDING_CONFIRMATION',
        'TRANSACTION_CONFIRMED',
      ]),
    );
    // Both distinct checkers' decisions were recorded.
    expect(actions.filter((a) => a === 'WITHDRAWAL_APPROVAL_RECORDED')).toHaveLength(2);
  });

  test('reject path: a checker REJECT terminates the withdrawal and leaves the balance untouched', async ({
    asOperatorA,
    asOperatorB,
    build,
  }) => {
    const operatorA = new ApiClient(asOperatorA);
    const operatorB = new ApiClient(asOperatorB);

    const funded = await build.fundedWallet({ asset: 'GBPX', amount: '10000.00' });
    const address = await build.activeAddress({ accountId: funded.accountId, asset: 'GBPX' });
    const wd = await build.withdrawal({ walletId: funded.walletId, amount: '1500.00', address: address.address });

    const rejection = await decide(operatorB, wd.id, 'REJECT');
    expect(rejection.status).toBe(201);
    expect(rejection.json.state).toBe('REJECTED');

    // No debit ever happened: amount AND fee stay untouched.
    expect(await walletBalance(operatorA, funded.walletId)).toBe('10000.00');
  });

  test('cancel path: the maker cancels while PENDING_APPROVAL', async ({ asOperatorA, build }) => {
    const operatorA = new ApiClient(asOperatorA);

    const funded = await build.fundedWallet({ asset: 'GBPX', amount: '10000.00' });
    const address = await build.activeAddress({ accountId: funded.accountId, asset: 'GBPX' });
    const wd = await build.withdrawal({ walletId: funded.walletId, amount: '1500.00', address: address.address });

    const cancelled = await operatorA.post<TxResponse>(`/withdrawals/${wd.id}/cancel`);
    expect(cancelled.status).toBe(200);
    expect(cancelled.json.state).toBe('CANCELLED');

    expect(await walletBalance(operatorA, funded.walletId)).toBe('10000.00');
  });

  test('domestic above-policy withdrawal SKIPS the travel rule: second approval goes straight to PENDING_CONFIRMATION', async ({
    asOperatorA,
    asOperatorB,
    asAdmin,
    build,
  }) => {
    const operatorA = new ApiClient(asOperatorA);
    const operatorB = new ApiClient(asOperatorB);
    const admin = new ApiClient(asAdmin);

    const funded = await build.fundedWallet({ asset: 'GBPX', amount: '10000.00' });
    const address = await build.activeAddress({ accountId: funded.accountId, asset: 'GBPX' });

    // Above the approval threshold but NO vaspId: the Travel Rule gate only
    // applies to cross-VASP transfers (PRD §A.3.3).
    const wd = await build.withdrawal({ walletId: funded.walletId, amount: '1500.00', address: address.address });

    const first = await decide(operatorB, wd.id, 'APPROVE');
    expect(first.status).toBe(201);
    expect(first.json.state).toBe('PENDING_APPROVAL');

    const second = await decide(admin, wd.id, 'APPROVE');
    expect(second.status).toBe(201);
    expect(second.json.state).toBe('PENDING_CONFIRMATION'); // no TRAVEL_RULE_CHECK stop

    const detail = await operatorA.get<WithdrawalDetailResponse>(`/withdrawals/${wd.id}`);
    expect(detail.json.travelRule).toEqual([]);
    expect(await walletBalance(operatorA, funded.walletId)).toBe('8498.50');
  });
});
