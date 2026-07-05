// Delayed webhook delivery (PRD §A.7, DECISIONS D10). P2 review Major 4: the
// PENDING -> DELIVERED transition is driven by the SIM clock via dueAtSimMs —
// this pins it. Serialized project: the global delay fault can't leak into a
// concurrent test, and the chain fixture's teardown resets it regardless.

import { test, expect, ApiClient } from '../fixtures/index.js';
import { findDepositDetectedDelivery, firstWallet, registerDeposit } from './support/helpers.js';

const DELAY_MS = 600_000n; // 10 sim-minutes

test('a delayed delivery stays PENDING until the sim clock passes dueAtSimMs, then flushes to DELIVERED', async ({
  asOperatorA,
  build,
  chain,
}) => {
  const operator = new ApiClient(asOperatorA);
  const account = await build.account({ assets: ['GBPX'] });
  const wallet = firstWallet(account);

  await chain.setWebhookDelayMs(DELAY_MS);
  const before = BigInt((await chain.state()).simClockMs);

  const dep = await registerDeposit(operator, wallet.id, '100.00', build.uniqueRef('dep-delay'));
  expect(dep.status).toBe(201);

  // Withheld: recorded, unattempted, due in the future on the SIM clock.
  const pending = await findDepositDetectedDelivery(operator, dep.json.id);
  expect(pending.status).toBe('PENDING');
  expect(pending.attempts).toBe(0);
  expect(BigInt(pending.dueAtSimMs)).toBeGreaterThanOrEqual(before + DELAY_MS);

  // Not yet due: a jump SHORT of the delay must not flush it.
  await chain.advanceClockMs(DELAY_MS / 2n);
  const stillPending = await findDepositDetectedDelivery(operator, dep.json.id);
  expect(stillPending.status).toBe('PENDING');

  // Past due: the clock movement flushes it.
  await chain.advanceClockMs(DELAY_MS);
  const delivered = await findDepositDetectedDelivery(operator, dep.json.id);
  expect(delivered.status).toBe('DELIVERED');
  expect(delivered.attempts).toBe(1);
});
