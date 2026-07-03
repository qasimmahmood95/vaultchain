import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { prisma } from '../db.js';
import { notFound } from '../errors.js';
import { requireRole } from '../plugins/auth.js';
import { decimalsBySymbol, serializeWallet } from '../serialize.js';
import { addAllowlistedAddress, isActive, removeEntry } from '../services/allowlist.js';
import { writeAudit } from '../services/audit.js';

interface CreateAccountBody {
  clientId: string;
  label: string;
  segregationModel: 'SEGREGATED' | 'OMNIBUS';
  assets: string[];
}

const createAccountSchema = {
  body: {
    type: 'object',
    required: ['clientId', 'label', 'segregationModel', 'assets'],
    additionalProperties: false,
    properties: {
      clientId: { type: 'string' },
      label: { type: 'string', minLength: 1 },
      segregationModel: { type: 'string', enum: ['SEGREGATED', 'OMNIBUS'] },
      assets: { type: 'array', items: { type: 'string' }, minItems: 1 },
    },
  },
} as const;

/** 404 (not 403) on cross-tenant access: existence is not leaked. */
async function loadAccountScoped(request: { actor: { role: string; clientId: string | null } }, accountId: string) {
  const account = await prisma.account.findUnique({ where: { id: accountId } });
  if (!account) throw notFound('Account');
  if (request.actor.role === 'CLIENT' && account.clientId !== request.actor.clientId) throw notFound('Account');
  return account;
}

export function registerAccountRoutes(app: FastifyInstance): void {
  app.post<{ Body: CreateAccountBody }>(
    '/accounts',
    { schema: createAccountSchema, preHandler: requireRole('OPERATOR', 'ADMIN') },
    async (request, reply) => {
      const client = await prisma.client.findUnique({ where: { id: request.body.clientId } });
      if (!client) throw notFound('Client');
      for (const symbol of request.body.assets) {
        const asset = await prisma.asset.findUnique({ where: { symbol } });
        if (!asset) throw notFound(`Asset ${symbol}`);
      }
      const account = await prisma.account.create({
        data: {
          clientId: client.id,
          label: request.body.label,
          segregationModel: request.body.segregationModel,
          wallets: {
            create: request.body.assets.map((symbol) => ({
              assetSymbol: symbol,
              segregationModel: request.body.segregationModel,
              depositAddress: `vc-${symbol.toLowerCase()}-${randomUUID()}`,
            })),
          },
        },
        include: { wallets: true },
      });
      await writeAudit(prisma, {
        actor: request.actor,
        action: 'ACCOUNT_CREATED',
        entityType: 'Account',
        entityId: account.id,
        after: { clientId: client.id, label: account.label, segregationModel: account.segregationModel },
      });
      return reply.code(201).send(account);
    },
  );

  app.get<{ Params: { id: string } }>(
    '/accounts/:id',
    { preHandler: requireRole('CLIENT', 'OPERATOR', 'COMPLIANCE_OFFICER', 'ADMIN') },
    async (request) => loadAccountScoped(request, request.params.id),
  );

  app.get<{ Params: { id: string } }>(
    '/accounts/:id/wallets',
    { preHandler: requireRole('CLIENT', 'OPERATOR', 'COMPLIANCE_OFFICER', 'ADMIN') },
    async (request) => {
      const account = await loadAccountScoped(request, request.params.id);
      const wallets = await prisma.wallet.findMany({ where: { accountId: account.id }, orderBy: { id: 'asc' } });
      const decimals = await decimalsBySymbol(prisma);
      return { items: wallets.map((w) => serializeWallet(w, decimals)) };
    },
  );

  app.get<{ Params: { id: string } }>(
    '/wallets/:id',
    { preHandler: requireRole('CLIENT', 'OPERATOR', 'COMPLIANCE_OFFICER', 'ADMIN') },
    async (request) => {
      const wallet = await prisma.wallet.findUnique({
        where: { id: request.params.id },
        include: { account: true },
      });
      if (!wallet) throw notFound('Wallet');
      if (request.actor.role === 'CLIENT' && wallet.account.clientId !== request.actor.clientId) {
        throw notFound('Wallet');
      }
      const decimals = await decimalsBySymbol(prisma);
      return serializeWallet(wallet, decimals);
    },
  );

  app.post<{ Params: { id: string }; Body: { assetSymbol: string; address: string; label: string } }>(
    '/accounts/:id/allowlist',
    {
      schema: {
        body: {
          type: 'object',
          required: ['assetSymbol', 'address', 'label'],
          additionalProperties: false,
          properties: {
            assetSymbol: { type: 'string' },
            address: { type: 'string', minLength: 4 },
            label: { type: 'string', minLength: 1 },
          },
        },
      },
      preHandler: requireRole('OPERATOR', 'ADMIN'),
    },
    async (request, reply) => {
      const account = await loadAccountScoped(request, request.params.id);
      const asset = await prisma.asset.findUnique({ where: { symbol: request.body.assetSymbol } });
      if (!asset) throw notFound('Asset');
      const entry = await addAllowlistedAddress(prisma, {
        accountId: account.id,
        assetSymbol: asset.symbol,
        address: request.body.address,
        label: request.body.label,
        actor: request.actor,
      });
      return reply.code(201).send(entry);
    },
  );

  app.get<{ Params: { id: string } }>(
    '/accounts/:id/allowlist',
    { preHandler: requireRole('CLIENT', 'OPERATOR', 'COMPLIANCE_OFFICER', 'ADMIN') },
    async (request) => {
      const account = await loadAccountScoped(request, request.params.id);
      const entries = await prisma.allowlistedAddress.findMany({
        where: { accountId: account.id, status: { not: 'REMOVED' } },
        orderBy: { id: 'asc' },
      });
      return {
        items: await Promise.all(
          entries.map(async (e) => ({ ...e, effectiveStatus: (await isActive(prisma, e)) ? 'ACTIVE' : 'PENDING' })),
        ),
      };
    },
  );

  app.delete<{ Params: { id: string; addrId: string } }>(
    '/accounts/:id/allowlist/:addrId',
    { preHandler: requireRole('OPERATOR', 'ADMIN') },
    async (request, reply) => {
      const account = await loadAccountScoped(request, request.params.id);
      const entry = await prisma.allowlistedAddress.findUnique({ where: { id: request.params.addrId } });
      if (!entry || entry.accountId !== account.id || entry.status === 'REMOVED') throw notFound('Allowlist entry');
      await removeEntry(prisma, entry, request.actor);
      return reply.code(204).send();
    },
  );
}
