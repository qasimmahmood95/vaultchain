// Data-builder factories (PRD §B.2): fluent builders that seed via the REAL
// API (never Prisma) and return typed handles. Every builder namespaces its
// data with uniqueRef() so parallel tests are isolated by construction.
//
// Value discipline: builder DEFAULTS avoid rounding boundaries (e.g. the
// default withdrawal 1500.00 GBPX has an exact 1.50 fee at 10 bps), so happy
// paths behave identically on main and on the planted-defect branch. Tests
// that PROBE boundaries pick their own values explicitly.

import { randomUUID } from 'node:crypto';
import type { APIRequestContext } from '@playwright/test';
import { ApiClient } from '../api-client.js';
import type { ChainApi } from '../chain-clock.fixture.js';

export type AssetSymbol = 'BTC' | 'ETH' | 'GBPX';

export interface ClientHandle {
  id: string;
  legalName: string;
  vaspId: string | null;
}

export interface AccountHandle {
  accountId: string;
  clientId: string;
  wallets: { id: string; assetSymbol: string; depositAddress: string }[];
}

export interface FundedWalletHandle {
  walletId: string;
  accountId: string;
  clientId: string;
  assetSymbol: AssetSymbol;
  depositTxId: string;
  chainTxRef: string;
}

export interface AddressHandle {
  entryId: string;
  address: string;
  activatesAt: string;
}

export interface TxHandle {
  id: string;
  state: string;
  amount: string;
  fee: string;
  walletId: string;
}

/** 25 sim-hours: comfortably past the platform's 24h cooling-off window. */
export const PAST_COOLING_OFF_MS = 25n * 60n * 60n * 1000n;

export interface Build {
  /** Namespaced unique reference for addresses/idempotency keys/chainTxRefs. */
  uniqueRef(prefix: string): string;
  /** ADMIN: create a client (INSTITUTION with a vaspId by default). */
  client(overrides?: { type?: 'INDIVIDUAL' | 'INSTITUTION'; vaspId?: string | null }): Promise<ClientHandle>;
  /** OPERATOR: create an account (+wallets, + default dual-approval policy). */
  account(opts?: { clientId?: string; assets?: AssetSymbol[]; segregation?: 'SEGREGATED' | 'OMNIBUS' }): Promise<AccountHandle>;
  /** Account + registered deposit + enough blocks to credit it. */
  fundedWallet(opts?: { asset?: AssetSymbol; amount?: string; clientId?: string }): Promise<FundedWalletHandle>;
  /** Allowlist an address and jump the clock past its cooling-off (ACTIVE). */
  activeAddress(opts: { accountId: string; asset: AssetSymbol }): Promise<AddressHandle>;
  /** Allowlist an address and leave it INSIDE its cooling-off window. */
  pendingAddress(opts: { accountId: string; asset: AssetSymbol }): Promise<AddressHandle>;
  /** OPERATOR A (maker): create a withdrawal (PENDING_APPROVAL). */
  withdrawal(opts: {
    walletId: string;
    amount: string;
    address: string;
    vaspId?: string;
    idempotencyKey?: string;
  }): Promise<TxHandle>;
}

const CONFIRMATIONS_FOR_ALL_ASSETS = 12; // covers BTC(3) / ETH(12) / GBPX(1)

const DEFAULT_FUNDING: Record<AssetSymbol, string> = {
  GBPX: '10000.00',
  BTC: '2.00000000',
  ETH: '5.000000000000000000',
};

