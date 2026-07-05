// Webhook stubs (PRD §A.4): deliveries are signed and recorded locally —
// no outbound HTTP (§C.1 non-goal, DECISIONS.md D10). The simulator can
// delay or replay deliveries; replay of deposit events feeds back into the
// deposit handler, which is the idempotency surface.

import { createHmac } from 'node:crypto';
import type { Db } from '../db.js';
import { getChain, simNow } from './clock.js';

export function signPayload(secret: string, rawPayload: string): string {
  return `sha256=${createHmac('sha256', secret).update(rawPayload).digest('hex')}`;
}

/** Record a delivery for every subscription listening to `event`. */
export async function emitEvent(db: Db, event: string, payload: Record<string, unknown>): Promise<void> {
  const subscriptions = await db.webhookSubscription.findMany();
  const chain = await getChain(db);
  const delayMs = BigInt(chain.webhookDelayMs);
  const now = BigInt(chain.simClockMs);
  const raw = JSON.stringify({ event, ...payload });

  for (const sub of subscriptions) {
    const events = JSON.parse(sub.events) as string[];
    if (!events.includes(event)) continue;
    const delayed = delayMs > 0n;
    await db.webhookDelivery.create({
      data: {
        subscriptionId: sub.id,
        event,
        payload: raw,
        signature: signPayload(sub.secret, raw),
        attempts: delayed ? 0 : 1,
        status: delayed ? 'PENDING' : 'DELIVERED',
        dueAtSimMs: (now + delayMs).toString(),
        // deliveredAt is wall-clock metadata, not domain time — all gating uses the sim clock.
        ...(delayed ? {} : { deliveredAt: new Date() }),
      },
    });
  }
}

/** Mark PENDING deliveries whose due time has passed on the sim clock as DELIVERED. */
export async function flushDueWebhooks(db: Db): Promise<number> {
  const now = await simNow(db);
  const pending = await db.webhookDelivery.findMany({ where: { status: 'PENDING' } });
  let flushed = 0;
  for (const delivery of pending) {
    if (BigInt(delivery.dueAtSimMs) <= now) {
      // CAS on status so concurrent flushes can't both increment `attempts`
      // for the same delivery — only the PENDING -> DELIVERED winner counts
      // (P3 review Nit 2, same class as the Major 3 settlement race).
      const claimed = await db.webhookDelivery.updateMany({
        where: { id: delivery.id, status: 'PENDING' },
        data: { status: 'DELIVERED', attempts: { increment: 1 }, deliveredAt: new Date() },
      });
      if (claimed.count === 1) flushed += 1;
    }
  }
  return flushed;
}
