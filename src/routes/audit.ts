// Read-only audit query (PRD §A.4). The log is append-only: there is no
// update or delete route, here or anywhere.

import type { FastifyInstance } from 'fastify';
import { prisma } from '../db.js';
import { requireRole } from '../plugins/auth.js';
import { pageArgs, toPage } from '../serialize.js';

export function registerAuditRoutes(app: FastifyInstance): void {
  app.get<{ Querystring: { cursor?: string; limit?: number; entityType?: string; entityId?: string } }>(
    '/audit',
    { preHandler: requireRole('COMPLIANCE_OFFICER', 'ADMIN') },
    async (request) => {
      const args = pageArgs(request.query);
      const rows = await prisma.auditLogEntry.findMany({
        where: {
          ...(request.query.entityType ? { entityType: request.query.entityType } : {}),
          ...(request.query.entityId ? { entityId: request.query.entityId } : {}),
        },
        orderBy: { id: 'asc' },
        ...args,
      });
      return toPage(rows, args.take, (e) => ({
        ...e,
        before: e.before === null ? null : (JSON.parse(e.before) as unknown),
        after: e.after === null ? null : (JSON.parse(e.after) as unknown),
      }));
    },
  );
}
