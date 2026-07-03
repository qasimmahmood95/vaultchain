// Reconciliation invariant check (PRD §A.1): for every wallet,
// sum(ledger CREDIT) - sum(ledger DEBIT) must equal wallet.balanceMinor.
// Exits non-zero on any mismatch. Used by the smoke evidence and by the
// defect-branch repro for the rounding defect.

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main(): Promise<void> {
  const wallets = await prisma.wallet.findMany();
  let mismatches = 0;
  for (const wallet of wallets) {
    const rows = await prisma.ledgerEntry.findMany({ where: { walletId: wallet.id } });
    const ledgerSum = rows.reduce(
      (acc, r) => acc + (r.direction === 'CREDIT' ? BigInt(r.amountMinor) : -BigInt(r.amountMinor)),
      0n,
    );
    if (ledgerSum !== BigInt(wallet.balanceMinor)) {
      mismatches += 1;
      console.log(
        `MISMATCH wallet=${wallet.id} asset=${wallet.assetSymbol} ledger=${ledgerSum} balance=${wallet.balanceMinor} drift=${ledgerSum - BigInt(wallet.balanceMinor)}`,
      );
    }
  }
  if (mismatches === 0) {
    console.log(`RECONCILIATION OK: invariant holds across ${wallets.length} wallets`);
  } else {
    console.log(`RECONCILIATION FAILED: ${mismatches}/${wallets.length} wallets drifted`);
    process.exitCode = 1;
  }
  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
