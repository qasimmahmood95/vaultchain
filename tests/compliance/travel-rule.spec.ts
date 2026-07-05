// @compliance — Travel Rule boundary triplet (PRD §A.3.3, §B.3, §D.2).
//
// THE RULE: a cross-VASP transfer whose fiat-equivalent value is AT OR ABOVE
// 1,000.00 must carry originator AND beneficiary Travel-Rule data before it
// can leave TRAVEL_RULE_CHECK. Below the threshold, reduced data applies.
//
// The triplet is denominated in GBPX (1:1 fiat — an amount IS its own
// fiat-equivalent), so the threshold comparison never routes through the fiat
// conversion or the fee/rounding path: the boundary catch is independent of
// any money-precision defect (PRD §A.3.3 independence note). For the same
// reason these tests assert STATES and RECORDS, never derived amounts.
//
// Note the platform's default approval policy threshold is also 1000.00
// (D7/D17): T-1 needs one distinct non-maker approval; T and T+1 need two.

import { test, expect, ApiClient } from '../fixtures/index.js';
import { auditActions, decide, travelRulePayload, walletBalance, withdrawalDetail } from './support/helpers.js';

const RULE = { type: 'rule', description: 'TR-16-BOUNDARY' };

test(
  'T-1: a cross-VASP transfer of 999.99 proceeds to broadcast without a Travel Rule record',
  { tag: '@compliance', annotation: [RULE, { type: 'boundary', description: 'T-1=999.99' }] },
  async ({ asOperatorA, asOperatorB, asCompliance, build }) => {
    const operatorA = new ApiClient(asOperatorA);
    const operatorB = new ApiClient(asOperatorB);
    const compliance = new ApiClient(asCompliance);

    const funded = await build.fundedWallet({ asset: 'GBPX', amount: '5000.00' });
    const address = await build.activeAddress({ accountId: funded.accountId, asset: 'GBPX' });
    const wd = await build.withdrawal({
      walletId: funded.walletId,
      amount: '999.99',
      address: address.address,
      vaspId: build.uniqueRef('vasp'),
    });

    // Below the approval-policy threshold too: one distinct non-maker approval
    // completes it, and the withdrawal must reach broadcast WITHOUT a
    // Travel-Rule stop (reduced-data regime below the threshold).
    const approval = await decide(operatorB, wd.id, 'APPROVE');
    expect(approval.status).toBe(201);
    expect(approval.json.state).toBe('PENDING_CONFIRMATION');

    const detail = await withdrawalDetail(operatorA, wd.id);
    expect(detail.travelRule).toEqual([]);
    // The state machine never even entered the gate.
    expect(await auditActions(compliance, 'Transaction', wd.id)).not.toContain('TRANSACTION_TRAVEL_RULE_CHECK');
  },
);

