// Concurrent Travel-Rule attach must be idempotent/atomic (adversarial gate F3).
// The attach path creates the ORIGINATOR + BENEFICIARY records then runs the
// screening/broadcast gate; without a guard, two simultaneous attaches on one
// TRAVEL_RULE_CHECK withdrawal both wrote records + a duplicate
// TRAVEL_RULE_ATTACHED audit row — violating the "exactly once" property the
// audit gate depends on. The (transactionId, direction) unique constraint now
// makes the loser fail with 409, so exactly one attach takes effect.

import { test, expect, ApiClient } from '../fixtures/index.js';
import { auditActions, decide, travelRulePayload, type WithdrawalDetailResponse } from './support/helpers.js';

test('concurrent Travel-Rule attach: exactly one succeeds; records and audit are not duplicated', async ({
  asOperatorA,
  asOperatorB,
  asAdmin,
  asCompliance,
  build,
}) => {
  const operatorA = new ApiClient(asOperatorA);
  const operatorB = new ApiClient(asOperatorB);
  const admin = new ApiClient(asAdmin);
  const compliance = new ApiClient(asCompliance);

  const funded = await build.fundedWallet({ asset: 'GBPX', amount: '10000.00' });
  const dest = await build.activeAddress({ accountId: funded.accountId, asset: 'GBPX' });
  // Cross-VASP, above the policy + Travel-Rule threshold -> gates at TRAVEL_RULE_CHECK.
  const wd = await build.withdrawal({
    walletId: funded.walletId,
    amount: '1500.00',
    address: dest.address,
    vaspId: build.uniqueRef('vasp'),
  });
  await decide(operatorB, wd.id, 'APPROVE');
  const second = await decide(admin, wd.id, 'APPROVE');
  expect(second.json.state).toBe('TRAVEL_RULE_CHECK');

  // Two simultaneous attaches, no serializing await between the fires.
  const payload = travelRulePayload();
  const volley = await Promise.all([
    compliance.post(`/withdrawals/${wd.id}/travel-rule`, payload),
    compliance.post(`/withdrawals/${wd.id}/travel-rule`, payload),
  ]);
  // Exactly one wins; the loser is a clean 409 (unique-constraint or state guard),
  // never a duplicate success.
  expect(volley.map((r) => r.status).sort((a, b) => a - b)).toEqual([201, 409]);

  // Exactly two records (one per direction) and exactly one attach audit row.
  const detail = await operatorA.get<WithdrawalDetailResponse>(`/withdrawals/${wd.id}`);
  expect(detail.json.travelRule.map((r) => r.direction).sort()).toEqual(['BENEFICIARY', 'ORIGINATOR']);
  const actions = await auditActions(compliance, wd.id);
  expect(actions.filter((a) => a === 'TRAVEL_RULE_ATTACHED')).toHaveLength(1);
  // And the winner drove the gate exactly once (single screening transition).
  expect(actions.filter((a) => a === 'TRANSACTION_SCREENING')).toHaveLength(1);
});
