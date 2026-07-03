// Withdrawal lifecycle (PRD §A.3.2). Gates in order: allowlist -> approval
// policy -> Travel Rule (AT OR ABOVE threshold, >=) -> screening -> broadcast
// -> confirmations. Funds (amount + fee) are debited at BROADCAST.

import type { PrismaClient, Transaction, Asset } from '@prisma/client';
import {
  MOCK_FIAT_RATES,
  TRAVEL_RULE_THRESHOLD_FIAT_MINOR,
  WITHDRAWAL_FEE_BPS,
  type Actor,
} from '../config.js';
import type { Db } from '../db.js';
import { conflict, forbidden, notFound, unprocessable } from '../errors.js';
import { findEntry, isActive } from './allowlist.js';
import { writeAudit } from './audit.js';
import { getChain } from './clock.js';
import { openHold } from './holds.js';
import { feeFor, roundHalfEvenDiv, toMinor } from './money.js';
import { nextScreeningOutcome } from './screening.js';
import { transitionTx } from './transitions.js';
import { emitEvent } from './webhooks.js';

/** Fiat-equivalent of an asset amount, in GBPX minor units (2 dp). */
export function fiatEquivalentMinor(amountMinor: bigint, asset: Pick<Asset, 'symbol' | 'decimals'>): bigint {
  const rate = MOCK_FIAT_RATES[asset.symbol];
  if (rate === undefined) throw unprocessable('unknown-asset', `No fiat rate for asset ${asset.symbol}`);
  return roundHalfEvenDiv(amountMinor * rate * 100n, 10n ** BigInt(asset.decimals));
}

/**
 * Travel Rule applies to cross-VASP transfers AT OR ABOVE the threshold
 * (PRD §A.3.3 — the boundary is inclusive: >=).
 */
export function requiresTravelRule(fiatMinor: bigint, crossVasp: boolean): boolean {
  return crossVasp && fiatMinor >= TRAVEL_RULE_THRESHOLD_FIAT_MINOR;
}

/** Approvals required for this withdrawal under the account's policy (DECISIONS.md D7). */
export async function requiredApprovalsFor(db: Db, tx: Transaction, accountId: string): Promise<{ required: number; makerCannotCheck: boolean }> {
  const policies = await db.approvalPolicy.findMany({ where: { accountId } });
  const policy = policies.find((p) => p.assetSymbol === tx.assetSymbol) ?? policies.find((p) => p.assetSymbol === null);
  if (!policy) return { required: 1, makerCannotCheck: true };
  const aboveThreshold = BigInt(tx.amountMinor) >= BigInt(policy.thresholdMinor);
  return { required: aboveThreshold ? policy.approvalsRequired : 1, makerCannotCheck: policy.makerCannotCheck };
}

