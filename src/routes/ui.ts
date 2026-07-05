// The thin admin UI (PRD §A.5): login, approval queue, transaction search,
// transaction detail — server-rendered, deliberately plain. Reads go straight
// to prisma (internal surface, not the §A.4 API contract); every MUTATION goes
// through the same domain services the API uses, so maker-checker, segregation
// of duties, and audit behave identically in both surfaces.
//
// Flash messages travel via query string (stateless — no session store).

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Actor } from '../config.js';
import { prisma } from '../db.js';
import { ApiProblem } from '../errors.js';
import { hashKey } from '../plugins/auth.js';
import { renderPage } from '../ui/render.js';
import { decimalsBySymbol, pageArgs, serializeTx, toPage } from '../serialize.js';
import { addApproval } from '../services/approvals.js';
import { rejectHold, releaseHold } from '../services/lifecycle.js';

const TX_STATES = [
  'DETECTED', 'PENDING_CONFIRMATION', 'SCREENING', 'CREDITED', 'HELD', 'REJECTED',
  'PENDING_APPROVAL', 'APPROVED', 'TRAVEL_RULE_CHECK', 'BROADCAST', 'CONFIRMED',
  'CANCELLED', 'EXPIRED', 'FAILED',
];

const COOKIE = 'vc_key';

function flashQuery(msg: string, kind: 'ok' | 'err' = 'ok', extra: Record<string, string> = {}): string {
  const params = new URLSearchParams({ flash: msg, kind, ...extra });
  return params.toString();
}

// Flash text is stateless (query string), so a crafted link can display a
// spoofed success/error banner. Accepted for a mock admin UI: Eta escapes every
// interpolation (no XSS), and a stateful flash store is out of §A.5 scope (Nit 6).
function flashFromQuery(request: FastifyRequest): { flash?: string; flashKind?: 'ok' | 'err' } {
  const q = request.query as { flash?: string; kind?: string };
  if (!q.flash) return {};
  return { flash: q.flash, flashKind: q.kind === 'err' ? 'err' : 'ok' };
}

function requireUiRole(request: FastifyRequest, reply: FastifyReply, roles: string[], backTo: string): Actor | null {
  if (!roles.includes(request.actor.role)) {
    void reply.redirect(`${backTo}?${flashQuery(`Requires one of roles: ${roles.join(', ')}`, 'err')}`, 303);
    return null;
  }
  return request.actor;
}

const STAFF_ROLES = ['OPERATOR', 'COMPLIANCE_OFFICER', 'ADMIN'];

/**
 * Second layer of D27: CLIENT keys are already rejected at /ui/login, but a
 * stray/forged cookie must never read staff data. Every /ui GET calls this;
 * non-staff get a 403 forbidden page (no nav — they don't belong here).
 */
function requireStaffUi(request: FastifyRequest, reply: FastifyReply): boolean {
  if (STAFF_ROLES.includes(request.actor.role)) return true;
  renderPage(reply, 'message', {
    testid: 'page-forbidden',
    heading: 'Staff access only',
    message: 'The admin UI is available to operator, compliance, and admin roles.',
    backHref: '/ui/login',
    backLabel: 'Go to sign in',
  }, 403);
  return false;
}

function renderNotFound(request: FastifyRequest, reply: FastifyReply, what: string, backHref: string, backLabel: string): FastifyReply {
  return renderPage(reply, 'message', {
    actor: request.actor,
    testid: 'page-notfound',
    heading: `${what} not found`,
    message: `No ${what.toLowerCase()} matches that link.`,
    backHref,
    backLabel,
  }, 404);
}

/** Unknown/malformed decision -> 400, never defaulting to the permissive action (D27; P3 Minor 6). */
function renderBadDecision(request: FastifyRequest, reply: FastifyReply, backHref: string, backLabel: string): FastifyReply {
  return renderPage(reply, 'message', {
    actor: request.actor,
    testid: 'page-badrequest',
    heading: 'Invalid decision',
    message: 'That action was not recognised.',
    backHref,
    backLabel,
  }, 400);
}

