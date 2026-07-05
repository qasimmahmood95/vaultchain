// /health and /me response schemas (openapi/vaultchain.yaml, paths /health, /me).

import { z } from 'zod';
import { RoleSchema } from './common.js';

/** GET /health 200 */
export const HealthSchema = z.strictObject({
  status: z.literal('ok'),
});

/** GET /me 200 — caller identity; clientId is null unless the key is tenant-bound. */
export const MeSchema = z.strictObject({
  apiKeyId: z.string(),
  role: RoleSchema,
  clientId: z.string().nullable(),
});
