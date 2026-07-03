// Fake-chain time control (PRD §B.2): a test-scoped `chain` fixture wrapping
// /simulator so async flows are driven explicitly — never by waiting.
//
// CLOCK CONVENTION (important, see DECISIONS.md D21/D22):
//   The sim clock and block height are PLATFORM-GLOBAL state, shared by every
//   worker. They therefore move FORWARD ONLY during a suite run: fixtures jump
//   the clock ahead (cooling-off, confirmations) but never rewind it, and the
//   teardown resets FAULT state only (webhook delay, queued screening) — not
//   the clock. Time-SENSITIVE assertions (e.g. "still in cooling-off") live
//   only in the serialized workflow project. chain.reset() exists for
//   explicit, deliberate use and is not called automatically.

import { test as base, request, type APIRequestContext } from '@playwright/test';
import { RAW_KEYS } from '../../scripts/seed-lib.js';
import { API_BASE } from './api-client.js';

export interface ChainState {
  blockHeight: number;
  simClockMs: string;
  frozen: boolean;
  webhookDelayMs: string;
  screeningNext: string | null;
}

export interface ChainApi {
  /** Current /simulator/state. */
  state(): Promise<ChainState>;
  /** Advance N blocks (settles confirmations; moves the clock unless frozen). */
  advanceBlocks(blocks: number): Promise<{ blockHeight: number; settled: number }>;
  /** Jump the sim clock FORWARD by `ms` (reads current state, sets now+ms). */
  advanceClockMs(ms: bigint): Promise<void>;
  /** Set the sim clock to an absolute value — forward-only by convention. */
  setClockMs(ms: bigint): Promise<void>;
  /** Freeze/unfreeze block-driven clock movement. */
  freeze(frozen?: boolean): Promise<void>;
  /** Queue the next screening decision (consumed once by the platform). */
  queueScreening(outcome: 'CLEAN' | 'FLAG'): Promise<void>;
  /** Re-deliver a recorded webhook; deposit events re-enter the credit handler. */
  replayWebhook(deliveryId: string): Promise<{ status: number; json: Record<string, unknown> }>;
  /** Delay all webhook deliveries by N sim-ms (reset to 0 in teardown). */
  setWebhookDelayMs(ms: bigint): Promise<void>;
  /** Full /simulator/reset — EXPLICIT use only; rewinds the global clock. */
  reset(): Promise<void>;
}

async function adminContext(): Promise<APIRequestContext> {
  return request.newContext({
    baseURL: API_BASE,
    extraHTTPHeaders: { 'x-api-key': RAW_KEYS.admin },
  });
}

export const chainClockTest = base.extend<{ chain: ChainApi }>({
  chain: async ({}, use) => {
    const ctx = await adminContext();
    let delayTouched = false;
    let screeningTouched = false;

    const post = async (path: string, body?: unknown) => {
      const res = await ctx.post(path, body === undefined ? {} : { data: body });
      if (!res.ok()) throw new Error(`chain fixture: POST ${path} -> ${res.status()} ${await res.text()}`);
      return (await res.json()) as Record<string, unknown>;
    };

    const api: ChainApi = {
      async state() {
        const res = await ctx.get('/simulator/state');
        return (await res.json()) as unknown as ChainState;
      },
      async advanceBlocks(blocks) {
        const json = await post('/simulator/chain/advance', { blocks });
        return { blockHeight: json.blockHeight as number, settled: json.settled as number };
      },
      async advanceClockMs(ms) {
        const current = BigInt((await api.state()).simClockMs);
        await post('/simulator/clock/set', { ms: (current + ms).toString() });
      },
      async setClockMs(ms) {
        await post('/simulator/clock/set', { ms: ms.toString() });
      },
      async freeze(frozen = true) {
        await post('/simulator/clock/freeze', { frozen });
      },
      async queueScreening(outcome) {
        screeningTouched = true;
        await post('/simulator/screening/next', { outcome });
      },
      async replayWebhook(deliveryId) {
        const res = await ctx.post(`/simulator/webhooks/${deliveryId}/replay`);
        const text = await res.text();
        return { status: res.status(), json: (text ? JSON.parse(text) : {}) as Record<string, unknown> };
      },
      async setWebhookDelayMs(ms) {
        delayTouched = true;
        await post('/simulator/webhooks/delay', { ms: ms.toString() });
      },
      async reset() {
        await post('/simulator/reset');
      },
    };

    await use(api);

    // Teardown: auto-reset FAULT state only. The clock stays where it is —
    // forward-only global time (D22). A queued-but-unconsumed FLAG would
    // poison the next screening anywhere in the run; overwrite with CLEAN.
    if (screeningTouched) await post('/simulator/screening/next', { outcome: 'CLEAN' });
    if (delayTouched) await post('/simulator/webhooks/delay', { ms: '0' });
    await ctx.dispose();
  },
});