export async function createWithdrawal(
  prisma: PrismaClient,
  input: {
    walletId: string;
    amount: string;
    counterpartyAddress: string;
    counterpartyVaspId?: string | undefined;
    idempotencyKey?: string | undefined;
    actor: Actor;
  },
): Promise<{ tx: Transaction; created: boolean }> {
  if (input.idempotencyKey) {
    const existing = await prisma.transaction.findUnique({ where: { idempotencyKey: input.idempotencyKey } });
    if (existing) return { tx: existing, created: false };
  }

  const wallet = await prisma.wallet.findUnique({ where: { id: input.walletId }, include: { account: true } });
  if (!wallet) throw notFound('Wallet');
  const asset = await prisma.asset.findUnique({ where: { symbol: wallet.assetSymbol } });
  if (!asset) throw notFound('Asset');

  const amountMinor = toMinor(input.amount, asset.decimals);
  if (amountMinor < BigInt(asset.minWithdrawalMinor)) {
    throw unprocessable('below-min-withdrawal', `Amount is below the ${asset.symbol} minimum withdrawal`);
  }

  // Gate 1: allowlist — target must exist and be past its cooling-off window.
  const entry = await findEntry(prisma, wallet.accountId, asset.symbol, input.counterpartyAddress);
  if (!entry) throw unprocessable('address-not-allowlisted', 'Counterparty address is not allowlisted for this account/asset');
  if (!(await isActive(prisma, entry))) {
    throw unprocessable('address-in-cooling-off', 'Counterparty address is still in its cooling-off window');
  }

  const feeMinor = feeFor(amountMinor, WITHDRAWAL_FEE_BPS);
  if (BigInt(wallet.balanceMinor) < amountMinor + feeMinor) {
    throw unprocessable('insufficient-funds', 'Wallet balance cannot cover amount plus fee');
  }

  const tx = await prisma.transaction.create({
    data: {
      walletId: wallet.id,
      type: 'WITHDRAWAL',
      assetSymbol: asset.symbol,
      amountMinor: amountMinor.toString(),
      feeMinor: feeMinor.toString(),
      state: 'PENDING_APPROVAL',
      counterpartyAddress: input.counterpartyAddress.trim(),
      counterpartyVaspId: input.counterpartyVaspId ?? null,
      idempotencyKey: input.idempotencyKey ?? null,
      createdByApiKeyId: input.actor.apiKeyId,
    },
  });
  await writeAudit(prisma, {
    actor: input.actor,
    action: 'WITHDRAWAL_CREATED',
    entityType: 'Transaction',
    entityId: tx.id,
    after: {
      state: 'PENDING_APPROVAL',
      amountMinor: tx.amountMinor,
      feeMinor: tx.feeMinor,
      counterpartyAddress: tx.counterpartyAddress,
      counterpartyVaspId: tx.counterpartyVaspId,
    },
  });
  return { tx, created: true };
}

/** After final approval: evaluate the Travel Rule gate, then screening/broadcast. */
export async function progressAfterApproval(prisma: PrismaClient, txId: string, actor: Actor): Promise<Transaction> {
  const tx = await prisma.transaction.findUnique({ where: { id: txId } });
  if (!tx || tx.state !== 'APPROVED') throw conflict('not-approved', 'Withdrawal is not in APPROVED state');
  const asset = await prisma.asset.findUnique({ where: { symbol: tx.assetSymbol } });
  if (!asset) throw notFound('Asset');

  const fiatMinor = fiatEquivalentMinor(BigInt(tx.amountMinor), asset);
  if (requiresTravelRule(fiatMinor, tx.counterpartyVaspId !== null)) {
    const records = await prisma.travelRuleRecord.findMany({ where: { transactionId: tx.id } });
    const hasOriginator = records.some((r) => r.direction === 'ORIGINATOR');
    const hasBeneficiary = records.some((r) => r.direction === 'BENEFICIARY');
    if (!hasOriginator || !hasBeneficiary) {
      return transitionTx(prisma, tx, 'TRAVEL_RULE_CHECK', actor);
    }
  }
  return screenAndBroadcast(prisma, tx.id, actor);
}

/** Screening, then (if clean) the balance debit + broadcast, atomically. */
export async function screenAndBroadcast(prisma: PrismaClient, txId: string, actor: Actor): Promise<Transaction> {
  const tx = await prisma.transaction.findUnique({ where: { id: txId } });
  if (!tx) throw notFound('Withdrawal');
  const screening = await transitionTx(prisma, tx, 'SCREENING', actor);

  const outcome = await nextScreeningOutcome(prisma);
  if (outcome === 'FLAG') {
    const held = await transitionTx(prisma, screening, 'HELD', actor);
    await openHold(prisma, { transactionId: tx.id, reason: 'SCREENING_FLAG', actor });
    return held;
  }
  return broadcastWithdrawal(prisma, txId, actor);
}

