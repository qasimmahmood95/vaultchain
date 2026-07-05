// components/schemas/Client (openapi/vaultchain.yaml).

import { z } from 'zod';
import { isoDateTime } from './common.js';

export const ClientSchema = z.strictObject({
  id: z.string(),
  legalName: z.string(),
  type: z.enum(['INDIVIDUAL', 'INSTITUTION']),
  jurisdiction: z.string(),
  vaspId: z.string().nullable(),
  status: z.string(),
  createdAt: isoDateTime,
});
