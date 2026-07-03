import type { FastifyInstance } from 'fastify';
import { prisma } from '../db.js';
import { requireRole } from '../plugins/auth.js';
import { writeAudit } from '../services/audit.js';

const KNOWN_EVENTS = [
  'deposit.detected',
  'deposit.credited',
  'withdrawal.approved',
  'withdrawal.broadcast',
  'withdrawal.confirmed',
  'hold.opened',
  'hold.released',
];

export function registerWebhookRoutes(app: FastifyInstance): void {
  app.post<{ Body: { url: string; secret: string; events: string[] } }>(
    '/webhooks/subscriptions',
    {
      schema: {
        body: {
          type: 'object',
          required: ['url', 'secret', 'events'],
          additionalProperties: false,
          properties: {
            url: { type: 'string', minLength: 8 },
            secret: { type: 'string', minLength: 8 },
            events: { type: 'array', items: { type: 'string', enum: KNOWN_EVENTS }, minItems: 1 },
          },
        },
      },
      preHandler: requireRole('OPERATOR', 'ADMIN'),
    },
    async (request, reply) => {
      const sub = await prisma.webhookSubscription.create({
        data: {
          url: request.body.url,
          secret: request.body.secret,
          events: JSON.stringify(request.body.events),
        },
      });
      await writeAudit(prisma, {
        actor: request.actor,
        action: 'WEBHOOK_SUBSCRIPTION_CREATED',
        entityType: 'WebhookSubscription',
        entityId: sub.id,
        after: { url: sub.url, events: request.body.events },
      });
      return reply.code(201).send({ id: sub.id, url: sub.url, events: request.body.events, createdAt: sub.createdAt });
    },
  );

  app.get(
    '/webhooks/subscriptions',
    { preHandler: requireRole('OPERATOR', 'ADMIN') },
    async () => {
      const subs = await prisma.webhookSubscription.findMany({ orderBy: { id: 'asc' } });
      return {
        items: subs.map((s) => ({ id: s.id, url: s.url, events: JSON.parse(s.events) as string[], createdAt: s.createdAt })),
      };
    },
  );

  app.get<{ Querystring: { cursor?: string; limit?: number; event?: string } }>(
    '/webhooks/deliveries',
    { preHandler: requireRole('OPERATOR', 'ADMIN') },
    async (request) => {
      const deliveries = await prisma.webhookDelivery.findMany({
        where: request.query.event ? { event: request.query.event } : {},
        orderBy: { id: 'asc' },
      });
      return { items: deliveries };
    },
  );
}
