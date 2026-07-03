// Deterministic seed (PRD §A.6): fixed RNG seed 42 — every run produces the
// same plausible dataset. Balances are built so the reconciliation invariant
// (sum of ledger == wallet balance) HOLDS: main is the fixed platform.

import { PrismaClient } from '@prisma/client';
import { WITHDRAWAL_FEE_BPS } from '../src/config.js';
import { feeFor } from '../src/services/money.js';
import {
  ASSETS,
  FICTIONAL_CLIENTS,
  RAW_KEYS,
  SIM_CLOCK_START,
  clientKey,
  hashKey,
  intBetween,
  makeRng,
  pick,
  printKeyTable,
  wipe,
} from './seed-lib.js';

const prisma = new PrismaClient();
const rng = makeRng(42);

// GBPX minor-unit amounts include x.5-fee cases; ETH amounts exercise 18 dp.
const DEPOSIT_AMOUNTS: Record<string, string[]> = {
  BTC: ['25000000', '100000000', '5000000', '750000000', '12345678'],
  ETH: ['1000000000000000000', '2500000000000000000', '10000000000000000', '123456789012345678'],
  GBPX: ['150000', '1234', '99999', '100000', '5000000', '1500'],
};
const WITHDRAWAL_AMOUNTS: Record<string, string[]> = {
  BTC: ['10000000', '2000000', '50000000'],
  ETH: ['500000000000000000', '50000000000000000'],
  GBPX: ['50000', '1500', '99999', '100000'],
};

