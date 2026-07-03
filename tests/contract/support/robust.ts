// One-shot recovery for withdrawal-creation SETUP against global-clock skew.
//
// Why this exists (D22): the sim clock/height are platform-global. This
// suite's /simulator/reset shape test rewinds them for a few milliseconds
// before self-healing, and the fixtures' advanceClockMs is a read-modify-write
// jump — a builder whose read landed inside that window can briefly re-poison
// the clock. A withdrawal created in that sliver sees 422
// address-in-cooling-off (or insufficient-funds while a deposit's
// confirmations are still counting). The recovery below re-drives the world
// FORWARD once — to the address's own absolute activatesAt (+ a window), so
// it works no matter how far the clock was rewound — and retries the CREATION
// only. It never waits, never rewinds, and never asserts on clock position.
// Assertions are never retried — this is setup plumbing, not flake masking.

import {
  ApiClient,
  PAST_COOLING_OFF_MS,
  type ApiResult,
  type Build,
  type ChainApi,
  type TxHandle,
} from '../../fixtures/index.js';

const CONFIRMATIONS_FOR_ALL_ASSETS = 12; // matches the builders' funding advance

function recoverableMarker(text: string): 'address-in-cooling-off' | 'insufficient-funds' | undefined {
  if (text.includes('address-in-cooling-off')) return 'address-in-cooling-off';
  if (text.includes('insufficient-funds')) return 'insufficient-funds';
  return undefined;
}

async function recover(
  chain: ChainApi,
  marker: 'address-in-cooling-off' | 'insufficient-funds',
  activatesAt?: string,
): Promise<void> {
  if (marker === 'insufficient-funds') {
    await chain.advanceBlocks(CONFIRMATIONS_FOR_ALL_ASSETS);
    return;
  }
  // Cooling-off: a relative jump from a rewound clock may not reach the
  // entry's activation, so target the ABSOLUTE activatesAt plus a full window
  // — guarded to only ever move the clock forward.
  const current = BigInt((await chain.state()).simClockMs);
  const target = activatesAt
    ? BigInt(activatesAt) + PAST_COOLING_OFF_MS
    : current + PAST_COOLING_OFF_MS;
  await chain.setClockMs(target > current ? target : current + PAST_COOLING_OFF_MS);
}

/** `build.withdrawal` with one-shot forward-recovery on clock/height skew. */
export async function createWithdrawal(
  build: Build,
  chain: ChainApi,
  opts: Parameters<Build['withdrawal']>[0],
  activatesAt?: string,
): Promise<TxHandle> {
  try {
    return await build.withdrawal(opts);
  } catch (err) {
    const marker = recoverableMarker(String(err));
    if (!marker) throw err;
    await recover(chain, marker, activatesAt);
    return build.withdrawal(opts);
  }
}

/** Raw `POST /withdrawals` with the same one-shot forward-recovery. */
export async function postWithdrawal<T = Record<string, unknown>>(
  api: ApiClient,
  chain: ChainApi,
  body: Record<string, unknown>,
  activatesAt?: string,
): Promise<ApiResult<T>> {
  const first = await api.post<T>('/withdrawals', body);
  if (first.status !== 422) return first;
  const marker = recoverableMarker((first.json as { type?: string }).type ?? '');
  if (!marker) return first;
  await recover(chain, marker, activatesAt);
  return api.post<T>('/withdrawals', body);
}
