import type { FastifyInstance } from 'fastify';
import { prisma } from '../db.js';
import { notFound } from '../errors.js';
import { requireRole } from '../plugins/auth.js';
import { pageArgs, toPage } from '../serialize.js';
import { writeAudit } from '../services/audit.js';

interface CreateClientBody {
  legalName: string;
  type: 'INDIVIDUAL' | 'INSTITUTION';
  jurisdiction: string;
  vaspId?: string;
}

const createClientSchema = {
  body: {
    type: 'object',
    required: ['legalName', 'type', 'jurisdiction'],
    additionalProperties: false,
    properties: {
      legalName: { type: 'string', minLength: 1 },
      type: { type: 'string', enum: ['INDIVIDUAL', 'INSTITUTION'] },
      jurisdiction: { type: 'string', minLength: 2 },
      vaspId: { type: 'string', minLength: 1 },
    },
  },
} as const;

export function registerClientRoutes(app: FastifyInstance): void {
  app.post<{ Body: CreateClientBody }>(
    '/clients',
    { schema: createClientSchema, preHandler: requireRole('ADMIN') },
    async (request, reply) => {
      const client = await prisma.client.create({
        data: {
          legalName: request.body.legalName,
          type: request.body.type,
          jurisdiction: request.body.jurisdiction,
          vaspId: request.body.vaspId ?? null,
        },
      });
      await writeAudit(prisma, {
        actor: request.actor,
        action: 'CLIENT_CREATED',
        entityType: 'Client',
        entityId: client.id,
        after: { legalName: client.legalName, type: client.type },
      });
      return reply.code(201).send(client);
    },
  );

  app.get<{ Querystring: { cursor?: string; limit?: number } }>(
    '/clients',
    { preHandler: requireRole('CLIENT', 'OPERATOR', 'COMPLIANCE_OFFICER', 'ADMIN') },
    async (request) => {
      // CLIENT keys see only their own client (DECISIONS.md D16).
      const where = request.actor.role === 'CLIENT' ? { id: request.actor.clientId ?? '' } : {};
      const args = pageArgs(request.query);
      const rows = await prisma.client.findMany({ where, orderBy: { id: 'asc' }, ...args });
      return toPage(rows, args.take, (c) => c);
    },
  );

  app.get<{ Params: { id: string } }>(
    '/clients/:id',
    { preHandler: requireRole('CLIENT', 'OPERATOR', 'COMPLIANCE_OFFICER', 'ADMIN') },
    async (request) => {
      // Cross-tenant reads 404 rather than 403: existence is not leaked.
      if (request.actor.role === 'CLIENT' && request.actor.clientId !== request.params.id) {
        throw notFound('Client');
      }
      const client = await prisma.client.findUnique({ where: { id: request.params.id } });
      if (!client) throw notFound('Client');
      return client;
    },
  );
}
