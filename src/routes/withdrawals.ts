import type { FastifyInstance } from 'fastify';
import { prisma } from '../db.js';
import { notFound } from '../errors.js';
import { requireRole } from '../plugins/auth.js';
import { decimalsBySymbol, pageArgs, serializeTx, toPage } from '../serialize.js';
import { addApproval } from '../services/approvals.js';
import { registerDeposit } from '../services/deposits.js';
import { attachTravelRule, cancelWithdrawal, createWithdrawal } from '../services/withdrawals.js';

interface CreateWithdrawalBody {
  walletId: string;
  amount: string;
  counterpartyAddress: string;
  counterpartyVaspId?: string;
  idempotencyKey?: string;
}

const createWithdrawalSchema = {
  body: {
    type: 'object',
    required: ['walletId', 'amount', 'counterpartyAddress'],
    additionalProperties: false,
    properties: {
      walletId: { type: 'string' },
      amount: { type: 'string', pattern: '^\\d+(\\.\\d+)?$' },
      counterpartyAddress: { type: 'string', minLength: 4 },
      counterpartyVaspId: { type: 'string', minLength: 1 },
      idempotencyKey: { type: 'string', minLength: 8 },
    },
  },
} as const;

const travelRuleSchema = {
  body: {
    type: 'object',
    required: ['originator', 'beneficiary'],
    additionalProperties: false,
    properties: {
      originator: {
        type: 'object',
        required: ['name', 'accountRef'],
        additionalProperties: false,
        properties: {
          name: { type: 'string', minLength: 1 },
          accountRef: { type: 'string', minLength: 1 },
          physicalAddress: { type: 'string', minLength: 1 },
          dateOfBirth: { type: 'string', minLength: 1 },
        },
      },
      beneficiary: {
        type: 'object',
        required: ['name', 'accountRef'],
        additionalProperties: false,
        properties: {
          name: { type: 'string', minLength: 1 },
          accountRef: { type: 'string', minLength: 1 },
        },
      },
    },
  },
} as const;

/** CLIENT keys can act only on withdrawals in their own client's wallets. */
async function loadWithdrawalScoped(actor: { role: string; clientId: string | null }, id: string) {
  const tx = await prisma.transaction.findUnique({
    where: { id },
    include: { wallet: { include: { account: true } } },
  });
  if (!tx || tx.type !== 'WITHDRAWAL') throw notFound('Withdrawal');
  if (actor.role === 'CLIENT' && tx.wallet.account.clientId !== actor.clientId) throw notFound('Withdrawal');
  return tx;
}

