// Response shaping: minor units stay strings; a formatted decimal `amount`
// is added using the asset's own decimals.

import type { Transaction, Wallet } from '@prisma/client';
import type { Db } from './db.js';
import { fromMinor } from './services/money.js';

export async function decimalsBySymbol(db: Db): Promise<Map<string, number>> {
  const assets = await db.asset.findMany();
  return new Map(assets.map((a) => [a.symbol, a.decimals]));
}

export function serializeTx(tx: Transaction, decimals: Map<string, number>): Record<string, unknown> {
  const d = decimals.get(tx.assetSymbol) ?? 0;
  return {
    id: tx.id,
    walletId: tx.walletId,
    type: tx.type,
    assetSymbol: tx.assetSymbol,
    amountMinor: tx.amountMinor,
    amount: fromMinor(BigInt(tx.amountMinor), d),
    feeMinor: tx.feeMinor,
    fee: fromMinor(BigInt(tx.feeMinor), d),
    state: tx.state,
    counterpartyAddress: tx.counterpartyAddress,
    counterpartyVaspId: tx.counterpartyVaspId,
    chainTxRef: tx.chainTxRef,
    confirmations: tx.confirmations,
    idempotencyKey: tx.idempotencyKey,
    createdAt: tx.createdAt.toISOString(),
    updatedAt: tx.updatedAt.toISOString(),
  };
}

export function serializeWallet(wallet: Wallet, decimals: Map<string, number>): Record<string, unknown> {
  const d = decimals.get(wallet.assetSymbol) ?? 0;
  return {
    id: wallet.id,
    accountId: wallet.accountId,
    assetSymbol: wallet.assetSymbol,
    segregationModel: wallet.segregationModel,
    depositAddress: wallet.depositAddress,
    balanceMinor: wallet.balanceMinor,
    balance: fromMinor(BigInt(wallet.balanceMinor), d),
  };
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

/** take/cursor helpers for cursor pagination (PRD §A.4). */
export function pageArgs(query: { cursor?: string; limit?: number }): {
  take: number;
  skip?: number;
  cursor?: { id: string };
} {
  const take = Math.min(Math.max(query.limit ?? 20, 1), 100) + 1;
  return query.cursor ? { take, skip: 1, cursor: { id: query.cursor } } : { take };
}

export function toPage<T extends { id: string }, R>(rows: T[], take: number, map: (row: T) => R): Page<R> {
  const hasMore = rows.length === take;
  const items = hasMore ? rows.slice(0, -1) : rows;
  return {
    items: items.map(map),
    nextCursor: hasMore ? (items[items.length - 1]?.id ?? null) : null,
  };
}
