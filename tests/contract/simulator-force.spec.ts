// Contract: POST /simulator/tx/{id}/force (openapi/vaultchain.yaml) — the one
// simulator control that can move money (D14 refund). P2 review Major 2:
// previously the 200 TransactionRaw envelope and the 404/409 problem responses
// were asserted by nothing. Lifecycle/refund semantics live in the serialized
// workflow suite (forced-outcome.spec.ts); this file pins shapes only.
//
// Forcing here targets THIS test's own deposit (safe under parallel workers:
// no clock reads, no screening queue, own data only).

import { test, ApiClient } from '../fixtures/index.js';
import { expect, expectProblem } from './support/matchers.js';
import { TransactionRawSchema } from './schemas/index.js';

test('force CONFIRMED -> 200 TransactionRaw; repeat -> 409; unknown id -> 404', async ({
  asOperatorA,
  asAdmin,
  build,
}) => {
  const operator = new ApiClient(asOperatorA);
  const admin = new ApiClient(asAdmin);

  // Own pending deposit (no chain advance needed — force is the point).
  const account = await build.account({ assets: ['GBPX'] });
  const wallet = account.wallets[0]!;
  const dep = await operator.post<{ id: string }>(`/wallets/${wallet.id}/deposits/simulate`, {
    amount: '10.00',
    chainTxRef: build.uniqueRef('force-dep'),
  });
  expect(dep.status).toBe(201);

  const forced = await admin.post(`/simulator/tx/${dep.json.id}/force`, { outcome: 'CONFIRMED' });
  expect(forced.status).toBe(200);
  expect(forced.json).toMatchSchema(TransactionRawSchema);

  // Already terminal -> 409 problem+json.
  const again = await admin.post(`/simulator/tx/${dep.json.id}/force`, { outcome: 'FAILED' });
  expectProblem(again, 409);

  // Unknown transaction -> 404 problem+json.
  const missing = await admin.post(`/simulator/tx/${build.uniqueRef('no-such-tx')}/force`, { outcome: 'FAILED' });
  expectProblem(missing, 404);
});
