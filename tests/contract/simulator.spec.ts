// Contract: the /simulator control plane (openapi/vaultchain.yaml, tag
// `simulator`) — response shapes as ADMIN. Global-clock discipline (D21/D22):
// every clock movement here is FORWARD-only, values queued/set are the safe
// defaults (CLEAN, delay 0), and the reset test immediately restores forward
// time so parallel workers never observe a rewound world. NOTHING here asserts
// on clock position — shapes only.

import { test, ApiClient, PAST_COOLING_OFF_MS } from '../fixtures/index.js';
import { expect } from './support/matchers.js';
import {
  ChainAdvanceResultSchema,
  ChainStateSchema,
  ScreeningQueuedSchema,
  WebhookDelaySetSchema,
} from './schemas/index.js';

interface ChainStateBody {
  blockHeight: number;
  simClockMs: string;
}

test('GET /simulator/state -> 200 ChainState', async ({ asAdmin }) => {
  const res = await new ApiClient(asAdmin).get('/simulator/state');
  expect(res.status).toBe(200);
  expect(res.json).toMatchSchema(ChainStateSchema);
});

test('POST /simulator/chain/advance -> 200 {blockHeight, simClockMs, settled}', async ({
  asAdmin,
}) => {
  const res = await new ApiClient(asAdmin).post('/simulator/chain/advance', { blocks: 1 });
  expect(res.status).toBe(200);
  expect(res.json).toMatchSchema(ChainAdvanceResultSchema);
});

test('POST /simulator/clock/set (forward) -> 200 ChainState', async ({ asAdmin }) => {
  const api = new ApiClient(asAdmin);
  const current = await api.get<ChainStateBody>('/simulator/state');
  // Forward by a FULL cooling-off window — the same delta the builders use.
  // (A small delta could land after a concurrent builder jump and effectively
  // rewind the shared clock; +25h keeps any interleaving forward-equivalent.)
  const target = (BigInt(current.json.simClockMs) + PAST_COOLING_OFF_MS).toString();
  const res = await api.post('/simulator/clock/set', { ms: target });
  expect(res.status).toBe(200);
  expect(res.json).toMatchSchema(ChainStateSchema);
});

test('POST /simulator/screening/next -> 200 {queued} (CLEAN: the safe default)', async ({
  asAdmin,
}) => {
  const res = await new ApiClient(asAdmin).post('/simulator/screening/next', { outcome: 'CLEAN' });
  expect(res.status).toBe(200);
  expect(res.json).toMatchSchema(ScreeningQueuedSchema);
  expect((res.json as { queued: string }).queued).toBe('CLEAN');
});

test('POST /simulator/webhooks/delay -> 200 {webhookDelayMs} (0: the default)', async ({
  asAdmin,
}) => {
  const res = await new ApiClient(asAdmin).post('/simulator/webhooks/delay', { ms: '0' });
  expect(res.status).toBe(200);
  expect(res.json).toMatchSchema(WebhookDelaySetSchema);
  expect((res.json as { webhookDelayMs: string }).webhookDelayMs).toBe('0');
});

test('POST /simulator/reset -> 200 ChainState (world restored forward immediately)', async ({
  asAdmin,
}) => {
  const api = new ApiClient(asAdmin);
  const before = await api.get<ChainStateBody>('/simulator/state');
  // Heal target: comfortably FORWARD of anything the pre-reset world could
  // have scheduled (several cooling-off windows past the pre-reset clock, so
  // even entries created by jumps that interleaved with this test stay active).
  const target = BigInt(before.json.simClockMs) + 6n * PAST_COOLING_OFF_MS;

  const reset = await api.post('/simulator/reset');

  // SELF-HEAL FIRST, assert after — reset rewinds the platform-global clock
  // and block height to defaults, which parallel workers must never observe.
  // 1) Height: advance is RELATIVE, so restoring the pre-reset height keeps
  //    in-flight deposit confirmations counting forward (and re-settles any
  //    that advanced during the window).
  const resetState = reset.json as Partial<ChainStateBody>;
  const blockDelta = before.json.blockHeight - (resetState.blockHeight ?? 0);
  if (blockDelta > 0) {
    await api.post('/simulator/chain/advance', { blocks: blockDelta });
  }
  // 2) Clock: raise to the target, then verify-and-repair a few times — a
  //    concurrent read-modify-write jump (builders) that read the rewound
  //    clock inside this window would otherwise re-poison it. Guarded sets
  //    only ever move the clock FORWARD (D22).
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const now = await api.get<ChainStateBody>('/simulator/state');
    if (BigInt(now.json.simClockMs) >= target) break;
    await api.post('/simulator/clock/set', { ms: target.toString() });
  }

  expect(reset.status).toBe(200);
  expect(reset.json).toMatchSchema(ChainStateSchema);
});
