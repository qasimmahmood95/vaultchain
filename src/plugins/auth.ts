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

const PUBLIC_PATHS = new Set(['/health', '/ui/login']);

/** The UI session cookie set by POST /ui/login — mirrors a raw API key (§A.5). */
const UI_COOKIE = 'vc_key';

function cookieKey(request: FastifyRequest): string | undefined {
  const header = request.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === UI_COOKIE) return decodeURIComponent(rest.join('='));
  }
  return undefined;
}

/**
 * onRequest hook: resolve X-Api-Key (API) or the vc_key cookie (UI) to an
 * Actor. Unauthenticated /ui requests redirect to the login page; API
 * requests get a 401 problem.
 */
export async function authenticate(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const path = request.url.split('?')[0] ?? '';
  if (PUBLIC_PATHS.has(path)) return;
  // '/ui/' — not '/ui' — so '/uianything' is NOT treated as a UI route (Nit 3).
  const isUi = path.startsWith('/ui/');

  const header = request.headers['x-api-key'];
  const headerKey = typeof header === 'string' && header.length > 0 ? header : undefined;
  // The vc_key cookie is a UI-ONLY credential (D27): it must never authenticate
  // the JSON API, so it is consulted only for /ui requests. API routes require
  // X-Api-Key. This keeps the cookie's CSRF surface confined to /ui.
  const rawKey = headerKey ?? (isUi ? cookieKey(request) : undefined);
  const apiKey = rawKey ? await prisma.apiKey.findUnique({ where: { keyHash: hashKey(rawKey) } }) : null;
  if (!apiKey || apiKey.status !== 'ACTIVE') {
    if (isUi) {
      await reply.redirect('/ui/login', 303);
      return;
    }
    throw unauthorized();
  }
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
