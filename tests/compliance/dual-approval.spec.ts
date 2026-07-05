// @compliance — dual approval / maker-checker under concurrency (PRD §A.3.2, §B.3).
//
// THE RULE: APPROVED requires N distinct NON-MAKER approvers. Neither a maker
// approving their own withdrawal nor the same checker deciding twice may ever
// count toward N — including when the requests arrive simultaneously.
//
// THE PROBE: one withdrawal above the policy threshold (N=2), then a single
// Promise.all volley of three simultaneous decisions — the maker, checker B,
// and checker B AGAIN. There are deliberately NO awaits between the fires; the
// three requests are in flight together, so a check-then-act approval path
// with no transaction/unique-constraint would double-count the duplicate.
// The withdrawal is domestic (no vaspId) and value-disciplined (1500.00 GBPX,
// exact 1.50 fee), so no downstream Travel-Rule/screening/rounding behaviour
// can interfere with the approval-gate assertion (BUGS-independence pattern).
//
// STRESS VARIANT (documented invocation — the same probe, raced repeatedly;
// each repetition creates its own withdrawal):
//   npx playwright test --project=compliance --no-deps --grep "dual approval" --repeat-each=10
// Gate policy §B.6 applies: 0 retries — a maker-checker probe that only passes
// on retry is a race, not a pass.

import { test, expect, ApiClient } from '../fixtures/index.js';
import { apiKeyIdOf, decide, withdrawalDetail } from './support/helpers.js';

test(
  'dual approval under concurrency: a simultaneous volley (maker + duplicate checker) cannot mint APPROVED',
  { tag: '@compliance', annotation: [{ type: 'rule', description: 'MC-DUAL-APPROVAL' }] },
  async ({ asOperatorA, asOperatorB, asAdmin, build }) => {
    const maker = new ApiClient(asOperatorA); // operator A created the withdrawal
    const checkerB = new ApiClient(asOperatorB);
    const admin = new ApiClient(asAdmin);
    const [makerId, checkerBId, adminId] = await Promise.all([
      apiKeyIdOf(maker),
      apiKeyIdOf(checkerB),
      apiKeyIdOf(admin),
    ]);

    const funded = await build.fundedWallet({ asset: 'GBPX', amount: '10000.00' });
    const address = await build.activeAddress({ accountId: funded.accountId, asset: 'GBPX' });
    // 1500.00 > policy threshold 1000.00 -> 2 distinct non-maker approvals required.
    const wd = await build.withdrawal({ walletId: funded.walletId, amount: '1500.00', address: address.address });

    // THE VOLLEY — three decisions in flight at once, no serializing awaits.
    const volley = await Promise.all([
      decide(maker, wd.id, 'APPROVE'),
      decide(checkerB, wd.id, 'APPROVE'),
      decide(checkerB, wd.id, 'APPROVE'),
    ]);

    // Exactly one decision may survive: the maker is 403 in every interleaving
    // (maker≠checker) and one of checker B's pair is 409 (one decision per
    // approver per withdrawal — the unique-constraint 409, whichever fire lost).
    const statuses = volley.map((r) => r.status).sort((a, b) => a - b);
    expect(statuses).toEqual([201, 403, 409]);

    // State is consistent after the volley: one distinct non-maker approval is
    // 1 of 2 — still PENDING_APPROVAL, with exactly ONE approval row recorded
    // (no duplicate row, no maker row).
    const afterVolley = await withdrawalDetail(maker, wd.id);
    expect(afterVolley.state).toBe('PENDING_APPROVAL');
    const approveRows = afterVolley.approvals.filter((a) => a.decision === 'APPROVE');
    expect(approveRows).toHaveLength(1);
    expect(approveRows[0]?.approverApiKeyId).toBe(checkerBId);

    // A legitimate second checker completes it; the FINAL approver set is
    // exactly N=2 DISTINCT approvers, neither of them the maker.
    const completing = await decide(admin, wd.id, 'APPROVE');
    expect(completing.status).toBe(201);

    const final = await withdrawalDetail(maker, wd.id);
    // Domestic (no counterparty VASP): the Travel-Rule gate does not apply, so
    // approval completion runs straight through screening (clean) to broadcast.
    expect(final.state).toBe('PENDING_CONFIRMATION');
    const finalApprovers = final.approvals.filter((a) => a.decision === 'APPROVE').map((a) => a.approverApiKeyId);
    expect(finalApprovers).toHaveLength(2);
    expect(new Set(finalApprovers)).toEqual(new Set([checkerBId, adminId]));
    expect(finalApprovers).not.toContain(makerId); // never the maker
  },
);
