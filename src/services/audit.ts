// Append-only audit log (PRD §A.1). Every state-changing action writes an
// entry with actor, action, and before/after snapshots — inside the same
// transaction as the change wherever one exists.

import type { Actor } from '../config.js';
import type { Db } from '../db.js';

export interface AuditInput {
  actor: Actor | null;
  action: string;
  entityType: string;
  entityId: string;
  before?: unknown;
  after?: unknown;
}

export async function writeAudit(db: Db, input: AuditInput): Promise<void> {
  await db.auditLogEntry.create({
    data: {
      actorApiKeyId: input.actor?.apiKeyId ?? null,
      actorRole: input.actor?.role ?? null,
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId,
      before: input.before === undefined ? null : JSON.stringify(input.before),
      after: input.after === undefined ? null : JSON.stringify(input.after),
    },
  });
}
