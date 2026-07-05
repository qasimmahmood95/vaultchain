// @compliance — audit completeness (PRD §A.1, §B.3).
//
// THE RULE: the audit log is append-only and COMPLETE — every state-changing
// action carries an AuditLogEntry with an actor and before/after, exactly
// once. Completeness is asserted with exact ordered sequences: an exact match
// simultaneously proves nothing is MISSING (the compliance-critical omission
// class — e.g. a hold release that changes state silently) and nothing is
// DUPLICATED (the concurrency class: a non-CAS settlement path would emit
// duplicate TRANSACTION_* rows under parallel advances — D28 is the platform
// guarantee these assertions lean on; verified present before this suite was
// written, per the D28 note).
//
// Value discipline: amounts are 1500.00/2500.00 GBPX (exact fees, away from
// rounding boundaries) and no derived amounts are asserted, so these trails
// behave identically regardless of any money-precision defect.

import { test, expect, ApiClient } from '../fixtures/index.js';
import {
  apiKeyIdOf,
  auditEntries,
  decide,
  flaggedDepositHold,
  travelRulePayload,
  walletBalance,
  withdrawalDetail,
  type AuditEntry,
  type TxResponse,
} from './support/helpers.js';

const RULE = { type: 'rule', description: 'AUD-COMPLETENESS' };

/** Every TRANSACTION_* entry must identify who moved the state, from and to what. */
function expectTransitionEntriesComplete(trail: AuditEntry[]): void {
  for (const entry of trail) {
    expect(entry.actorRole, `${entry.action}: actor role missing`).not.toBeNull();
    expect(entry.actorApiKeyId, `${entry.action}: actor key missing`).not.toBeNull();
    expect(entry.after, `${entry.action}: no after image`).not.toBeNull();
    if (entry.action.startsWith('TRANSACTION_')) {
      expect(entry.before?.['state'], `${entry.action}: no before state`).toBeTruthy();
      expect(entry.after?.['state'], `${entry.action}: no after state`).toBeTruthy();
    }
  }
}

test(
  'deposit with a screening hold: every transition audited exactly once — the release included',
  { tag: '@compliance', annotation: [RULE] },
  async ({ asOperatorA, asCompliance, build, chain }) => {
    const operatorA = new ApiClient(asOperatorA);
    const compliance = new ApiClient(asCompliance);
    const complianceId = await apiKeyIdOf(compliance);

    const { depositId, hold } = await flaggedDepositHold({ operator: operatorA, compliance, build, chain });
    const release = await compliance.post(`/holds/${hold.id}/release`);
    expect(release.status).toBe(200);

    // Transaction trail: exact ordered sequence — complete AND duplicate-free.
    const txTrail = await auditEntries(compliance, 'Transaction', depositId);
    expect(txTrail.map((e) => e.action)).toEqual([
      'DEPOSIT_DETECTED',
      'TRANSACTION_PENDING_CONFIRMATION',
      'TRANSACTION_SCREENING',
      'TRANSACTION_HELD',
      'TRANSACTION_CREDITED',
    ]);
    expectTransitionEntriesComplete(txTrail);

    // Hold trail: opening AND resolution are audited — a release that changes
    // OPEN -> RELEASED without recording who did it is the omission this rule
    // exists to catch.
    const holdTrail = await auditEntries(compliance, 'ComplianceHold', hold.id);
    expect(holdTrail.map((e) => e.action)).toEqual(['HOLD_OPENED', 'HOLD_RELEASED']);
    const releasedEntry = holdTrail[1];
    expect(releasedEntry?.actorApiKeyId).toBe(complianceId);
    expect(releasedEntry?.actorRole).toBe('COMPLIANCE_OFFICER');
    expect(releasedEntry?.before).toEqual({ state: 'OPEN' });
    expect(releasedEntry?.after).toEqual({ state: 'RELEASED', resolvedBy: complianceId });
  },
);