/** Debit amount + fee, write ledger rows, record broadcast height — one transaction. */
export async function broadcastWithdrawal(prisma: PrismaClient, txId: string, actor: Actor): Promise<Transaction> {
  return prisma.$transaction(async (db) => {
    const tx = await db.transaction.findUnique({
      where: { id: txId },
      include: { wallet: { include: { account: true } } },
    });
    if (!tx) throw notFound('Withdrawal');
    if (!['SCREENING', 'HELD'].includes(tx.state)) {
      throw conflict('not-broadcastable', `Withdrawal is ${tx.state}; cannot broadcast`);
    }

    const amount = BigInt(tx.amountMinor);
    const fee = BigInt(tx.feeMinor);
    const balance = BigInt(tx.wallet.balanceMinor);
    if (balance < amount + fee) throw unprocessable('insufficient-funds', 'Balance cannot cover amount plus fee at broadcast');

    await db.wallet.update({
      where: { id: tx.walletId },
      data: { balanceMinor: (balance - amount - fee).toString() },
    });
    const clientId = tx.wallet.account.clientId;
    await db.ledgerEntry.create({
      data: { walletId: tx.walletId, clientId, direction: 'DEBIT', amountMinor: amount.toString(), kind: 'PRINCIPAL', txId: tx.id },
    });
    await db.ledgerEntry.create({
      data: { walletId: tx.walletId, clientId, direction: 'DEBIT', amountMinor: fee.toString(), kind: 'FEE', txId: tx.id },
    });

    const chain = await getChain(db);
    const broadcast = await transitionTx(db, tx, 'BROADCAST', actor, { broadcastBlockHeight: chain.blockHeight });
    await emitEvent(db, 'withdrawal.broadcast', {
      transactionId: tx.id,
      walletId: tx.walletId,
      amountMinor: tx.amountMinor,
      counterpartyAddress: tx.counterpartyAddress,
    });
    return transitionTx(db, broadcast, 'PENDING_CONFIRMATION', actor);
  });
}

export async function attachTravelRule(
  prisma: PrismaClient,
  input: {
    txId: string;
    actor: Actor;
    originator: { name: string; accountRef: string; physicalAddress?: string | undefined; dateOfBirth?: string | undefined };
    beneficiary: { name: string; accountRef: string };
  },
): Promise<Transaction> {
  const tx = await prisma.transaction.findUnique({ where: { id: input.txId } });
  if (!tx || tx.type !== 'WITHDRAWAL') throw notFound('Withdrawal');
  if (!['PENDING_APPROVAL', 'APPROVED', 'TRAVEL_RULE_CHECK'].includes(tx.state)) {
    throw conflict('travel-rule-not-attachable', `Cannot attach Travel Rule data in state ${tx.state}`);
  }
  if (!input.originator.physicalAddress && !input.originator.dateOfBirth) {
    throw unprocessable(
      'travel-rule-originator-incomplete',
      'Originator requires a physical address or (where permitted) a date of birth',
    );
  }

  await prisma.travelRuleRecord.create({
    data: { transactionId: tx.id, direction: 'ORIGINATOR', payload: JSON.stringify(input.originator) },
  });
  await prisma.travelRuleRecord.create({
    data: { transactionId: tx.id, direction: 'BENEFICIARY', payload: JSON.stringify(input.beneficiary) },
  });
  await writeAudit(prisma, {
    actor: input.actor,
    action: 'TRAVEL_RULE_ATTACHED',
    entityType: 'Transaction',
    entityId: tx.id,
    after: { originatorName: input.originator.name, beneficiaryName: input.beneficiary.name },
  });

  if (tx.state === 'TRAVEL_RULE_CHECK') return screenAndBroadcast(prisma, tx.id, input.actor);
  return tx;
}

export async function cancelWithdrawal(prisma: PrismaClient, txId: string, actor: Actor): Promise<Transaction> {
  const tx = await prisma.transaction.findUnique({ where: { id: txId } });
  if (!tx || tx.type !== 'WITHDRAWAL') throw notFound('Withdrawal');
  if (tx.state !== 'PENDING_APPROVAL') {
    throw conflict('not-cancellable', `Only PENDING_APPROVAL withdrawals can be cancelled (state: ${tx.state})`);
  }
  if (actor.role === 'CLIENT' && tx.createdByApiKeyId !== actor.apiKeyId) {
    throw forbidden('Clients may only cancel their own withdrawals');
  }
  return transitionTx(prisma, tx, 'CANCELLED', actor);
}
