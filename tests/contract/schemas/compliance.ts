// ComplianceHold and AuditLogEntry schemas (openapi/vaultchain.yaml).

import { z } from 'zod';
import { isoDateTime } from './common.js';
import { TransactionRawSchema } from './transactions.js';

/** components/schemas/ComplianceHold */
export const ComplianceHoldSchema = z.strictObject({
  id: z.string(),
  transactionId: z.string(),
  reason: z.string(),
  state: z.enum(['OPEN', 'RELEASED', 'REJECTED']),
  openedBy: z.string(),
  resolvedBy: z.string().nullable().optional(),
  createdAt: isoDateTime,
  resolvedAt: isoDateTime.nullable().optional(),
  transaction: TransactionRawSchema.optional(),
});

/**
 * components/schemas/AuditLogEntry — `before`/`after` are REQUIRED keys whose
 * value is any JSON value (the spec's empty schema `{}`); z.json() rejects
 * `undefined`, so key presence is enforced.
 */
export const AuditLogEntrySchema = z.strictObject({
  id: z.string(),
  actorApiKeyId: z.string().nullable(),
  actorRole: z.string().nullable(),
  action: z.string(),
  entityType: z.string(),
  entityId: z.string(),
  before: z.json(),
  after: z.json(),
  createdAt: isoDateTime,
});
