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