async function main(): Promise<void> {
  await wipe(prisma);

  await prisma.chainState.create({
    data: { id: 'chain', blockHeight: 5000, simClockMs: SIM_CLOCK_START.toString() },
  });
  for (const asset of ASSETS) await prisma.asset.create({ data: asset });

  // --- API keys ---
  const admin = await prisma.apiKey.create({
    data: { keyHash: hashKey(RAW_KEYS.admin), role: 'ADMIN', label: 'root admin' },
  });
  const operatorA = await prisma.apiKey.create({
    data: { keyHash: hashKey(RAW_KEYS.operatorA), role: 'OPERATOR', label: 'operator A' },
  });
  await prisma.apiKey.create({
    data: { keyHash: hashKey(RAW_KEYS.operatorB), role: 'OPERATOR', label: 'operator B' },
  });
  await prisma.apiKey.create({
    data: { keyHash: hashKey(RAW_KEYS.compliance), role: 'COMPLIANCE_OFFICER', label: 'compliance officer' },
  });

  // --- Clients (+ one tenant-bound key each) ---
  const clients = [];
  for (let i = 0; i < FICTIONAL_CLIENTS.length; i += 1) {
    const spec = FICTIONAL_CLIENTS[i]!;
    const client = await prisma.client.create({
      data: { legalName: spec.legalName, type: spec.type, jurisdiction: spec.jurisdiction, vaspId: spec.vaspId },
    });
    await prisma.apiKey.create({
      data: { keyHash: hashKey(clientKey(i + 1)), role: 'CLIENT', clientId: client.id, label: `client key ${i + 1}` },
    });
    await prisma.auditLogEntry.create({
      data: {
        actorApiKeyId: admin.id, actorRole: 'ADMIN', action: 'CLIENT_CREATED',
        entityType: 'Client', entityId: client.id,
        after: JSON.stringify({ legalName: client.legalName, type: client.type }),
      },
    });
    clients.push(client);
  }

  // --- Accounts (~20, both segregation models) + wallets + policies ---
  const wallets: { id: string; assetSymbol: string; clientId: string; accountId: string }[] = [];
  let accountCount = 0;
  for (const client of clients) {
    const n = intBetween(rng, 2, 3);
    for (let a = 0; a < n; a += 1) {
      accountCount += 1;
      const segregation = rng() < 0.4 ? 'OMNIBUS' : 'SEGREGATED';
      const assetSymbols = rng() < 0.5 ? ['BTC', 'ETH', 'GBPX'] : ['GBPX', pick(rng, ['BTC', 'ETH'])];
      const account = await prisma.account.create({
        data: {
          clientId: client.id,
          label: `${segregation === 'OMNIBUS' ? 'Pooled' : 'Segregated'} account ${accountCount}`,
          segregationModel: segregation,
          wallets: {
            create: [...new Set(assetSymbols)].map((symbol) => ({
              assetSymbol: symbol,
              segregationModel: segregation,
              depositAddress: `vc-${symbol.toLowerCase()}-seed-${accountCount}-${symbol}`,
            })),
          },
          policies: {
            create: [
              // Default policy: dual approval above a per-asset-agnostic threshold.
              { assetSymbol: null, thresholdMinor: '100000', approvalsRequired: 2, makerCannotCheck: true },
            ],
          },
        },
        include: { wallets: true },
      });
      await prisma.auditLogEntry.create({
        data: {
          actorApiKeyId: operatorA.id, actorRole: 'OPERATOR', action: 'ACCOUNT_CREATED',
          entityType: 'Account', entityId: account.id,
          after: JSON.stringify({ label: account.label, segregationModel: segregation }),
        },
      });
      for (const w of account.wallets) {
        wallets.push({ id: w.id, assetSymbol: w.assetSymbol, clientId: client.id, accountId: account.id });
      }
    }
  }

  // --- Historical transactions (~300) with a CONSISTENT ledger ---
  const balances = new Map<string, bigint>();
  let txCount = 0;
  let refSeq = 0;

  const credit = async (walletId: string, clientId: string, amountMinor: bigint, txId: string) => {
    balances.set(walletId, (balances.get(walletId) ?? 0n) + amountMinor);
    await prisma.ledgerEntry.create({
      data: { walletId, clientId, direction: 'CREDIT', amountMinor: amountMinor.toString(), kind: 'PRINCIPAL', txId },
    });
  };
  const debit = async (walletId: string, clientId: string, amountMinor: bigint, feeMinor: bigint, txId: string) => {
    balances.set(walletId, (balances.get(walletId) ?? 0n) - amountMinor - feeMinor);
    await prisma.ledgerEntry.create({
      data: { walletId, clientId, direction: 'DEBIT', amountMinor: amountMinor.toString(), kind: 'PRINCIPAL', txId },
    });
    await prisma.ledgerEntry.create({
      data: { walletId, clientId, direction: 'DEBIT', amountMinor: feeMinor.toString(), kind: 'FEE', txId },
    });
  };

  for (const wallet of wallets) {
    const deposits = intBetween(rng, 3, 6);
    for (let i = 0; i < deposits; i += 1) {
      refSeq += 1;
      txCount += 1;
      const amount = BigInt(pick(rng, DEPOSIT_AMOUNTS[wallet.assetSymbol] ?? ['1000']));
      const chainTxRef = `seed-dep-${refSeq}`;
      const inFlight = rng() < 0.12;
      const tx = await prisma.transaction.create({
        data: {
          walletId: wallet.id, type: 'DEPOSIT', assetSymbol: wallet.assetSymbol,
          amountMinor: amount.toString(), state: inFlight ? 'PENDING_CONFIRMATION' : 'CREDITED',
          chainTxRef, broadcastBlockHeight: intBetween(rng, 4000, 4990),
          confirmations: inFlight ? 0 : intBetween(rng, 3, 20),
        },
      });
      await prisma.auditLogEntry.create({
        data: {
          actorApiKeyId: operatorA.id, actorRole: 'OPERATOR', action: 'DEPOSIT_DETECTED',
          entityType: 'Transaction', entityId: tx.id,
          after: JSON.stringify({ state: 'DETECTED', amountMinor: tx.amountMinor, chainTxRef }),
        },
      });
      if (!inFlight) {
        await prisma.processedEvent.create({ data: { walletId: wallet.id, chainTxRef } });
        await credit(wallet.id, wallet.clientId, amount, tx.id);
        await prisma.auditLogEntry.create({
          data: {
            actorApiKeyId: operatorA.id, actorRole: 'OPERATOR', action: 'TRANSACTION_CREDITED',
            entityType: 'Transaction', entityId: tx.id,
            before: JSON.stringify({ state: 'SCREENING' }), after: JSON.stringify({ state: 'CREDITED' }),
          },
        });
      }
    }

    const withdrawals = intBetween(rng, 1, 3);
    for (let i = 0; i < withdrawals; i += 1) {
      txCount += 1;
      const amount = BigInt(pick(rng, WITHDRAWAL_AMOUNTS[wallet.assetSymbol] ?? ['100']));
      const fee = feeFor(amount, WITHDRAWAL_FEE_BPS); // the platform's own rounding — seed stays consistent by construction
      const available = balances.get(wallet.id) ?? 0n;
      if (available < amount + fee) continue; // never seed an inconsistent ledger
      const terminalStates = ['CONFIRMED', 'CONFIRMED', 'CONFIRMED', 'REJECTED', 'CANCELLED', 'PENDING_APPROVAL'];
      const state = pick(rng, terminalStates);
      const tx = await prisma.transaction.create({
        data: {
          walletId: wallet.id, type: 'WITHDRAWAL', assetSymbol: wallet.assetSymbol,
          amountMinor: amount.toString(), feeMinor: fee.toString(), state,
          counterpartyAddress: `vc-ext-${wallet.assetSymbol.toLowerCase()}-${txCount}`,
          counterpartyVaspId: rng() < 0.3 ? pick(rng, ['vasp-aldgate', 'vasp-foxwhelp', 'vasp-kohaku']) : null,
          broadcastBlockHeight: state === 'CONFIRMED' ? intBetween(rng, 4000, 4990) : null,
          confirmations: state === 'CONFIRMED' ? intBetween(rng, 3, 15) : 0,
        },
      });
      await prisma.auditLogEntry.create({
        data: {
          actorApiKeyId: operatorA.id, actorRole: 'OPERATOR', action: 'WITHDRAWAL_CREATED',
          entityType: 'Transaction', entityId: tx.id,
          after: JSON.stringify({ state: 'PENDING_APPROVAL', amountMinor: tx.amountMinor, feeMinor: tx.feeMinor }),
        },
      });
      if (state === 'CONFIRMED') {
        await debit(wallet.id, wallet.clientId, amount, fee, tx.id);
        await prisma.auditLogEntry.create({
          data: {
            actorApiKeyId: operatorA.id, actorRole: 'OPERATOR', action: 'TRANSACTION_CONFIRMED',
            entityType: 'Transaction', entityId: tx.id,
            before: JSON.stringify({ state: 'PENDING_CONFIRMATION' }), after: JSON.stringify({ state: 'CONFIRMED' }),
          },
        });
      }
    }
  }

  // --- The 5-client omnibus wallet edge case (PRD §A.6) ---
  const omnibusHost = clients[0]!;
  const coClients = clients.slice(1, 6);
  const omnibusAccount = await prisma.account.create({
    data: {
      clientId: omnibusHost.id,
      label: 'Shared omnibus GBPX pool',
      segregationModel: 'OMNIBUS',
      wallets: {
        create: [{ assetSymbol: 'GBPX', segregationModel: 'OMNIBUS', depositAddress: 'vc-gbpx-omnibus-pool-1' }],
      },
      policies: { create: [{ assetSymbol: null, thresholdMinor: '100000', approvalsRequired: 2 }] },
    },
    include: { wallets: true },
  });
  const pool = omnibusAccount.wallets[0]!;
  let poolTotal = 0n;
  for (const [i, co] of [omnibusHost, ...coClients].entries()) {
    refSeq += 1;
    const amount = BigInt(100_000 + i * 12_345);
    const tx = await prisma.transaction.create({
      data: {
        walletId: pool.id, type: 'DEPOSIT', assetSymbol: 'GBPX',
        amountMinor: amount.toString(), state: 'CREDITED', chainTxRef: `seed-pool-${refSeq}`,
        broadcastBlockHeight: 4500, confirmations: 6,
      },
    });
    await prisma.processedEvent.create({ data: { walletId: pool.id, chainTxRef: `seed-pool-${refSeq}` } });
    await prisma.ledgerEntry.create({
      data: { walletId: pool.id, clientId: co.id, direction: 'CREDIT', amountMinor: amount.toString(), kind: 'PRINCIPAL', txId: tx.id },
    });
    poolTotal += amount;
  }
  balances.set(pool.id, poolTotal);

  for (const [walletId, balance] of balances) {
    await prisma.wallet.update({ where: { id: walletId }, data: { balanceMinor: balance.toString() } });
  }

  // --- Allowlist: mostly active, some still cooling off; ETH case-mix edge ---
  const accounts = await prisma.account.findMany({ include: { wallets: true } });
  let allowSeq = 0;
  for (const account of accounts) {
    for (const w of account.wallets) {
      if (rng() < 0.5) continue;
      allowSeq += 1;
      const coolingOff = rng() < 0.25;
      const mixedCase = w.assetSymbol === 'ETH' && rng() < 0.5;
      const raw = `vc-ext-${w.assetSymbol.toLowerCase()}-allow-${allowSeq}`;
      const address = mixedCase ? raw.toUpperCase() : raw;
      await prisma.allowlistedAddress.create({
        data: {
          accountId: account.id,
          assetSymbol: w.assetSymbol,
          address,
          addressNorm: w.assetSymbol === 'ETH' ? address.toLowerCase() : address,
          label: `Payout destination ${allowSeq}`,
          addedByApiKeyId: operatorA.id,
          activatesAt: (coolingOff ? SIM_CLOCK_START + 86_400_000n : SIM_CLOCK_START - 1_000_000n).toString(),
          status: 'PENDING',
        },
      });
    }
  }

  // --- A few open screening holds on HELD transactions ---
  for (let i = 0; i < 3; i += 1) {
    const wallet = pick(rng, wallets.filter((w) => w.assetSymbol === 'GBPX'));
    refSeq += 1;
    const tx = await prisma.transaction.create({
      data: {
        walletId: wallet.id, type: 'DEPOSIT', assetSymbol: 'GBPX',
        amountMinor: '250000', state: 'HELD', chainTxRef: `seed-held-${refSeq}`,
        broadcastBlockHeight: 4950, confirmations: 2,
      },
    });
    const hold = await prisma.complianceHold.create({
      data: { transactionId: tx.id, reason: 'SCREENING_FLAG', openedBy: 'system' },
    });
    await prisma.auditLogEntry.create({
      data: {
        actorApiKeyId: null, actorRole: null, action: 'HOLD_OPENED',
        entityType: 'ComplianceHold', entityId: hold.id,
        after: JSON.stringify({ transactionId: tx.id, reason: 'SCREENING_FLAG', state: 'OPEN' }),
      },
    });
  }

  // --- One webhook subscription so lifecycle events record deliveries ---
  await prisma.webhookSubscription.create({
    data: {
      url: 'https://hooks.client.example/vaultchain',
      secret: 'mock-webhook-secret-0001',
      events: JSON.stringify([
        'deposit.detected', 'deposit.credited', 'withdrawal.approved',
        'withdrawal.broadcast', 'withdrawal.confirmed', 'hold.opened', 'hold.released',
      ]),
    },
  });

  const ledgerSum = await prisma.ledgerEntry.findMany();
  console.log(`Seeded: ${clients.length} clients, ${accounts.length} accounts, ${wallets.length + 1} wallets, ` +
    `${txCount + 9} transactions, ${ledgerSum.length} ledger rows.`);
  printKeyTable(clients.length);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
