// Hold-resolution orchestration: resolveHoldCore does the audited state
// change; this module resumes (or rejects) the underlying transaction.
// Kept separate so holds/deposits/withdrawals stay cycle-free.

import type { ComplianceHold, PrismaClient } from '@prisma/client';
import type { Actor } from '../config.js';
import { creditDeposit } from './deposits.js';
import { resolveHoldCore } from './holds.js';
import { transitionTx } from './transitions.js';
import { broadcastWithdrawal } from './withdrawals.js';
import { emitEvent } from './webhooks.js';

export async function releaseHold(prisma: PrismaClient, holdId: string, actor: Actor): Promise<ComplianceHold> {
  const { hold, transaction } = await resolveHoldCore(prisma, { holdId, actor, decision: 'RELEASED' });
  if (transaction.type === 'DEPOSIT') {
    await creditDeposit(prisma, transaction.id, actor);
  } else {
    await broadcastWithdrawal(prisma, transaction.id, actor);
  }
  await emitEvent(prisma, 'hold.released', { holdId: hold.id, transactionId: transaction.id });
  return hold;
}

export async function rejectHold(prisma: PrismaClient, holdId: string, actor: Actor): Promise<ComplianceHold> {
  const { hold, transaction } = await resolveHoldCore(prisma, { holdId, actor, decision: 'REJECTED' });
  await transitionTx(prisma, transaction, 'REJECTED', actor);
  return hold;
}
