// The /simulator control plane (PRD §A.7) — the hooks that make async flows
// deterministic. Advancing the chain is the ONLY way confirmations accrue;
// setting the clock is the ONLY way time passes.

import type { PrismaClient, Transaction, WebhookDelivery } from '@prisma/client';
import { BLOCK_MS, type Actor } from '../config.js';
import { conflict, notFound } from '../errors.js';
import { writeAudit } from './audit.js';
import { getChain } from './clock.js';
import { onDepositWebhook, screenAndSettleDeposit, type CreditResult } from './deposits.js';
import { transitionTx } from './transitions.js';
import { emitEvent, flushDueWebhooks } from './webhooks.js';

export async function advanceChain(
  prisma: PrismaClient,
  blocks: number,
  actor: Actor,
): Promise<{ blockHeight: number; simClockMs: string; settled: number }> {
  // Height AND clock move RELATIVELY inside one DB transaction: a
  // non-transactional read-modify-write here can race /simulator/clock/advance
  // and write back a stale (lower) clock — the D26 rewind class.
  const { newHeight, newClock } = await prisma.$transaction(async (db) => {
    const chain = await getChain(db);
    const height = chain.blockHeight + blocks;
    const clock = chain.frozen
      ? BigInt(chain.simClockMs)
      : BigInt(chain.simClockMs) + BigInt(blocks) * BLOCK_MS;
    await db.chainState.update({
      where: { id: chain.id },
      data: { blockHeight: height, simClockMs: clock.toString() },
    });
    await writeAudit(db, {
      actor,
      action: 'SIM_CHAIN_ADVANCED',
      entityType: 'ChainState',
      entityId: chain.id,
      before: { blockHeight: chain.blockHeight },
      after: { blockHeight: height, simClockMs: clock.toString() },
    });
    return { newHeight: height, newClock: clock };
  });

  // Recompute confirmations; settle anything that has reached its requirement.
  const assets = await prisma.asset.findMany();
  const requiredBySymbol = new Map(assets.map((a) => [a.symbol, a.requiredConfirmations]));
  const pending = await prisma.transaction.findMany({ where: { state: 'PENDING_CONFIRMATION' } });
  let settled = 0;
  for (const tx of pending) {
    const confirmations = Math.max(0, newHeight - (tx.broadcastBlockHeight ?? newHeight));
    await prisma.transaction.update({ where: { id: tx.id }, data: { confirmations } });
    const required = requiredBySymbol.get(tx.assetSymbol) ?? Number.MAX_SAFE_INTEGER;
    if (confirmations < required) continue;
    settled += 1;
    if (tx.type === 'DEPOSIT') {
      await screenAndSettleDeposit(prisma, tx.id, actor);
    } else {
      const confirmed = await transitionTx(prisma, { ...tx, confirmations } as Transaction, 'CONFIRMED', actor);
      await emitEvent(prisma, 'withdrawal.confirmed', { transactionId: confirmed.id, confirmations });
    }
  }
  await flushDueWebhooks(prisma);
  return { blockHeight: newHeight, simClockMs: newClock.toString(), settled };
}

/**
 * Atomically advance the sim clock by a RELATIVE amount. Unlike clock/set
 * (absolute, last-writer-wins), concurrent relative advances serialize on the
 * DB write lock and can never rewind the clock past another caller's progress
 * — the primitive parallel test workers must use (D26).
 */
export async function advanceClockBy(prisma: PrismaClient, ms: string, actor: Actor): Promise<{ simClockMs: string }> {
  const updated = await prisma.$transaction(async (db) => {
    const chain = await getChain(db);
    const next = (BigInt(chain.simClockMs) + BigInt(ms)).toString();
    await db.chainState.update({ where: { id: chain.id }, data: { simClockMs: next } });
    await writeAudit(db, {
      actor,
      action: 'SIM_CLOCK_ADVANCED',
      entityType: 'ChainState',
      entityId: chain.id,
      before: { simClockMs: chain.simClockMs },
      after: { simClockMs: next },
    });
    return next;
  });
  await flushDueWebhooks(prisma);
  return { simClockMs: updated };
}

export async function setClock(prisma: PrismaClient, ms: string, actor: Actor): Promise<void> {
  const chain = await getChain(prisma);
  await prisma.chainState.update({ where: { id: chain.id }, data: { simClockMs: BigInt(ms).toString() } });
  await writeAudit(prisma, {
    actor,
    action: 'SIM_CLOCK_SET',
    entityType: 'ChainState',
    entityId: chain.id,
    before: { simClockMs: chain.simClockMs },
    after: { simClockMs: ms },
  });
  await flushDueWebhooks(prisma);
}

export async function freezeClock(prisma: PrismaClient, frozen: boolean, actor: Actor): Promise<void> {
  const chain = await getChain(prisma);
  await prisma.chainState.update({ where: { id: chain.id }, data: { frozen } });
  await writeAudit(prisma, {
    actor,
    action: frozen ? 'SIM_CLOCK_FROZEN' : 'SIM_CLOCK_UNFROZEN',
    entityType: 'ChainState',
    entityId: chain.id,
    after: { frozen },
  });
}

