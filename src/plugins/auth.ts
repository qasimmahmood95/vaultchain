// API-key auth (PRD §A.4): X-Api-Key, four roles, CLIENT keys tenant-bound.
// Authorization is explicit per-route allowlists via requireRole — never
// negative checks (see BUGS.md fix sketch for why that matters).

import { createHash } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Actor, Role } from '../config.js';
import { prisma } from '../db.js';
import { forbidden, unauthorized } from '../errors.js';

declare module 'fastify' {
  interface FastifyRequest {
    actor: Actor;
  }
}

export function hashKey(rawKey: string): string {
  return createHash('sha256').update(rawKey).digest('hex');
}

const PUBLIC_PATHS = new Set(['/health']);

/** onRequest hook: resolve X-Api-Key to an Actor or 401. */
export async function authenticate(request: FastifyRequest): Promise<void> {
  if (PUBLIC_PATHS.has(request.url.split('?')[0] ?? '')) return;
  const rawKey = request.headers['x-api-key'];
  if (typeof rawKey !== 'string' || rawKey.length === 0) throw unauthorized();
  const apiKey = await prisma.apiKey.findUnique({ where: { keyHash: hashKey(rawKey) } });
  if (!apiKey || apiKey.status !== 'ACTIVE') throw unauthorized();
  request.actor = { apiKeyId: apiKey.id, role: apiKey.role as Role, clientId: apiKey.clientId };
}

/** preHandler factory: explicit role allowlist for a route. */
export function requireRole(...roles: Role[]) {
  return async (request: FastifyRequest, _reply: FastifyReply): Promise<void> => {
    if (!roles.includes(request.actor.role)) {
      throw forbidden(`Requires one of roles: ${roles.join(', ')}`);
    }
  };
}
