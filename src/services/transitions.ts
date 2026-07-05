// Single choke-point for Transaction state changes: every transition writes
// its audit entry in the same DB transaction (PRD §A.1 audit completeness).

import type { Transaction } from '@prisma/client';
import type { Actor } from '../config.js';
import type { Db } from '../db.js';
import { writeAudit } from './audit.js';

export async function transitionTx(
  db: Db,
  tx: Transaction,
  to: string,
  actor: Actor | null,
  extra: Record<string, unknown> = {},
): Promise<Transaction> {
  const updated = await db.transaction.update({
    where: { id: tx.id },
    data: { state: to, ...extra },
  });
  await writeAudit(db, {
    actor,
    action: `TRANSACTION_${to}`,
    entityType: 'Transaction',
    entityId: tx.id,
    before: { state: tx.state },
    after: { state: to, ...extra },
  });
  return updated;
}

/**
 * Compare-and-set transition: move a transaction from `from` to `to` only if
 * it is still in `from`, and write the audit entry ONLY for the caller that
 * wins the claim. Returns the updated tx, or null if another caller already
 * moved it. This is the guard the parallel-reachable settlement path
 * (`advanceChain`) needs — a plain `transitionTx` updates by id with no state
 * condition, so two concurrent advances could both "settle" the same tx and
 * emit duplicate audit rows / webhooks (P3 review Major 3).
 */
export async function claimTransition(
  db: Db,
  txId: string,
  from: string,
  to: string,
  actor: Actor | null,
  extra: Record<string, unknown> = {},
): Promise<Transaction | null> {
  const claimed = await db.transaction.updateMany({
    where: { id: txId, state: from },
    data: { state: to, ...extra },
  });
  if (claimed.count === 0) return null;
  await writeAudit(db, {
    actor,
    action: `TRANSACTION_${to}`,
    entityType: 'Transaction',
    entityId: txId,
    before: { state: from },
    after: { state: to, ...extra },
  });
  return db.transaction.findUniqueOrThrow({ where: { id: txId } });
}
