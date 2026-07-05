// Transaction / TransactionRaw / WithdrawalDetail schemas (openapi/vaultchain.yaml).

import { z } from 'zod';
import { decimalString, isoDateTime, minorUnits, RoleSchema } from './common.js';
import { AssetSymbolSchema } from './accounts.js';

/** All 14 transaction states — the full enum domain from the spec. */
export const TransactionStateSchema = z.enum([
  'DETECTED',
  'PENDING_CONFIRMATION',
  'SCREENING',
  'CREDITED',
  'HELD',
  'REJECTED',
  'PENDING_APPROVAL',
  'APPROVED',
  'TRAVEL_RULE_CHECK',
  'BROADCAST',
  'CONFIRMED',
  'CANCELLED',
  'EXPIRED',
  'FAILED',
]);

export const TransactionTypeSchema = z.enum(['DEPOSIT', 'WITHDRAWAL']);

/** components/schemas/Transaction */
export const TransactionSchema = z.strictObject({
  id: z.string(),
  walletId: z.string(),
  type: TransactionTypeSchema,
  assetSymbol: AssetSymbolSchema,
  amountMinor: minorUnits,
  amount: decimalString,
  feeMinor: minorUnits,
  fee: decimalString,
  state: TransactionStateSchema,
  counterpartyAddress: z.string().nullable(),
  counterpartyVaspId: z.string().nullable(),
  chainTxRef: z.string().nullable(),
  confirmations: z.int(),
  idempotencyKey: z.string().nullable(),
  createdAt: isoDateTime,
  updatedAt: isoDateTime,
});

/** components/schemas/TransactionRaw — as persisted (simulator force response). */
export const TransactionRawSchema = z.strictObject({
  id: z.string(),
  walletId: z.string(),
  type: TransactionTypeSchema,
  assetSymbol: z.string(),
  amountMinor: z.string(),
  feeMinor: z.string(),
  state: z.string(),
});

export const ApprovalSchema = z.strictObject({
  approverApiKeyId: z.string(),
  approverRole: RoleSchema,
  decision: z.enum(['APPROVE', 'REJECT']),
});

export const TravelRuleRecordSchema = z.strictObject({
  direction: z.enum(['ORIGINATOR', 'BENEFICIARY']),
  payload: z.record(z.string(), z.unknown()),
});

/** components/schemas/WithdrawalDetail — Transaction + approvals + travelRule. */
export const WithdrawalDetailSchema = TransactionSchema.extend({
  approvals: z.array(ApprovalSchema),
  travelRule: z.array(TravelRuleRecordSchema),
});
