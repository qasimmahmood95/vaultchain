// Maker-checker dual approval (PRD §A.3.2).

import { type PrismaClient, type Transaction } from '@prisma/client';
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
  const tx = await prisma.transaction.findUnique({
    where: { id: input.txId },
    include: { wallet: true, approvals: true },
  });
  if (!tx || tx.type !== 'WITHDRAWAL') throw notFound('Withdrawal');
  if (tx.state !== 'PENDING_APPROVAL') {
    throw conflict('not-pending-approval', `Withdrawal is ${tx.state}; approvals are closed`);
  }

  const { required, makerCannotCheck } = await requiredApprovalsFor(prisma, tx, tx.wallet.accountId);
  if (makerCannotCheck && tx.createdByApiKeyId === input.actor.apiKeyId) {
    throw forbidden('Maker cannot check: the creator of a withdrawal may not approve or reject it');
  }

  await prisma.approval.create({
    data: {
      transactionId: tx.id,
      approverApiKeyId: input.actor.apiKeyId,
      approverRole: input.actor.role,
      decision: input.decision,
    },
  });
  await writeAudit(prisma, {
    actor: input.actor,
    action: input.decision === 'APPROVE' ? 'WITHDRAWAL_APPROVAL_RECORDED' : 'WITHDRAWAL_REJECTION_RECORDED',
    entityType: 'Transaction',
    entityId: tx.id,
    after: { decision: input.decision, approver: input.actor.apiKeyId },
  });

  if (input.decision === 'REJECT') {
    return transitionTx(prisma, tx, 'REJECTED', input.actor);
  }

  const approvals = await prisma.approval.findMany({ where: { transactionId: tx.id, decision: 'APPROVE' } });
  const nonMakerApprovals = approvals.filter((a) => a.approverApiKeyId !== tx.createdByApiKeyId);
  if (nonMakerApprovals.length >= required) {
    await transitionTx(prisma, tx, 'APPROVED', input.actor);
    await emitEvent(prisma, 'withdrawal.approved', { transactionId: tx.id, approvals: nonMakerApprovals.length });
    return progressAfterApproval(prisma, input.txId, input.actor);
  }
  return tx;
}
