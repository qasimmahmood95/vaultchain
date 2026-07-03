// Compliance (screening) holds (PRD §A.1/§A.3). Opening and resolving are
// both audited; resolution happens in a DB transaction via resolveHoldCore.
// Role enforcement (compliance-officer only) lives at the route layer.

import type { ComplianceHold, Transaction } from '@prisma/client';
import type { PrismaClient } from '@prisma/client';
import type { Actor } from '../config.js';
import type { Db } from '../db.js';
import { conflict, notFound } from '../errors.js';
import { writeAudit } from './audit.js';
import { emitEvent } from './webhooks.js';

export async function openHold(
  db: Db,
  input: { transactionId: string; reason: string; actor: Actor | null },
): Promise<ComplianceHold> {
  const hold = await db.complianceHold.create({
    data: {
      transactionId: input.transactionId,
      reason: input.reason,
      openedBy: input.actor?.apiKeyId ?? 'system',
    },
  });
  await writeAudit(db, {
    actor: input.actor,
    action: 'HOLD_OPENED',
    entityType: 'ComplianceHold',
    entityId: hold.id,
    after: { transactionId: hold.transactionId, reason: hold.reason, state: 'OPEN' },
  });
  await emitEvent(db, 'hold.opened', { holdId: hold.id, transactionId: hold.transactionId, reason: hold.reason });
  return hold;
}

/**
 * Shared resolution path for release AND reject: state change + audit entry
 * in one DB transaction. Every resolution — release included — is audited
 * with actor and before/after (PRD §A.1 audit completeness).
 */
export async function resolveHoldCore(
  prisma: PrismaClient,
  input: { holdId: string; actor: Actor; decision: 'RELEASED' | 'REJECTED' },
): Promise<{ hold: ComplianceHold; transaction: Transaction }> {
  return prisma.$transaction(async (db) => {
    const hold = await db.complianceHold.findUnique({
      where: { id: input.holdId },
      include: { transaction: true },
    });
    if (!hold) throw notFound('Hold');
    if (hold.state !== 'OPEN') throw conflict('hold-not-open', `Hold is ${hold.state}, not OPEN`);

    const updated = await db.complianceHold.update({
      where: { id: hold.id },
      // resolvedAt is wall-clock metadata, not domain time — all gating uses the sim clock.
      data: { state: input.decision, resolvedBy: input.actor.apiKeyId, resolvedAt: new Date() },
    });
    await writeAudit(db, {
      actor: input.actor,
      action: input.decision === 'RELEASED' ? 'HOLD_RELEASED' : 'HOLD_REJECTED',
      entityType: 'ComplianceHold',
      entityId: hold.id,
      before: { state: 'OPEN' },
      after: { state: input.decision, resolvedBy: input.actor.apiKeyId },
    });
    return { hold: updated, transaction: hold.transaction };
  });
}