/** Force CONFIRMED or FAILED. A failed already-debited withdrawal is refunded (D14). */
export async function forceTxOutcome(
  prisma: PrismaClient,
  txId: string,
  outcome: 'CONFIRMED' | 'FAILED',
  actor: Actor,
): Promise<Transaction> {
  const tx = await prisma.transaction.findUnique({
    where: { id: txId },
    include: { wallet: { include: { account: true } } },
  });
  if (!tx) throw notFound('Transaction');
  if (['CONFIRMED', 'FAILED', 'CREDITED', 'REJECTED', 'CANCELLED'].includes(tx.state)) {
    throw conflict('already-terminal', `Transaction is already ${tx.state}`);
  }

  if (outcome === 'CONFIRMED') {
    const confirmed = await transitionTx(prisma, tx, 'CONFIRMED', actor);
    await emitEvent(prisma, 'withdrawal.confirmed', { transactionId: tx.id, forced: true });
    return confirmed;
  }

  const wasDebited = tx.type === 'WITHDRAWAL' && ['BROADCAST', 'PENDING_CONFIRMATION'].includes(tx.state);
  if (!wasDebited) return transitionTx(prisma, tx, 'FAILED', actor);

  return prisma.$transaction(async (db) => {
    const wallet = await db.wallet.findUniqueOrThrow({ where: { id: tx.walletId } });
    const refund = BigInt(tx.amountMinor) + BigInt(tx.feeMinor);
    await db.wallet.update({
      where: { id: wallet.id },
      data: { balanceMinor: (BigInt(wallet.balanceMinor) + refund).toString() },
    });
    const clientId = tx.wallet.account.clientId;
    await db.ledgerEntry.create({
      data: { walletId: wallet.id, clientId, direction: 'CREDIT', amountMinor: tx.amountMinor, kind: 'REFUND', txId: tx.id },
    });
    await db.ledgerEntry.create({
      data: { walletId: wallet.id, clientId, direction: 'CREDIT', amountMinor: tx.feeMinor, kind: 'REFUND', txId: tx.id },
    });
    return transitionTx(db, tx, 'FAILED', actor, { confirmations: tx.confirmations });
  });
}

export async function queueScreeningOutcome(prisma: PrismaClient, outcome: 'CLEAN' | 'FLAG', actor: Actor): Promise<void> {
  const chain = await getChain(prisma);
  await prisma.chainState.update({ where: { id: chain.id }, data: { screeningNext: outcome } });
  await writeAudit(prisma, {
    actor,
    action: 'SIM_SCREENING_QUEUED',
    entityType: 'ChainState',
    entityId: chain.id,
    after: { screeningNext: outcome },
  });
}

/** Re-deliver a webhook. Deposit events feed back into the (idempotent) credit handler. */
export async function replayWebhook(
  prisma: PrismaClient,
  deliveryId: string,
  actor: Actor,
): Promise<{ delivery: WebhookDelivery; creditResult: CreditResult | null }> {
  const delivery = await prisma.webhookDelivery.findUnique({ where: { id: deliveryId } });
  if (!delivery) throw notFound('Webhook delivery');
  const updated = await prisma.webhookDelivery.update({
    where: { id: delivery.id },
    // deliveredAt is wall-clock metadata, not domain time — all gating uses the sim clock.
    data: { attempts: { increment: 1 }, status: 'DELIVERED', deliveredAt: new Date() },
  });
  await writeAudit(prisma, {
    actor,
    action: 'SIM_WEBHOOK_REPLAYED',
    entityType: 'WebhookDelivery',
    entityId: delivery.id,
    after: { event: delivery.event, attempts: updated.attempts },
  });

  let creditResult: CreditResult | null = null;
  if (delivery.event.startsWith('deposit.')) {
    const payload = JSON.parse(delivery.payload) as { transactionId?: string };
    creditResult = await onDepositWebhook(prisma, payload, actor);
  }
  return { delivery: updated, creditResult };
}

export async function setWebhookDelay(prisma: PrismaClient, ms: string, actor: Actor): Promise<void> {
  const chain = await getChain(prisma);
  await prisma.chainState.update({ where: { id: chain.id }, data: { webhookDelayMs: BigInt(ms).toString() } });
  await writeAudit(prisma, {
    actor,
    action: 'SIM_WEBHOOK_DELAY_SET',
    entityType: 'ChainState',
    entityId: chain.id,
    after: { webhookDelayMs: ms },
  });
}

/** Reset chain/clock/fault state to defaults — not the database (PRD §A.7). */
export async function resetSimulator(prisma: PrismaClient, actor: Actor): Promise<void> {
  const chain = await getChain(prisma);
  await prisma.chainState.update({
    where: { id: chain.id },
    data: {
      blockHeight: 0,
      simClockMs: '1750000000000',
      frozen: false,
      webhookDelayMs: '0',
      screeningNext: null,
      forcedOutcomesJson: '{}',
    },
  });
  await writeAudit(prisma, {
    actor,
    action: 'SIM_RESET',
    entityType: 'ChainState',
    entityId: chain.id,
    before: { blockHeight: chain.blockHeight, simClockMs: chain.simClockMs },
    after: { blockHeight: 0, simClockMs: '1750000000000' },
  });
}
