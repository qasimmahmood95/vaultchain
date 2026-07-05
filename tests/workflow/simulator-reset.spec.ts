// POST /simulator/reset — shape and semantics (PRD §A.7: resets chain/clock/
// fault state, NOT the database). Relocated from the contract project (P2
// review Minor 6): reset rewinds the platform-global clock and height, so it
// may only run where nothing else is in flight — this serialized project.
//
// After asserting, the test drives the world FORWARD again (blocks + clock)
// so later files in this serialized run inherit a self-consistent, active
// world (seeded allowlist entries and fresh builder data both work from any
// forward position).

import { test, expect, ApiClient, PAST_COOLING_OFF_MS } from '../fixtures/index.js';

interface ChainStateBody {
  id: string;
  blockHeight: number;
  simClockMs: string;
  frozen: boolean;
  webhookDelayMs: string;
  screeningNext: string | null;
}

test('reset restores chain/clock/fault defaults (not the DB), then the world moves forward again', async ({
  asAdmin,
  chain,
  build,
}) => {
  const admin = new ApiClient(asAdmin);

  // Disturb fault state first so the reset provably clears it.
  await chain.setWebhookDelayMs(60_000n);

  const reset = await admin.post<ChainStateBody>('/simulator/reset');
  expect(reset.status).toBe(200);
  expect(reset.json.blockHeight).toBe(0);
  expect(reset.json.simClockMs).toBe('1750000000000');
  expect(reset.json.frozen).toBe(false);
  expect(reset.json.webhookDelayMs).toBe('0');
  expect(reset.json.screeningNext).toBeNull();

  // NOT the database: seeded/built data survives (a fresh account builds fine
  // and its wallet reads back), proving reset touched only the control plane.
  const account = await build.account({ assets: ['GBPX'] });
  const wallet = await admin.get(`/wallets/${account.wallets[0]!.id}`);
  expect(wallet.status).toBe(200);

  // Drive the world forward for the rest of the serialized run.
  await chain.advanceBlocks(12);
  await chain.advanceClockMs(PAST_COOLING_OFF_MS);
  const after = await chain.state();
  expect(after.blockHeight).toBeGreaterThanOrEqual(12);
});

test('POST /simulator/clock/set (absolute) -> 200 ChainState — serialized-only shape test', async ({
  asAdmin,
  chain,
}) => {
  // clock/set is last-writer-wins, so its shape test lives HERE, not in the
  // parallel contract project (see D26 and the note in contract/simulator.spec).
  const admin = new ApiClient(asAdmin);
  const target = (BigInt((await chain.state()).simClockMs) + PAST_COOLING_OFF_MS).toString();
  const res = await admin.post<Record<string, unknown>>('/simulator/clock/set', { ms: target });
  expect(res.status).toBe(200);
  expect((res.json as { simClockMs: string }).simClockMs).toBe(target);
  expect(res.json.blockHeight).toEqual(expect.any(Number));
  expect(res.json.frozen).toEqual(expect.any(Boolean));
});
