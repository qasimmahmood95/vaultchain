// Curated demo seed (PRD §A.6): a small, hand-staged dataset whose state is
// exactly the preconditions the §D.2 walkthrough (and the defect repro
// recipes) need. Deterministic — no RNG at all.
//
// Stages:
//  - two VASP clients + one individual, funded GBPX/BTC/ETH wallets
//  - an ACTIVE allowlist entry and one still in cooling-off
//  - an above-threshold cross-VASP withdrawal in PENDING_APPROVAL
//  - an OPEN screening hold
//  - a CREDITED deposit with its recorded deposit.detected delivery

import { PrismaClient } from '@prisma/client';
import { WITHDRAWAL_FEE_BPS } from '../src/config.js';
import { feeFor } from '../src/services/money.js';
import { signPayload } from '../src/services/webhooks.js';
import { ASSETS, RAW_KEYS, SIM_CLOCK_START, clientKey, hashKey, printKeyTable, wipe } from './seed-lib.js';

const prisma = new PrismaClient();

async function main(): Promise<void> {
  await wipe(prisma);

  await prisma.chainState.create({
    data: { id: 'chain', blockHeight: 1000, simClockMs: SIM_CLOCK_START.toString() },
  });
  for (const asset of ASSETS) await prisma.asset.create({ data: asset });

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

  const originator = await prisma.client.create({
    data: { legalName: 'Aldgate Digital Partners LLP', type: 'INSTITUTION', jurisdiction: 'GB', vaspId: 'vasp-aldgate' },
  });
  await prisma.client.create({
    data: { legalName: 'Foxwhelp Markets OÜ', type: 'INSTITUTION', jurisdiction: 'EE', vaspId: 'vasp-foxwhelp' },
  });
  const individual = await prisma.client.create({
    data: { legalName: 'Ada Quill', type: 'INDIVIDUAL', jurisdiction: 'GB' },
  });
  await prisma.apiKey.create({
    data: { keyHash: hashKey(clientKey(1)), role: 'CLIENT', clientId: originator.id, label: 'client key 1' },
  });
  await prisma.apiKey.create({
    data: { keyHash: hashKey(clientKey(2)), role: 'CLIENT', clientId: individual.id, label: 'client key 2' },
  });

  const account = await prisma.account.create({
    data: {
      clientId: originator.id,
      label: 'Demo trading account',
      segregationModel: 'SEGREGATED',
      wallets: {
        create: [
          { assetSymbol: 'GBPX', segregationModel: 'SEGREGATED', depositAddress: 'vc-gbpx-demo-1' },
          { assetSymbol: 'BTC', segregationModel: 'SEGREGATED', depositAddress: 'vc-btc-demo-1' },
          { assetSymbol: 'ETH', segregationModel: 'SEGREGATED', depositAddress: 'vc-eth-demo-1' },
        ],
      },
      policies: {
        create: [{ assetSymbol: null, thresholdMinor: '100000', approvalsRequired: 2, makerCannotCheck: true }],
      },
    },
    include: { wallets: true },
  });
  const gbpx = account.wallets.find((w) => w.assetSymbol === 'GBPX')!;
  const eth = account.wallets.find((w) => w.assetSymbol === 'ETH')!;

  // Funding: GBPX 10,000.00 / ETH 5.0 — credited deposits with consistent ledgers.
  const fundings = [
    { wallet: gbpx, amount: 1_000_000n, ref: 'demo-fund-gbpx' },
    { wallet: eth, amount: 5_000_000_000_000_000_000n, ref: 'demo-fund-eth' },
  ];
  let fundedDepositId = '';
  for (const f of fundings) {
    const tx = await prisma.transaction.create({
      data: {
        walletId: f.wallet.id, type: 'DEPOSIT', assetSymbol: f.wallet.assetSymbol,
        amountMinor: f.amount.toString(), state: 'CREDITED', chainTxRef: f.ref,
        broadcastBlockHeight: 900, confirmations: 12,
      },
    });
    await prisma.processedEvent.create({ data: { walletId: f.wallet.id, chainTxRef: f.ref } });
    await prisma.ledgerEntry.create({
      data: {
        walletId: f.wallet.id, clientId: originator.id, direction: 'CREDIT',
        amountMinor: f.amount.toString(), kind: 'PRINCIPAL', txId: tx.id,
      },
    });
    await prisma.wallet.update({ where: { id: f.wallet.id }, data: { balanceMinor: f.amount.toString() } });
    await prisma.auditLogEntry.create({
      data: {
        actorApiKeyId: operatorA.id, actorRole: 'OPERATOR', action: 'TRANSACTION_CREDITED',
        entityType: 'Transaction', entityId: tx.id,
        before: JSON.stringify({ state: 'SCREENING' }), after: JSON.stringify({ state: 'CREDITED' }),
      },
    });
    if (f.wallet.assetSymbol === 'GBPX') fundedDepositId = tx.id;
  }

  // Recorded deposit.detected delivery for the funded GBPX deposit (BUG-007 stage).
  const sub = await prisma.webhookSubscription.create({
    data: {
      url: 'https://hooks.client.example/vaultchain',
      secret: 'mock-webhook-secret-0001',
      events: JSON.stringify(['deposit.detected', 'deposit.credited', 'hold.opened', 'hold.released']),
    },
  });
  const detectPayload = JSON.stringify({
    event: 'deposit.detected',
    transactionId: fundedDepositId,
    walletId: gbpx.id,
    chainTxRef: 'demo-fund-gbpx',
    amountMinor: '1000000',
    assetSymbol: 'GBPX',
  });
  await prisma.webhookDelivery.create({
    data: {
      subscriptionId: sub.id, event: 'deposit.detected', payload: detectPayload,
      signature: signPayload('mock-webhook-secret-0001', detectPayload),
      attempts: 1, status: 'DELIVERED', deliveredAt: new Date(),
    },
  });

  // Allowlist: one ACTIVE external address, one still cooling off.
  await prisma.allowlistedAddress.create({
    data: {
      accountId: account.id, assetSymbol: 'GBPX', address: 'vc-ext-gbpx-payout-1',
      addressNorm: 'vc-ext-gbpx-payout-1', label: 'Foxwhelp settlement', addedByApiKeyId: operatorA.id,
      activatesAt: (SIM_CLOCK_START - 1_000n).toString(), status: 'PENDING',
    },
  });
  await prisma.allowlistedAddress.create({
    data: {
      accountId: account.id, assetSymbol: 'GBPX', address: 'vc-ext-gbpx-payout-2',
      addressNorm: 'vc-ext-gbpx-payout-2', label: 'New destination (cooling off)', addedByApiKeyId: operatorA.id,
      activatesAt: (SIM_CLOCK_START + 86_400_000n).toString(), status: 'PENDING',
    },
  });

  // Above-threshold cross-VASP withdrawal, PENDING_APPROVAL, maker = operator A.
  const amount = 150_000n; // 1500.00 GBPX — above the 1000.00 threshold
  const withdrawal = await prisma.transaction.create({
    data: {
      walletId: gbpx.id, type: 'WITHDRAWAL', assetSymbol: 'GBPX',
      amountMinor: amount.toString(), feeMinor: feeFor(amount, WITHDRAWAL_FEE_BPS).toString(),
      state: 'PENDING_APPROVAL', counterpartyAddress: 'vc-ext-gbpx-payout-1',
      counterpartyVaspId: 'vasp-foxwhelp', createdByApiKeyId: operatorA.id,
    },
  });
  await prisma.auditLogEntry.create({
    data: {
      actorApiKeyId: operatorA.id, actorRole: 'OPERATOR', action: 'WITHDRAWAL_CREATED',
      entityType: 'Transaction', entityId: withdrawal.id,
      after: JSON.stringify({ state: 'PENDING_APPROVAL', amountMinor: withdrawal.amountMinor }),
    },
  });

  // An OPEN screening hold on a second inbound deposit (BUG-005/006 stage).
  const heldTx = await prisma.transaction.create({
    data: {
      walletId: gbpx.id, type: 'DEPOSIT', assetSymbol: 'GBPX',
      amountMinor: '300000', state: 'HELD', chainTxRef: 'demo-held-dep',
      broadcastBlockHeight: 995, confirmations: 2,
    },
  });
  const hold = await prisma.complianceHold.create({
    data: { transactionId: heldTx.id, reason: 'SCREENING_FLAG', openedBy: 'system' },
  });
  await prisma.auditLogEntry.create({
    data: {
      actorApiKeyId: null, actorRole: null, action: 'HOLD_OPENED',
      entityType: 'ComplianceHold', entityId: hold.id,
      after: JSON.stringify({ transactionId: heldTx.id, reason: 'SCREENING_FLAG', state: 'OPEN' }),
    },
  });

  console.log('Demo seed complete. Staged state:');
  console.log(`  GBPX wallet          ${gbpx.id} (balance 10000.00)`);
  console.log(`  pending withdrawal   ${withdrawal.id} (1500.00 GBPX, cross-VASP, needs 2 approvals)`);
  console.log(`  open hold            ${hold.id} (on deposit ${heldTx.id})`);
  console.log(`  credited deposit     ${fundedDepositId} (chainTxRef demo-fund-gbpx, delivery recorded)`);
  console.log(`  active allowlist     vc-ext-gbpx-payout-1 | cooling-off: vc-ext-gbpx-payout-2`);
  console.log(`  admin key id         ${admin.id}`);
  printKeyTable(2);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
