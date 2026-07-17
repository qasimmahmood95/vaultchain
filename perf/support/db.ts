// Direct-DB support for the perf harness: post-load truth assertions and
// setup that has no API surface (extra operator keys, at-scale data). The
// harness only ever touches the DB while the server is QUIESCENT (before
// boot, or after all load has drained) — SQLite allows one writer at a time
// across processes, so mid-load harness queries would contend with the
// platform under measurement.

import { PrismaClient } from '@prisma/client';
import { hashKey } from '../../scripts/seed-lib.js';

export function perfOperatorKey(index: number): string {
  return `vck_perf_op_${String(index).padStart(3, '0')}_000000`;
}

/** Seed N extra OPERATOR keys (no key-creation endpoint exists, by §A.4 design). */
export async function seedPerfOperators(prisma: PrismaClient, count: number): Promise<string[]> {
  const raws: string[] = [];
  for (let i = 1; i <= count; i += 1) {
    const raw = perfOperatorKey(i);
    await prisma.apiKey.create({
      data: { keyHash: hashKey(raw), role: 'OPERATOR', label: `perf approver ${i}` },
    });
    raws.push(raw);
  }
  return raws;
}

export interface InvariantResult {
  wallets: number;
  mismatches: { walletId: string; assetSymbol: string; ledger: bigint; balance: bigint }[];
}

/** The reconciliation invariant (PRD §A.1): Σ(ledger) == wallet.balanceMinor, every wallet. */
export async function checkInvariant(prisma: PrismaClient): Promise<InvariantResult> {
  const wallets = await prisma.wallet.findMany();
  const mismatches: InvariantResult['mismatches'] = [];
  for (const wallet of wallets) {
    const rows = await prisma.ledgerEntry.findMany({ where: { walletId: wallet.id } });
    const ledger = rows.reduce(
      (acc, r) => acc + (r.direction === 'CREDIT' ? BigInt(r.amountMinor) : -BigInt(r.amountMinor)),
      0n,
    );
    if (ledger !== BigInt(wallet.balanceMinor)) {
      mismatches.push({ walletId: wallet.id, assetSymbol: wallet.assetSymbol, ledger, balance: BigInt(wallet.balanceMinor) });
    }
  }
  return { wallets: wallets.length, mismatches };
}

export interface ScaleSeedResult {
  clientId: string;
  accountId: string;
  walletId: string;
  withdrawals: number;
  deposits: number;
}

/**
 * At-scale read-path data (D37): one perf client/account/GBPX wallet plus
 * `withdrawals` CONFIRMED withdrawals and `deposits` CREDITED deposits, with
 * a LEDGER-CONSISTENT trail (credit per deposit; principal+fee debit per
 * withdrawal; wallet balance = the exact sum) so the reconciliation invariant
 * still holds over the bulk data. IDs are explicit and deterministic —
 * createMany cannot return generated ids, and determinism is the house style.
 */
