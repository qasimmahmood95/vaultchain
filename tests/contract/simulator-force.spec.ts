// Contract: POST /simulator/tx/{id}/force (openapi/vaultchain.yaml) — the one
// simulator control that can move money (D14 refund). P2 review Major 2:
// previously the 200 TransactionRaw envelope and the 404/409 problem responses
// were asserted by nothing. Lifecycle/refund semantics live in the serialized
// workflow suite (forced-outcome.spec.ts); this file pins shapes only.
//
// PARALLEL-SAFETY: the force target is a PENDING_APPROVAL withdrawal — a
// state no concurrent test's chain advance can settle out from under us.
// (A pending DEPOSIT would be credited by any parallel advanceBlocks and turn
// the expected 200 into a 409 — observed once before this design.)

import { test, ApiClient } from '../fixtures/index.js';
import { expect, expectProblem } from './support/matchers.js';
import { TransactionRawSchema } from './schemas/index.js';

test('force FAILED -> 200 TransactionRaw; repeat -> 409; unknown id -> 404', async ({
  asAdmin,
  build,
}) => {
  const admin = new ApiClient(asAdmin);

  // Own pending withdrawal (maker = operatorA; nobody else approves it, and
  // block advances cannot move a PENDING_APPROVAL transaction).
  const funded = await build.fundedWallet({ asset: 'GBPX', amount: '3000.00' });
  const dest = await build.activeAddress({ accountId: funded.accountId, asset: 'GBPX' });
  const wd = await build.withdrawal({ walletId: funded.walletId, amount: '1500.00', address: dest.address });

  const forced = await admin.post(`/simulator/tx/${wd.id}/force`, { outcome: 'FAILED' });
  expect(forced.status).toBe(200);
  expect(forced.json).toMatchSchema(TransactionRawSchema);
  expect((forced.json as { state: string }).state).toBe('FAILED');

  // Already terminal -> 409 problem+json.
  const again = await admin.post(`/simulator/tx/${wd.id}/force`, { outcome: 'CONFIRMED' });
  expectProblem(again, 409);

  // Unknown transaction -> 404 problem+json.
  const missing = await admin.post(`/simulator/tx/${build.uniqueRef('no-such-tx')}/force`, { outcome: 'FAILED' });
  expectProblem(missing, 404);
});
