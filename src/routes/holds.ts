// Compliance hold queue and resolution (PRD §A.4). Segregation of duties:
// resolving a hold — release OR reject — requires the COMPLIANCE_OFFICER
// role, explicitly. Operations staff can view the queue but never resolve.

import type { FastifyInstance } from 'fastify';
import { prisma } from '../db.js';
import { notFound } from '../errors.js';
import { denyRole, requireRole } from '../plugins/auth.js';
import { pageArgs, serializeTransactionRaw, toPage } from '../serialize.js';
import { rejectHold, releaseHold } from '../services/lifecycle.js';

export function registerHoldRoutes(app: FastifyInstance): void {
  app.get<{ Querystring: { cursor?: string; limit?: number; state?: string } }>(
    '/holds',
    { preHandler: requireRole('COMPLIANCE_OFFICER', 'OPERATOR', 'ADMIN') },
    async (request) => {
      const args = pageArgs(request.query);
      const rows = await prisma.complianceHold.findMany({
        where: request.query.state ? { state: request.query.state } : {},
        orderBy: { id: 'asc' },
        ...args,
      });
      return toPage(rows, args.take, (h) => h);
    },
  );

  app.get<{ Params: { id: string } }>(
    '/holds/:id',
    { preHandler: requireRole('COMPLIANCE_OFFICER', 'OPERATOR', 'ADMIN') },
    async (request) => {
      const hold = await prisma.complianceHold.findUnique({
        where: { id: request.params.id },
        include: { transaction: true },
      });
      if (!hold) throw notFound('Hold');
      // Project the embedded transaction to TransactionRaw — never leak the full
      // Prisma row's internal columns (D33 drift, spec is source of truth per D18).
      return { ...hold, transaction: serializeTransactionRaw(hold.transaction) };
    },
  );

  app.post<{ Params: { id: string } }>(
    '/holds/:id/release',
    { preHandler: denyRole('CLIENT') },
    async (request) => releaseHold(prisma, request.params.id, request.actor),
  );

  app.post<{ Params: { id: string } }>(
    '/holds/:id/reject',
    { preHandler: denyRole('CLIENT') },
    async (request) => rejectHold(prisma, request.params.id, request.actor),
  );
}