export function makeBuilders(deps: {
  asAdmin: APIRequestContext;
  asOperatorA: APIRequestContext;
  chain: ChainApi;
}): Build {
  const admin = new ApiClient(deps.asAdmin);
  const operator = new ApiClient(deps.asOperatorA);

  const build: Build = {
    uniqueRef(prefix) {
      return `${prefix}-${randomUUID()}`;
    },

    async client(overrides = {}) {
      const legalName = `Fixture Client ${build.uniqueRef('c').slice(0, 18)} (fictional)`;
      const vaspId = overrides.vaspId === undefined ? build.uniqueRef('vasp') : overrides.vaspId;
      const json = await admin.expectOk(
        admin.post('/clients', {
          legalName,
          type: overrides.type ?? 'INSTITUTION',
          jurisdiction: 'GB',
          ...(vaspId === null ? {} : { vaspId }),
        }),
        'build.client',
      );
      return { id: json.id as string, legalName, vaspId: (json.vaspId as string | null) ?? null };
    },

    async account(opts = {}) {
      const clientId = opts.clientId ?? (await build.client()).id;
      const json = await operator.expectOk(
        operator.post('/accounts', {
          clientId,
          label: build.uniqueRef('acct'),
          segregationModel: opts.segregation ?? 'SEGREGATED',
          assets: opts.assets ?? ['GBPX'],
        }),
        'build.account',
      );
      return {
        accountId: json.id as string,
        clientId,
        wallets: json.wallets as AccountHandle['wallets'],
      };
    },

    async fundedWallet(opts = {}) {
      const asset = opts.asset ?? 'GBPX';
      const account = await build.account({ assets: [asset], ...(opts.clientId ? { clientId: opts.clientId } : {}) });
      const wallet = account.wallets[0];
      if (!wallet) throw new Error('build.fundedWallet: account created without a wallet');
      const chainTxRef = build.uniqueRef('dep');
      const dep = await operator.expectOk(
        operator.post(`/wallets/${wallet.id}/deposits/simulate`, {
          amount: opts.amount ?? DEFAULT_FUNDING[asset],
          chainTxRef,
        }),
        'build.fundedWallet deposit',
      );
      await deps.chain.advanceBlocks(CONFIRMATIONS_FOR_ALL_ASSETS);
      // Guarantee the "funded" contract under PARALLEL advances: advanceChain
      // settles GLOBAL pending deposits, so a concurrent worker may have won the
      // CAS claim on our deposit's settlement (D28) and still be committing the
      // credit when we return. The wallet is fresh (starts at "0") and the
      // deposit is positive, so a non-zero balance means our credit is visible.
      // Bounded, condition-based (no sleep); re-advance nudges a still-pending
      // deposit and lets any in-flight credit commit.
      for (let attempt = 0; attempt < 8; attempt += 1) {
        const w = await operator.get<{ balanceMinor: string }>(`/wallets/${wallet.id}`);
        if (w.status === 200 && w.json.balanceMinor !== '0') break;
        await deps.chain.advanceBlocks(1);
      }
      return {
        walletId: wallet.id,
        accountId: account.accountId,
        clientId: account.clientId,
        assetSymbol: asset,
        depositTxId: dep.id as string,
        chainTxRef,
      };
    },

    async activeAddress(opts) {
      const entry = await build.pendingAddress(opts);
      await deps.chain.advanceClockMs(PAST_COOLING_OFF_MS);
      return entry;
    },

    async pendingAddress(opts) {
      const address = build.uniqueRef(`ext-${opts.asset.toLowerCase()}`);
      const json = await operator.expectOk(
        operator.post(`/accounts/${opts.accountId}/allowlist`, {
          assetSymbol: opts.asset,
          address,
          label: 'fixture payout destination',
        }),
        'build.pendingAddress',
      );
      return { entryId: json.id as string, address, activatesAt: json.activatesAt as string };
    },

    async withdrawal(opts) {
      const json = await operator.expectOk(
        operator.post('/withdrawals', {
          walletId: opts.walletId,
          amount: opts.amount,
          counterpartyAddress: opts.address,
          ...(opts.vaspId ? { counterpartyVaspId: opts.vaspId } : {}),
          ...(opts.idempotencyKey ? { idempotencyKey: opts.idempotencyKey } : {}),
        }),
        'build.withdrawal',
      );
      return {
        id: json.id as string,
        state: json.state as string,
        amount: json.amount as string,
        fee: json.fee as string,
        walletId: opts.walletId,
      };
    },
  };

  return build;
}