export async function seedReadPathScale(
  prisma: PrismaClient,
  opts: { withdrawals: number; deposits: number },
): Promise<ScaleSeedResult> {
  const client = await prisma.client.create({
    data: { legalName: 'Perf Scale Client (fictional)', type: 'INSTITUTION', jurisdiction: 'GB' },
  });
  const account = await prisma.account.create({
    data: {
      clientId: client.id,
      label: 'Perf scale account',
      segregationModel: 'SEGREGATED',
      wallets: { create: [{ assetSymbol: 'GBPX', segregationModel: 'SEGREGATED', depositAddress: 'vc-gbpx-perf-scale-1' }] },
      policies: { create: [{ assetSymbol: null, thresholdMinor: '100000', approvalsRequired: 2 }] },
    },
    include: { wallets: true },
  });
  const wallet = account.wallets[0];
  if (!wallet) throw new Error('scale seed: account created without a wallet');

  const DEPOSIT_MINOR = 10_000n; // 100.00 GBPX
  const WITHDRAWAL_MINOR = 2_000n; // 20.00 GBPX
  const WITHDRAWAL_FEE_MINOR = 2n; // 10 bps of 20.00, exact
  const BATCH = 2_000;

  type TxRow = {
    id: string;
    walletId: string;
    type: string;
    assetSymbol: string;
    amountMinor: string;
    feeMinor: string;
    state: string;
    counterpartyAddress?: string;
    chainTxRef?: string;
    confirmations: number;
  };
  const txRows: TxRow[] = [];
  const ledgerRows: { walletId: string; clientId: string; direction: string; amountMinor: string; kind: string; txId: string }[] = [];
  const auditRows: { actorRole: string; action: string; entityType: string; entityId: string; after: string }[] = [];

  for (let i = 1; i <= opts.deposits; i += 1) {
    const id = `perfdep${String(i).padStart(8, '0')}`;
    txRows.push({
      id,
      walletId: wallet.id,
      type: 'DEPOSIT',
      assetSymbol: 'GBPX',
      amountMinor: DEPOSIT_MINOR.toString(),
      feeMinor: '0',
      state: 'CREDITED',
      chainTxRef: `perf-scale-dep-${i}`,
      confirmations: 3,
    });
    ledgerRows.push({
      walletId: wallet.id,
      clientId: client.id,
      direction: 'CREDIT',
      amountMinor: DEPOSIT_MINOR.toString(),
      kind: 'PRINCIPAL',
      txId: id,
    });
    auditRows.push({
      actorRole: 'OPERATOR',
      action: 'TRANSACTION_CREDITED',
      entityType: 'Transaction',
      entityId: id,
      after: JSON.stringify({ state: 'CREDITED', amountMinor: DEPOSIT_MINOR.toString() }),
    });
  }
  for (let i = 1; i <= opts.withdrawals; i += 1) {
    const id = `perfwdr${String(i).padStart(8, '0')}`;
    txRows.push({
      id,
      walletId: wallet.id,
      type: 'WITHDRAWAL',
      assetSymbol: 'GBPX',
      amountMinor: WITHDRAWAL_MINOR.toString(),
      feeMinor: WITHDRAWAL_FEE_MINOR.toString(),
      state: 'CONFIRMED',
      counterpartyAddress: `vc-ext-gbpx-perf-${i}`,
      confirmations: 3,
    });
    ledgerRows.push(
      { walletId: wallet.id, clientId: client.id, direction: 'DEBIT', amountMinor: WITHDRAWAL_MINOR.toString(), kind: 'PRINCIPAL', txId: id },
      { walletId: wallet.id, clientId: client.id, direction: 'DEBIT', amountMinor: WITHDRAWAL_FEE_MINOR.toString(), kind: 'FEE', txId: id },
    );
    auditRows.push({
      actorRole: 'OPERATOR',
      action: 'TRANSACTION_CONFIRMED',
      entityType: 'Transaction',
      entityId: id,
      after: JSON.stringify({ state: 'CONFIRMED', amountMinor: WITHDRAWAL_MINOR.toString() }),
    });
  }

  for (let at = 0; at < txRows.length; at += BATCH) {
    await prisma.transaction.createMany({ data: txRows.slice(at, at + BATCH) });
  }
  for (let at = 0; at < ledgerRows.length; at += BATCH) {
    await prisma.ledgerEntry.createMany({ data: ledgerRows.slice(at, at + BATCH) });
  }
  for (let at = 0; at < auditRows.length; at += BATCH) {
    await prisma.auditLogEntry.createMany({ data: auditRows.slice(at, at + BATCH) });
  }

  const balance =
    DEPOSIT_MINOR * BigInt(opts.deposits) - (WITHDRAWAL_MINOR + WITHDRAWAL_FEE_MINOR) * BigInt(opts.withdrawals);
  if (balance < 0n) throw new Error('scale seed: pick volumes that leave a non-negative balance');
  await prisma.wallet.update({ where: { id: wallet.id }, data: { balanceMinor: balance.toString() } });

  return {
    clientId: client.id,
    accountId: account.id,
    walletId: wallet.id,
    withdrawals: opts.withdrawals,
    deposits: opts.deposits,
  };
}