export function registerWithdrawalRoutes(app: FastifyInstance): void {
  app.post<{ Body: CreateWithdrawalBody }>(
    '/withdrawals',
    { schema: createWithdrawalSchema, preHandler: requireRole('CLIENT', 'OPERATOR', 'ADMIN') },
    async (request, reply) => {
      if (request.actor.role === 'CLIENT') {
        const wallet = await prisma.wallet.findUnique({
          where: { id: request.body.walletId },
          include: { account: true },
        });
        if (!wallet || wallet.account.clientId !== request.actor.clientId) throw notFound('Wallet');
      }
      const { tx, created } = await createWithdrawal(prisma, {
        walletId: request.body.walletId,
        amount: request.body.amount,
        counterpartyAddress: request.body.counterpartyAddress,
        counterpartyVaspId: request.body.counterpartyVaspId,
        idempotencyKey: request.body.idempotencyKey,
        actor: request.actor,
      });
      const decimals = await decimalsBySymbol(prisma);
      return reply.code(created ? 201 : 200).send(serializeTx(tx, decimals));
    },
  );

  app.get<{ Querystring: { cursor?: string; limit?: number; state?: string; walletId?: string } }>(
    '/withdrawals',
    { preHandler: requireRole('CLIENT', 'OPERATOR', 'COMPLIANCE_OFFICER', 'ADMIN') },
    async (request) => {
      const args = pageArgs(request.query);
      const rows = await prisma.transaction.findMany({
        where: {
          type: 'WITHDRAWAL',
          ...(request.query.state ? { state: request.query.state } : {}),
          ...(request.query.walletId ? { walletId: request.query.walletId } : {}),
          ...(request.actor.role === 'CLIENT'
            ? { wallet: { account: { clientId: request.actor.clientId ?? '' } } }
            : {}),
        },
        orderBy: { id: 'asc' },
        ...args,
      });
      const decimals = await decimalsBySymbol(prisma);
      return toPage(rows, args.take, (tx) => serializeTx(tx, decimals));
    },
  );

  app.get<{ Params: { id: string } }>(
    '/withdrawals/:id',
    { preHandler: requireRole('CLIENT', 'OPERATOR', 'COMPLIANCE_OFFICER', 'ADMIN') },
    async (request) => {
      const tx = await loadWithdrawalScoped(request.actor, request.params.id);
      const decimals = await decimalsBySymbol(prisma);
      const approvals = await prisma.approval.findMany({ where: { transactionId: tx.id }, orderBy: { id: 'asc' } });
      const travelRuleRecords = await prisma.travelRuleRecord.findMany({ where: { transactionId: tx.id } });
      return {
        ...serializeTx(tx, decimals),
        approvals: approvals.map((a) => ({
          approverApiKeyId: a.approverApiKeyId,
          approverRole: a.approverRole,
          decision: a.decision,
        })),
        travelRule: travelRuleRecords.map((r) => ({ direction: r.direction, payload: JSON.parse(r.payload) as unknown })),
      };
    },
  );

  app.post<{ Params: { id: string }; Body: { decision: 'APPROVE' | 'REJECT' } }>(
    '/withdrawals/:id/approvals',
    {
      schema: {
        body: {
          type: 'object',
          required: ['decision'],
          additionalProperties: false,
          properties: { decision: { type: 'string', enum: ['APPROVE', 'REJECT'] } },
        },
      },
      preHandler: requireRole('OPERATOR', 'ADMIN'),
    },
    async (request, reply) => {
      const tx = await addApproval(prisma, {
        txId: request.params.id,
        actor: request.actor,
        decision: request.body.decision,
      });
      const decimals = await decimalsBySymbol(prisma);
      return reply.code(201).send(serializeTx(tx, decimals));
    },
  );

  app.post<{ Params: { id: string } }>(
    '/withdrawals/:id/cancel',
    { preHandler: requireRole('CLIENT', 'OPERATOR', 'ADMIN') },
    async (request) => {
      await loadWithdrawalScoped(request.actor, request.params.id);
      const tx = await cancelWithdrawal(prisma, request.params.id, request.actor);
      const decimals = await decimalsBySymbol(prisma);
      return serializeTx(tx, decimals);
    },
  );

  app.post<{
    Params: { id: string };
    Body: {
      originator: { name: string; accountRef: string; physicalAddress?: string; dateOfBirth?: string };
      beneficiary: { name: string; accountRef: string };
    };
  }>(
    '/withdrawals/:id/travel-rule',
    { schema: travelRuleSchema, preHandler: requireRole('OPERATOR', 'COMPLIANCE_OFFICER', 'ADMIN') },
    async (request, reply) => {
      const tx = await attachTravelRule(prisma, {
        txId: request.params.id,
        actor: request.actor,
        originator: request.body.originator,
        beneficiary: request.body.beneficiary,
      });
      const decimals = await decimalsBySymbol(prisma);
      return reply.code(201).send(serializeTx(tx, decimals));
    },
  );
}

export function registerDepositRoutes(app: FastifyInstance): void {
  app.post<{ Params: { id: string }; Body: { amount: string; chainTxRef: string } }>(
    '/wallets/:id/deposits/simulate',
    {
      schema: {
        body: {
          type: 'object',
          required: ['amount', 'chainTxRef'],
          additionalProperties: false,
          properties: {
            amount: { type: 'string', pattern: '^\\d+(\\.\\d+)?$' },
            chainTxRef: { type: 'string', minLength: 4 },
          },
        },
      },
      preHandler: requireRole('OPERATOR', 'ADMIN'),
    },
    async (request, reply) => {
      const tx = await registerDeposit(prisma, {
        walletId: request.params.id,
        amount: request.body.amount,
        chainTxRef: request.body.chainTxRef,
        actor: request.actor,
      });
      const decimals = await decimalsBySymbol(prisma);
      return reply.code(201).send(serializeTx(tx, decimals));
    },
  );
}