test(
  'T: exactly 1000.00 cross-VASP cannot leave TRAVEL_RULE_CHECK without originator AND beneficiary data',
  { tag: '@compliance', annotation: [RULE, { type: 'boundary', description: 'T=1000.00' }] },
  async ({ asOperatorA, asOperatorB, asAdmin, asCompliance, build }) => {
    const operatorA = new ApiClient(asOperatorA);
    const operatorB = new ApiClient(asOperatorB);
    const admin = new ApiClient(asAdmin);
    const compliance = new ApiClient(asCompliance);

    const funded = await build.fundedWallet({ asset: 'GBPX', amount: '5000.00' });
    const address = await build.activeAddress({ accountId: funded.accountId, asset: 'GBPX' });
    const wd = await build.withdrawal({
      walletId: funded.walletId,
      amount: '1000.00', // EXACTLY the threshold: "at or above" — the >= boundary itself
      address: address.address,
      vaspId: build.uniqueRef('vasp'),
    });

    const first = await decide(operatorB, wd.id, 'APPROVE');
    expect(first.status).toBe(201);
    expect(first.json.state).toBe('PENDING_APPROVAL');

    // THE boundary assertion: at exactly T the gate MUST engage. (An off-by-one
    // `>` would let this broadcast with no record — the §D.2 walkthrough case.)
    const second = await decide(admin, wd.id, 'APPROVE');
    expect(second.status).toBe(201);
    expect(second.json.state).toBe('TRAVEL_RULE_CHECK');

    // Gated means GATED: no record yet, and nothing has been debited.
    const gated = await withdrawalDetail(operatorA, wd.id);
    expect(gated.travelRule).toEqual([]);
    expect(await walletBalance(operatorA, funded.walletId)).toBe('5000.00');

    // An incomplete originator (no physical address or date of birth) must NOT
    // open the gate — the rule requires the data, not the attempt.
    const incomplete = await compliance.post(`/withdrawals/${wd.id}/travel-rule`, {
      originator: { name: 'Aldgate Digital Partners LLP (fictional)', accountRef: 'acct-originator-ref' },
      beneficiary: travelRulePayload().beneficiary,
    });
    expect(incomplete.status).toBe(422);
    expect((await withdrawalDetail(operatorA, wd.id)).state).toBe('TRAVEL_RULE_CHECK');

    // The complete payload opens the gate and the withdrawal broadcasts.
    const payload = travelRulePayload();
    const attach = await compliance.post<{ state: string }>(`/withdrawals/${wd.id}/travel-rule`, payload);
    expect(attach.status).toBe(201);
    expect(attach.json.state).toBe('PENDING_CONFIRMATION');

    // Assert the RECORD CONTENTS, not just the count: both directions present
    // and every field of what compliance filed round-trips intact.
    const detail = await withdrawalDetail(operatorA, wd.id);
    const originator = detail.travelRule.find((r) => r.direction === 'ORIGINATOR');
    const beneficiary = detail.travelRule.find((r) => r.direction === 'BENEFICIARY');
    expect(detail.travelRule).toHaveLength(2);
    expect(originator?.payload).toEqual(payload.originator);
    expect(beneficiary?.payload).toEqual(payload.beneficiary);
  },
);

test(
  'T+1: 1000.01 cross-VASP is gated identically — record required before broadcast',
  { tag: '@compliance', annotation: [RULE, { type: 'boundary', description: 'T+1=1000.01' }] },
  async ({ asOperatorA, asOperatorB, asAdmin, asCompliance, build }) => {
    const operatorA = new ApiClient(asOperatorA);
    const operatorB = new ApiClient(asOperatorB);
    const admin = new ApiClient(asAdmin);
    const compliance = new ApiClient(asCompliance);

    const funded = await build.fundedWallet({ asset: 'GBPX', amount: '5000.00' });
    const address = await build.activeAddress({ accountId: funded.accountId, asset: 'GBPX' });
    const wd = await build.withdrawal({
      walletId: funded.walletId,
      amount: '1000.01',
      address: address.address,
      vaspId: build.uniqueRef('vasp'),
    });

    await decide(operatorB, wd.id, 'APPROVE');
    const second = await decide(admin, wd.id, 'APPROVE');
    expect(second.status).toBe(201);
    expect(second.json.state).toBe('TRAVEL_RULE_CHECK');
    expect((await withdrawalDetail(operatorA, wd.id)).travelRule).toEqual([]);

    const payload = travelRulePayload();
    const attach = await compliance.post<{ state: string }>(`/withdrawals/${wd.id}/travel-rule`, payload);
    expect(attach.status).toBe(201);
    expect(attach.json.state).toBe('PENDING_CONFIRMATION');

    const detail = await withdrawalDetail(operatorA, wd.id);
    expect(detail.travelRule.map((r) => r.direction).sort()).toEqual(['BENEFICIARY', 'ORIGINATOR']);
    expect(detail.travelRule.find((r) => r.direction === 'ORIGINATOR')?.payload).toEqual(payload.originator);
  },
);
