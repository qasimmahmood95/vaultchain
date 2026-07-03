// Deposit lifecycle (PRD §A.3.1): DETECTED -> PENDING_CONFIRMATION ->
// (confirmations >= required) -> SCREENING -> CREDITED | HELD.
// Crediting is EXACTLY ONCE per on-chain event, keyed (walletId, chainTxRef)
// through the ProcessedEvent unique constraint — a replayed webhook is a no-op.

import { type PrismaClient, type Transaction } from '@prisma/client';
import type { Actor } from '../config.js';
import { conflict, notFound, unprocessable } from '../errors.js';
import { getChain } from './clock.js';
import { toMinor } from './money.js';
import { openHold } from './holds.js';
import { nextScreeningOutcome } from './screening.js';
import { claimTransition, transitionTx } from './transitions.js';
import { emitEvent } from './webhooks.js';
import { writeAudit } from './audit.js';

export async function registerDeposit(
  prisma: PrismaClient,
  input: { walletId: string; amount: string; chainTxRef: string; actor: Actor },
): Promise<Transaction> {
  const wallet = await prisma.wallet.findUnique({ where: { id: input.walletId } });
  if (!wallet) throw notFound('Wallet');
  const asset = await prisma.asset.findUnique({ where: { symbol: wallet.assetSymbol } });
  if (!asset) throw notFound('Asset');

  const duplicate = await prisma.transaction.findFirst({
    where: { walletId: wallet.id, chainTxRef: input.chainTxRef, type: 'DEPOSIT' },
  });
  if (duplicate) throw conflict('duplicate-chain-tx-ref', `Deposit for chainTxRef ${input.chainTxRef} already registered`);

  const amountMinor = toMinor(input.amount, asset.decimals);
  if (amountMinor <= 0n) throw unprocessable('invalid-amount', 'Deposit amount must be positive');

  const chain = await getChain(prisma);
  const tx = await prisma.transaction.create({
    data: {
      walletId: wallet.id,
      type: 'DEPOSIT',
      assetSymbol: asset.symbol,
      amountMinor: amountMinor.toString(),
      state: 'DETECTED',
      chainTxRef: input.chainTxRef,
      broadcastBlockHeight: chain.blockHeight,
      createdByApiKeyId: input.actor.apiKeyId,
    },
  });
  await writeAudit(prisma, {
    actor: input.actor,
    action: 'DEPOSIT_DETECTED',
    entityType: 'Transaction',
    entityId: tx.id,
    after: { state: 'DETECTED', amountMinor: tx.amountMinor, chainTxRef: input.chainTxRef },
  });
  const pending = await transitionTx(prisma, tx, 'PENDING_CONFIRMATION', input.actor);
  await emitEvent(prisma, 'deposit.detected', {
    transactionId: tx.id,
    walletId: wallet.id,
    chainTxRef: input.chainTxRef,
    amountMinor: tx.amountMinor,
    assetSymbol: asset.symbol,
  });
  return pending;
}

export interface CreditResult {
  credited: boolean;
  reason: 'credited' | 'already-credited' | 'not-creditable';
}

/**
 * Credit a confirmed, screened deposit — exactly once per on-chain event.
 * Balance mutation, ledger row, ProcessedEvent claim, state transition, and
 * audit entry all commit in one DB transaction.
 */
export async function creditDeposit(prisma: PrismaClient, txId: string, actor: Actor | null): Promise<CreditResult> {
  return prisma.$transaction(async (db) => {
    const tx = await db.transaction.findUnique({
      where: { id: txId },
      include: { wallet: { include: { account: true } } },
    });
    if (!tx || tx.type !== 'DEPOSIT' || tx.chainTxRef === null) throw notFound('Deposit');

    // Only screened (SCREENING) or hold-released (HELD) deposits are creditable;
    // CREDITED falls through to the ProcessedEvent claim, which makes replays no-ops.
    if (!['SCREENING', 'HELD', 'CREDITED'].includes(tx.state)) {
      return { credited: false, reason: 'not-creditable' };
    }

    const newBalance = BigInt(tx.wallet.balanceMinor) + BigInt(tx.amountMinor);
    await db.wallet.update({ where: { id: tx.walletId }, data: { balanceMinor: newBalance.toString() } });
    await db.ledgerEntry.create({
      data: {
        walletId: tx.walletId,
        clientId: tx.wallet.account.clientId,
        direction: 'CREDIT',
        amountMinor: tx.amountMinor,
        kind: 'PRINCIPAL',
        txId: tx.id,
      },
    });
    await transitionTx(db, tx, 'CREDITED', actor);
    await emitEvent(db, 'deposit.credited', {
      transactionId: tx.id,
      walletId: tx.walletId,
      chainTxRef: tx.chainTxRef,
      amountMinor: tx.amountMinor,
    });
    return { credited: true, reason: 'credited' };
  });
}

/**
 * Confirmations reached: screen, then credit or hold. Returns whether THIS
 * caller settled it. The PENDING_CONFIRMATION -> SCREENING move is a
 * compare-and-set claim, so under concurrent chain advances only the winner
 * screens — no double screening-queue consumption or duplicate audit rows
 * (P3 review Major 3).
 */
export async function screenAndSettleDeposit(prisma: PrismaClient, txId: string, actor: Actor | null): Promise<boolean> {
  const screening = await claimTransition(prisma, txId, 'PENDING_CONFIRMATION', 'SCREENING', actor);
  if (!screening) return false;
  const outcome = await nextScreeningOutcome(prisma);
  if (outcome === 'FLAG') {
    await transitionTx(prisma, screening, 'HELD', actor);
    await openHold(prisma, { transactionId: txId, reason: 'SCREENING_FLAG', actor });
    return true;
  }
  await creditDeposit(prisma, txId, actor);
  return true;
}

/**
 * Entry point for (re)delivered deposit webhooks. Idempotent by construction:
 * crediting is keyed off the ON-CHAIN EVENT (walletId, chainTxRef) via
 * creditDeposit's ProcessedEvent claim, never off the delivery itself.
 */
export async function onDepositWebhook(
  prisma: PrismaClient,
  payload: { transactionId?: string },
  actor: Actor | null,
): Promise<CreditResult> {
  if (!payload.transactionId) return { credited: false, reason: 'not-creditable' };
  return creditDeposit(prisma, payload.transactionId, actor);
}