export function registerUiRoutes(app: FastifyInstance): void {
  // ---- Login / logout (public; see auth plugin PUBLIC_UI) ------------------
  app.get('/ui/login', async (request, reply) => renderPage(reply, 'login', { ...flashFromQuery(request) }));

  app.post<{ Body: { apiKey?: string } }>('/ui/login', async (request, reply) => {
    const rawKey = request.body?.apiKey ?? '';
    const apiKey = rawKey ? await prisma.apiKey.findUnique({ where: { keyHash: hashKey(rawKey) } }) : null;
    if (!apiKey || apiKey.status !== 'ACTIVE') {
      return renderPage(reply, 'login', { error: 'Unknown or inactive API key.' }, 401);
    }
    if (apiKey.role === 'CLIENT') {
      // The admin UI is a STAFF surface (§A.5); CLIENT keys use the API, not the UI (D27).
      return renderPage(reply, 'login', { error: 'The admin UI is for staff roles only (operator, compliance, admin).' }, 403);
    }
    // Mock platform: the cookie mirrors the raw key (httpOnly). Not production
    // auth by design (PRD §C.1) — the point is a role-scoped UI session.
    // SameSite=Lax is LOAD-BEARING (D27): the vc_key cookie is consulted only
    // for /ui requests and the urlencoded parser is /ui-scoped, so Lax is what
    // confines the CSRF surface to /ui. Do not weaken it.
    return reply
      .header('set-cookie', `${COOKIE}=${encodeURIComponent(rawKey)}; HttpOnly; Path=/; SameSite=Lax`)
      .redirect('/ui/queue', 303);
  });

  // POST, not GET: logout mutates session state (Nit 4 — a GET can be triggered
  // cross-site by any link/img and would log the user out).
  app.post('/ui/logout', async (_request, reply) =>
    reply.header('set-cookie', `${COOKIE}=; HttpOnly; Path=/; Max-Age=0`).redirect('/ui/login', 303));

  // ---- Approval queue ------------------------------------------------------
  app.get<{ Querystring: { walletId?: string; cursor?: string; flash?: string; kind?: string } }>(
    '/ui/queue',
    async (request, reply) => {
      if (!requireStaffUi(request, reply)) return reply;
      const { walletId, cursor } = request.query;
      const args = pageArgs({ ...(cursor ? { cursor } : {}), limit: 20 });
      const rows = await prisma.transaction.findMany({
        where: {
          type: 'WITHDRAWAL',
          state: 'PENDING_APPROVAL',
          ...(walletId ? { walletId } : {}),
        },
        orderBy: { id: 'asc' },
        ...args,
      });
      const decimals = await decimalsBySymbol(prisma);
      const pageData = toPage(rows, args.take, (tx) => serializeTx(tx, decimals));
      // Build the next-page query server-side so cursor/walletId are properly
      // URL-encoded (Nit 5 — a `+`/`&` in a walletId would corrupt an inline href).
      const nextParams = new URLSearchParams();
      if (pageData.nextCursor) nextParams.set('cursor', pageData.nextCursor);
      if (walletId) nextParams.set('walletId', walletId);
      return renderPage(reply, 'queue', {
        actor: request.actor,
        items: pageData.items,
        nextCursor: pageData.nextCursor,
        nextQuery: nextParams.toString(),
        walletId,
        ...flashFromQuery(request),
      });
    },
  );

  app.post<{ Params: { id: string }; Body: { decision?: string; walletId?: string } }>(
    '/ui/queue/:id/decision',
    async (request, reply) => {
      const backTo = '/ui/queue';
      const back = (msg: string, kind: 'ok' | 'err') =>
        reply.redirect(
          `${backTo}?${flashQuery(msg, kind, request.body.walletId ? { walletId: request.body.walletId } : {})}`,
          303,
        );
      if (!requireUiRole(request, reply, ['OPERATOR', 'ADMIN'], backTo)) return reply;
      const raw = request.body.decision;
      if (raw !== 'APPROVE' && raw !== 'REJECT') return renderBadDecision(request, reply, backTo, 'Back to the queue');
      const decision = raw;
      try {
        const tx = await addApproval(prisma, { txId: request.params.id, actor: request.actor, decision });
        return back(`${decision === 'APPROVE' ? 'Approval' : 'Rejection'} recorded — state is now ${tx.state}.`, 'ok');
      } catch (err) {
        if (err instanceof ApiProblem) return back(err.detail ?? err.title, 'err');
        throw err;
      }
    },
  );

  // ---- Transaction search --------------------------------------------------
  app.get<{
    Querystring: { walletId?: string; type?: string; state?: string; assetSymbol?: string; cursor?: string };
  }>('/ui/transactions', async (request, reply) => {
    if (!requireStaffUi(request, reply)) return reply;
    const q = request.query;
    const args = pageArgs({ ...(q.cursor ? { cursor: q.cursor } : {}), limit: 20 });
    const rows = await prisma.transaction.findMany({
      where: {
        ...(q.walletId ? { walletId: q.walletId } : {}),
        ...(q.type ? { type: q.type } : {}),
        ...(q.state ? { state: q.state } : {}),
        ...(q.assetSymbol ? { assetSymbol: q.assetSymbol } : {}),
      },
      orderBy: { id: 'asc' },
      ...args,
    });
    const decimals = await decimalsBySymbol(prisma);
    const pageData = toPage(rows, args.take, (tx) => serializeTx(tx, decimals));
    const nextParams = new URLSearchParams();
    for (const [k, v] of Object.entries({ ...q, cursor: pageData.nextCursor ?? '' })) {
      if (v) nextParams.set(k, v);
    }
    return renderPage(reply, 'transactions', {
      actor: request.actor,
      items: pageData.items,
      nextCursor: pageData.nextCursor,
      nextQuery: nextParams.toString(),
      q,
      states: TX_STATES,
      ...flashFromQuery(request),
    });
  });

  // ---- Transaction detail (timeline + hold resolution) ---------------------
  app.get<{ Params: { id: string }; Querystring: { flash?: string; kind?: string } }>(
    '/ui/transactions/:id',
    async (request, reply) => {
      if (!requireStaffUi(request, reply)) return reply;
      const tx = await prisma.transaction.findUnique({ where: { id: request.params.id } });
      if (!tx) return renderNotFound(request, reply, 'Transaction', '/ui/transactions', 'Back to search');
      const decimals = await decimalsBySymbol(prisma);
      const [approvals, travelRuleCount, openHold, audit] = await Promise.all([
        prisma.approval.findMany({ where: { transactionId: tx.id }, orderBy: { id: 'asc' } }),
        prisma.travelRuleRecord.count({ where: { transactionId: tx.id } }),
        prisma.complianceHold.findFirst({ where: { transactionId: tx.id, state: 'OPEN' } }),
        prisma.auditLogEntry.findMany({
          where: { entityType: 'Transaction', entityId: tx.id },
          orderBy: { id: 'asc' },
        }),
      ]);
      return renderPage(reply, 'transaction-detail', {
        actor: request.actor,
        tx: serializeTx(tx, decimals),
        approvals,
        travelRuleCount,
        openHold,
        canResolveHold: request.actor.role === 'COMPLIANCE_OFFICER',
        audit: audit.map((e) => ({ action: e.action, actorRole: e.actorRole, createdAt: e.createdAt.toISOString() })),
        ...flashFromQuery(request),
      });
    },
  );

  app.post<{ Params: { holdId: string }; Body: { decision?: string } }>(
    '/ui/holds/:holdId/resolve',
    async (request, reply) => {
      // Derive the back-link from the hold's OWN transaction, never body.txId
      // (Minor 5: a spoofed txId would redirect/flash on an unrelated page).
      const hold = await prisma.complianceHold.findUnique({ where: { id: request.params.holdId } });
      if (!hold) return renderNotFound(request, reply, 'Hold', '/ui/transactions', 'Back to search');
      const backTo = `/ui/transactions/${hold.transactionId}`;
      if (!requireUiRole(request, reply, ['COMPLIANCE_OFFICER'], backTo)) return reply;
      const decision = request.body.decision;
      if (decision !== 'RELEASE' && decision !== 'REJECT') return renderBadDecision(request, reply, backTo, 'Back to the transaction');
      try {
        if (decision === 'REJECT') {
          await rejectHold(prisma, request.params.holdId, request.actor);
          return reply.redirect(`${backTo}?${flashQuery('Hold rejected — transaction terminated.', 'ok')}`, 303);
        }
        await releaseHold(prisma, request.params.holdId, request.actor);
        return reply.redirect(`${backTo}?${flashQuery('Hold released — transaction resumed.', 'ok')}`, 303);
      } catch (err) {
        if (err instanceof ApiProblem) {
          return reply.redirect(`${backTo}?${flashQuery(err.detail ?? err.title, 'err')}`, 303);
        }
        throw err;
      }
    },
  );
}