test(
  'withdrawal through approval, Travel Rule, broadcast and confirmation: complete trail, no duplicates',
  { tag: '@compliance', annotation: [RULE] },
  async ({ asOperatorA, asOperatorB, asAdmin, asCompliance, build, chain }) => {
    const operatorA = new ApiClient(asOperatorA);
    const operatorB = new ApiClient(asOperatorB);
    const admin = new ApiClient(asAdmin);
    const compliance = new ApiClient(asCompliance);

    const funded = await build.fundedWallet({ asset: 'GBPX', amount: '10000.00' });
    const address = await build.activeAddress({ accountId: funded.accountId, asset: 'GBPX' });
    const wd = await build.withdrawal({
      walletId: funded.walletId,
      amount: '1500.00',
      address: address.address,
      vaspId: build.uniqueRef('vasp'), // cross-VASP above threshold: full gate order
    });

    await decide(operatorB, wd.id, 'APPROVE');
    const second = await decide(admin, wd.id, 'APPROVE');
    expect(second.json.state).toBe('TRAVEL_RULE_CHECK');
    const attach = await compliance.post<TxResponse>(`/withdrawals/${wd.id}/travel-rule`, travelRulePayload());
    expect(attach.json.state).toBe('PENDING_CONFIRMATION');
    await chain.advanceBlocks(1); // GBPX: 1 confirmation
    expect((await withdrawalDetail(operatorA, wd.id)).state).toBe('CONFIRMED');

    // The full §A.3.2 gate order, audited in order, each step exactly once.
    const trail = await auditEntries(compliance, 'Transaction', wd.id);
    expect(trail.map((e) => e.action)).toEqual([
      'WITHDRAWAL_CREATED',
      'WITHDRAWAL_APPROVAL_RECORDED',
      'WITHDRAWAL_APPROVAL_RECORDED',
      'TRANSACTION_APPROVED',
      'TRANSACTION_TRAVEL_RULE_CHECK',
      'TRAVEL_RULE_ATTACHED',
      'TRANSACTION_SCREENING',
      'TRANSACTION_BROADCAST',
      'TRANSACTION_PENDING_CONFIRMATION',
      'TRANSACTION_CONFIRMED',
    ]);
    expectTransitionEntriesComplete(trail);
  },
);

test(
  'forced FAILED after broadcast: the terminal transition and the refund are audited, exactly once',
  { tag: '@compliance', annotation: [RULE] },
  async ({ asOperatorA, asOperatorB, asAdmin, asCompliance, build }) => {
    const operatorA = new ApiClient(asOperatorA);
    const operatorB = new ApiClient(asOperatorB);
    const admin = new ApiClient(asAdmin);
    const compliance = new ApiClient(asCompliance);

    const funded = await build.fundedWallet({ asset: 'GBPX', amount: '10000.00' });
    const address = await build.activeAddress({ accountId: funded.accountId, asset: 'GBPX' });
    const wd = await build.withdrawal({ walletId: funded.walletId, amount: '1500.00', address: address.address });

    await decide(operatorB, wd.id, 'APPROVE');
    const second = await decide(admin, wd.id, 'APPROVE');
    expect(second.json.state).toBe('PENDING_CONFIRMATION'); // domestic: broadcast, funds debited

    // Simulator-forced chain failure -> FAILED with a compensating refund (D14).
    const forced = await admin.post<TxResponse>(`/simulator/tx/${wd.id}/force`, { outcome: 'FAILED' });
    expect(forced.status).toBe(200);
    expect(forced.json.state).toBe('FAILED');
    // The refund restored amount + fee (exact-value ownership stays with the
    // workflow suite; here it pins that the audited FAILED really refunded).
    expect(await walletBalance(operatorA, funded.walletId)).toBe('10000.00');

    const trail = await auditEntries(compliance, 'Transaction', wd.id);
    expect(trail.map((e) => e.action)).toEqual([
      'WITHDRAWAL_CREATED',
      'WITHDRAWAL_APPROVAL_RECORDED',
      'WITHDRAWAL_APPROVAL_RECORDED',
      'TRANSACTION_APPROVED',
      'TRANSACTION_SCREENING',
      'TRANSACTION_BROADCAST',
      'TRANSACTION_PENDING_CONFIRMATION',
      'TRANSACTION_FAILED',
    ]);
    expectTransitionEntriesComplete(trail);

    const failedEntry = trail[trail.length - 1];
    expect(failedEntry?.before).toEqual({ state: 'PENDING_CONFIRMATION' });
    expect(failedEntry?.after?.['state']).toBe('FAILED');
    expect(failedEntry?.actorRole).toBe('ADMIN');
  },
);
