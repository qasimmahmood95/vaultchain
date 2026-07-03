// Shared zod building blocks for the contract layer.
//
// HAND-WRITTEN from openapi/vaultchain.yaml (the source of truth) — never
// generated, never imported from src/. The schemas are an independent oracle:
// if the platform drifts from the spec, these fail (PRD §B.3, DECISIONS D18).

import { z } from 'zod';

/** `format: date-time` — the platform serializes Dates as ISO-8601 UTC. */
export const isoDateTime = z.iso.datetime();

/** Integer minor-unit string, e.g. "150000" (`pattern: ^\d+$`). */
export const minorUnits = z.string().regex(/^\d+$/, 'expected an integer minor-unit string');

/** Formatted decimal amount string, e.g. "1500.00" (asset-decimal formatted). */
export const decimalString = z
  .string()
  .regex(/^\d+(\.\d+)?$/, 'expected a decimal amount string');

/** components/schemas/Role */
export const RoleSchema = z.enum(['CLIENT', 'OPERATOR', 'COMPLIANCE_OFFICER', 'ADMIN']);

/**
 * components/schemas/Problem — RFC 9457 problem details.
 * `type` is `format: uri` (absolute), required with title + status.
 */
export const ProblemSchema = z.object({
  type: z.url(),
  title: z.string(),
  status: z.int(),
  detail: z.string().optional(),
});

/** Cursor-paginated envelope: `{ items, nextCursor }` (nextCursor required, nullable). */
export function page<T extends z.ZodType>(item: T) {
  return z.object({
    items: z.array(item),
    nextCursor: z.string().nullable(),
  });
}

/** Non-paginated list envelope: `{ items }` only. */
export function itemsOnly<T extends z.ZodType>(item: T) {
  return z.object({
    items: z.array(item),
  });
}
