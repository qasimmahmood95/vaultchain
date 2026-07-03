// Idempotency (PRD §A.3.1 / §A.4): (a) a reused idempotencyKey returns the
// EXISTING withdrawal (200, same id) instead of creating another; (b) a
// replayed deposit webhook must NOT credit twice — the platform credits
// exactly once per on-chain event, keyed (walletId, chainTxRef).
//
// Both defences are exact-value assertions (same id / same balance string),
// never >= — a double-credit must fail loudly.

import { test, expect, ApiClient } from '../fixtures/index.js';
import {
  findDepositDetectedDelivery,
  walletBalance,
  type PageResponse,
  type TxResponse,
} from './support/helpers.js';

test.describe('idempotency', () => {
  test('duplicate idempotencyKey: exact same request replays the SAME withdrawal with 200', async ({
    asOperatorA,
    build,
  }) => {
    const operatorA = new ApiClient(asOperatorA);
    const funded = await build.fundedWallet({ asset: 'GBPX', amount: '10000.00' });
    const address = await build.activeAddress({ accountId: funded.accountId, asset: 'GBPX' });
    const idempotencyKey = build.uniqueRef('idem');

    const body = {
      walletId: funded.walletId,
      amount: '1500.00',
      counterpartyAddress: address.address,
      idempotencyKey,
    };

    const first = await operatorA.post<TxResponse>('/withdrawals', body);
    expect(first.status).toBe(201);
    expect(first.json.idempotencyKey).toBe(idempotencyKey);

    // EXACT same request again: replay, not a new resource.
    const second = await operatorA.post<TxResponse>('/withdrawals', body);
    expect(second.status).toBe(200);
    expect(second.json.id).toBe(first.json.id);

    // The wallet-scoped listing shows exactly ONE withdrawal with that key.
    const list = await operatorA.get<PageResponse<TxResponse>>(
      `/withdrawals?walletId=${funded.walletId}&limit=100`,
    );
    expect(list.status).toBe(200);
    const withKey = list.json.items.filter((w) => w.idempotencyKey === idempotencyKey);
    expect(withKey).toHaveLength(1);
    expect(withKey[0]!.id).toBe(first.json.id);
  });

  test('webhook replay: a re-delivered deposit.detected does NOT credit the deposit twice', async ({
    asOperatorA,
    build,
    chain,
  }) => {
    const operatorA = new ApiClient(asOperatorA);

    // fundedWallet's deposit is already CREDITED (the builder advances blocks).
    const funded = await build.fundedWallet({ asset: 'GBPX', amount: '10000.00' });

    // Exact balance BEFORE the replay: credited exactly once.
    expect(await walletBalance(operatorA, funded.walletId)).toBe('10000.00');

    // Find OUR deposit.detected delivery (payload.transactionId matches) and
    // replay it — the redelivery re-enters the platform's credit handler.
    const delivery = await findDepositDetectedDelivery(operatorA, funded.depositTxId);
    const replay = await chain.replayWebhook(delivery.id);
    expect(replay.status).toBe(200);

    // Exact balance AFTER the replay: UNCHANGED — the on-chain event
    // (walletId, chainTxRef) was already processed; no double credit.
    expect(await walletBalance(operatorA, funded.walletId)).toBe('10000.00');
  });
});
