// /simulator control-plane response schemas (openapi/vaultchain.yaml).

import { z } from 'zod';
import { WebhookDeliverySchema } from './webhooks.js';

/** components/schemas/ChainState */
export const ChainStateSchema = z.object({
  id: z.literal('chain'),
  blockHeight: z.int(),
  simClockMs: z.string(),
  frozen: z.boolean(),
  webhookDelayMs: z.string(),
  screeningNext: z.enum(['CLEAN', 'FLAG']).nullable(),
  forcedOutcomesJson: z.string().optional(),
});

/** POST /simulator/chain/advance 200 */
export const ChainAdvanceResultSchema = z.object({
  blockHeight: z.int(),
  simClockMs: z.string(),
  settled: z.int(),
});

/** POST /simulator/screening/next 200 */
export const ScreeningQueuedSchema = z.object({
  queued: z.enum(['CLEAN', 'FLAG']),
});

/** POST /simulator/webhooks/delay 200 */
export const WebhookDelaySetSchema = z.object({
  webhookDelayMs: z.string(),
});

/** POST /simulator/webhooks/{id}/replay 200 — creditResult null for non-deposit events. */
export const WebhookReplayResultSchema = z.object({
  delivery: WebhookDeliverySchema,
  creditResult: z.union([
    z.null(),
    z.object({
      credited: z.boolean(),
      reason: z.enum(['credited', 'already-credited', 'not-creditable']),
    }),
  ]),
});
