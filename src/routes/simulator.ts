// /simulator control plane routes (PRD §A.7): admin-only, disabled outside
// dev/test (VAULTCHAIN_ENV=production hides the whole surface).

import type { FastifyInstance } from 'fastify';
import { prisma } from '../db.js';
import { requireRole } from '../plugins/auth.js';
import { getChain } from '../services/clock.js';
import {
  advanceChain,
  advanceClockBy,
  forceTxOutcome,
  freezeClock,
  queueScreeningOutcome,
  replayWebhook,
  resetSimulator,
  setClock,
  setWebhookDelay,
} from '../services/simulator.js';

export function registerSimulatorRoutes(app: FastifyInstance): void {
  if (process.env.VAULTCHAIN_ENV === 'production') return;

  const admin = { preHandler: requireRole('ADMIN') };

  app.get('/simulator/state', admin, async () => getChain(prisma));

  app.post<{ Body: { blocks: number } }>(
    '/simulator/chain/advance',
    {
      ...admin,
      schema: {
        body: {
          type: 'object',
          required: ['blocks'],
          additionalProperties: false,
          properties: { blocks: { type: 'integer', minimum: 1, maximum: 10000 } },
        },
      },
    },
    async (request) => advanceChain(prisma, request.body.blocks, request.actor),
  );

  app.post<{ Body: { ms: string } }>(
    '/simulator/clock/set',
    {
      ...admin,
      schema: {
        body: {
          type: 'object',
          required: ['ms'],
          additionalProperties: false,
          properties: { ms: { type: 'string', pattern: '^\\d+$' } },
        },
      },
    },
    async (request) => {
      await setClock(prisma, request.body.ms, request.actor);
      return getChain(prisma);
    },
  );

  app.post<{ Body: { ms: string } }>(
    '/simulator/clock/advance',
    {
      ...admin,
      schema: {
        body: {
          type: 'object',
          required: ['ms'],
          additionalProperties: false,
          properties: { ms: { type: 'string', pattern: '^\\d+$' } },
        },
      },
    },
    async (request) => {
      await advanceClockBy(prisma, request.body.ms, request.actor);
      return getChain(prisma);
    },
  );

  app.post<{ Body: { frozen?: boolean } }>(
    '/simulator/clock/freeze',
    admin,
    async (request) => {
      await freezeClock(prisma, request.body?.frozen ?? true, request.actor);
      return getChain(prisma);
    },
  );

  app.post<{ Params: { id: string }; Body: { outcome: 'CONFIRMED' | 'FAILED' } }>(
    '/simulator/tx/:id/force',
    {
      ...admin,
      schema: {
        body: {
          type: 'object',
          required: ['outcome'],
          additionalProperties: false,
          properties: { outcome: { type: 'string', enum: ['CONFIRMED', 'FAILED'] } },
        },
      },
    },
    async (request) => forceTxOutcome(prisma, request.params.id, request.body.outcome, request.actor),
  );

  app.post<{ Body: { outcome: 'CLEAN' | 'FLAG' } }>(
    '/simulator/screening/next',
    {
      ...admin,
      schema: {
        body: {
          type: 'object',
          required: ['outcome'],
          additionalProperties: false,
          properties: { outcome: { type: 'string', enum: ['CLEAN', 'FLAG'] } },
        },
      },
    },
    async (request) => {
      await queueScreeningOutcome(prisma, request.body.outcome, request.actor);
      return { queued: request.body.outcome };
    },
  );

  app.post<{ Params: { id: string } }>(
    '/simulator/webhooks/:id/replay',
    admin,
    async (request) => replayWebhook(prisma, request.params.id, request.actor),
  );

  app.post<{ Body: { ms: string } }>(
    '/simulator/webhooks/delay',
    {
      ...admin,
      schema: {
        body: {
          type: 'object',
          required: ['ms'],
          additionalProperties: false,
          properties: { ms: { type: 'string', pattern: '^\\d+$' } },
        },
      },
    },
    async (request) => {
      await setWebhookDelay(prisma, request.body.ms, request.actor);
      return { webhookDelayMs: request.body.ms };
    },
  );

  app.post('/simulator/reset', admin, async (request) => {
    await resetSimulator(prisma, request.actor);
    return getChain(prisma);
  });
}
