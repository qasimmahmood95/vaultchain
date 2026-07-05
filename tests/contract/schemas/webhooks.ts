// WebhookSubscription and WebhookDelivery schemas (openapi/vaultchain.yaml).

import { z } from 'zod';
import { isoDateTime } from './common.js';

// NB: the spec's WebhookSubscription.events RESPONSE items are plain strings
// (the enum constrains the REQUEST only), so no event-enum schema exists here
// — response tightening is the D25 strict-schema pass (P4).

/** components/schemas/WebhookSubscription */
export const WebhookSubscriptionSchema = z.strictObject({
  id: z.string(),
  url: z.string(),
  events: z.array(z.string()),
  createdAt: isoDateTime,
});

/** components/schemas/WebhookDelivery — payload is the raw JSON string the signature covers. */
export const WebhookDeliverySchema = z.strictObject({
  id: z.string(),
  subscriptionId: z.string(),
  event: z.string(),
  payload: z.string(),
  signature: z.string().regex(/^sha256=[0-9a-f]{64}$/, 'expected sha256=<hex> HMAC signature'),
  attempts: z.int(),
  status: z.enum(['PENDING', 'DELIVERED']),
  dueAtSimMs: z.string().optional(),
  deliveredAt: isoDateTime.nullable().optional(),
  createdAt: isoDateTime.optional(),
});
