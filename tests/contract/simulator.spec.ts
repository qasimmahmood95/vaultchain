// Contract: the /simulator control plane (openapi/vaultchain.yaml, tag
// `simulator`) — response shapes as ADMIN. Global-clock discipline (D21/D22):
// every clock movement here is FORWARD-only, values queued/set are the safe
// defaults (CLEAN, delay 0), and the reset test immediately restores forward
// time so parallel workers never observe a rewound world. NOTHING here asserts
// on clock position — shapes only.

import { test, ApiClient } from '../fixtures/index.js';
import { expect } from './support/matchers.js';
import {
  ChainAdvanceResultSchema,
  ChainStateSchema,
  ScreeningQueuedSchema,
  WebhookDelaySetSchema,
} from './schemas/index.js';

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

// NOTE: the POST /simulator/clock/set shape test lives in the SERIALIZED
// workflow project (tests/workflow/simulator-reset.spec.ts). clock/set is
// ABSOLUTE (last-writer-wins): even a "forward" target computed from a stale
// read can land after a concurrent worker's higher one and rewind global time
// — the exact race D26 removed from the fixtures. No absolute clock ops in
// this fully-parallel project; relative clock/advance is tested above.

test('POST /simulator/clock/advance -> 200 ChainState (atomic relative advance, D26)', async ({
  asAdmin,
}) => {
  // Relative + forward-only by construction: parallel-safe with no recovery.
  const res = await new ApiClient(asAdmin).post('/simulator/clock/advance', { ms: '60000' });
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

// NOTE: the POST /simulator/reset shape test lives in the SERIALIZED workflow
// project (tests/workflow/simulator-reset.spec.ts) — reset rewinds the
// platform-global clock/height, which this fully-parallel project must never
// do (P2 review Minor 6; formerly self-healed here via support/robust.ts,
// both now deleted).
