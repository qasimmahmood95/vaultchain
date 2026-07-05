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

export function registerUiRoutes(app: FastifyInstance): void {
  // ---- Login / logout (public; see auth plugin PUBLIC_UI) ------------------
  app.get('/ui/login', async (request, reply) => renderPage(reply, 'login', { ...flashFromQuery(request) }));

  app.post<{ Body: { apiKey?: string } }>('/ui/login', async (request, reply) => {
    const rawKey = request.body?.apiKey ?? '';
    const apiKey = rawKey ? await prisma.apiKey.findUnique({ where: { keyHash: hashKey(rawKey) } }) : null;
    if (!apiKey || apiKey.status !== 'ACTIVE') {
      return renderPage(reply, 'login', { error: 'Unknown or inactive API key.' }, 401);
    }
    // Mock platform: the cookie mirrors the raw key (httpOnly). Not production
    // auth by design (PRD §C.1) — the point is a role-scoped UI session.
    return reply
      .header('set-cookie', `${COOKIE}=${encodeURIComponent(rawKey)}; HttpOnly; Path=/; SameSite=Lax`)
      .redirect('/ui/queue', 303);
  });

  app.get('/ui/logout', async (_request, reply) =>
    reply.header('set-cookie', `${COOKIE}=; HttpOnly; Path=/; Max-Age=0`).redirect('/ui/login', 303));

  // ---- Approval queue ------------------------------------------------------
  app.get<{ Querystring: { walletId?: string; cursor?: string; flash?: string; kind?: string } }>(
    '/ui/queue',
    async (request, reply) => {
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
      return renderPage(reply, 'queue', {
        actor: request.actor,
        items: pageData.items,
        nextCursor: pageData.nextCursor,
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
      const decision = request.body.decision === 'REJECT' ? 'REJECT' : 'APPROVE';
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
      const tx = await prisma.transaction.findUnique({ where: { id: request.params.id } });
      if (!tx) return renderPage(reply, 'login', { error: 'Transaction not found.' }, 404);
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

  app.post<{ Params: { holdId: string }; Body: { decision?: string; txId?: string } }>(
    '/ui/holds/:holdId/resolve',
    async (request, reply) => {
      const backTo = `/ui/transactions/${request.body.txId ?? ''}`;
      if (!requireUiRole(request, reply, ['COMPLIANCE_OFFICER'], backTo)) return reply;
      try {
        if (request.body.decision === 'REJECT') {
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
