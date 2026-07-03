// Maker-checker dual approval (PRD §A.3.2). The whole decision is one
// serialized DB transaction; the (transactionId, approverApiKeyId) unique
// constraint makes double-counting impossible even under concurrent requests,
// and the maker is rejected atomically inside the same transaction.

import { Prisma, type PrismaClient, type Transaction } from '@prisma/client';
import type { Actor } from '../config.js';
import { conflict, forbidden, notFound } from '../errors.js';
import { writeAudit } from './audit.js';
import { transitionTx } from './transitions.js';
import { emitEvent } from './webhooks.js';
import { progressAfterApproval, requiredApprovalsFor } from './withdrawals.js';

export async function addApproval(
  prisma: PrismaClient,
  input: { txId: string; actor: Actor; decision: 'APPROVE' | 'REJECT' },
): Promise<Transaction> {
  const result = await prisma.$transaction(async (db) => {
    const tx = await db.transaction.findUnique({
      where: { id: input.txId },
      include: { wallet: true, approvals: true },
    });
    if (!tx || tx.type !== 'WITHDRAWAL') throw notFound('Withdrawal');
    if (tx.state !== 'PENDING_APPROVAL') {
      throw conflict('not-pending-approval', `Withdrawal is ${tx.state}; approvals are closed`);
    }

    const { required, makerCannotCheck } = await requiredApprovalsFor(db, tx, tx.wallet.accountId);
    if (makerCannotCheck && tx.createdByApiKeyId === input.actor.apiKeyId) {
      throw forbidden('Maker cannot check: the creator of a withdrawal may not approve or reject it');
    }

    try {
      await db.approval.create({
        data: {
          transactionId: tx.id,
          approverApiKeyId: input.actor.apiKeyId,
          approverRole: input.actor.role,
          decision: input.decision,
        },
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw conflict('already-decided', 'This approver has already recorded a decision for this withdrawal');
      }
      throw err;
    }
    await writeAudit(db, {
      actor: input.actor,
      action: input.decision === 'APPROVE' ? 'WITHDRAWAL_APPROVAL_RECORDED' : 'WITHDRAWAL_REJECTION_RECORDED',
      entityType: 'Transaction',
      entityId: tx.id,
      after: { decision: input.decision, approver: input.actor.apiKeyId },
    });

    if (input.decision === 'REJECT') {
      return { tx: await transitionTx(db, tx, 'REJECTED', input.actor), approved: false };
    }

    // Re-read inside the transaction: distinct non-maker APPROVEs.
    const approvals = await db.approval.findMany({ where: { transactionId: tx.id, decision: 'APPROVE' } });
    const distinctApprovers = new Set(
      approvals.filter((a) => a.approverApiKeyId !== tx.createdByApiKeyId).map((a) => a.approverApiKeyId),
    );
    if (distinctApprovers.size >= required) {
      const approved = await transitionTx(db, tx, 'APPROVED', input.actor);
      await emitEvent(db, 'withdrawal.approved', { transactionId: tx.id, approvals: distinctApprovers.size });
      return { tx: approved, approved: true };
    }
    return { tx, approved: false };
  });

  // Post-commit: run the Travel Rule / screening / broadcast gates.
  if (result.approved) return progressAfterApproval(prisma, input.txId, input.actor);
  return result.tx;
}
