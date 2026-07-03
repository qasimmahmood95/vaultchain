// Shared seed machinery: deterministic RNG, asset definitions, API keys,
// and the wipe. All names are OBVIOUSLY FICTIONAL — nothing here references
// real custody firms or real people (P1 working rule).

import { createHash } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';

/** mulberry32 — tiny deterministic PRNG; same seed, same data, every run. */
export function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function pick<T>(rng: () => number, items: readonly T[]): T {
  const item = items[Math.floor(rng() * items.length)];
  if (item === undefined) throw new Error('pick from empty array');
  return item;
}

export function intBetween(rng: () => number, min: number, max: number): number {
  return min + Math.floor(rng() * (max - min + 1));
}

export const ASSETS = [
  { symbol: 'BTC', name: 'Mock Bitcoin', decimals: 8, chain: 'mockchain', minWithdrawalMinor: '10000', requiredConfirmations: 3 },
  { symbol: 'ETH', name: 'Mock Ether', decimals: 18, chain: 'mockchain', minWithdrawalMinor: '1000000000000000', requiredConfirmations: 12 },
  { symbol: 'GBPX', name: 'Mock GBP Stablecoin', decimals: 2, chain: 'mockchain', minWithdrawalMinor: '100', requiredConfirmations: 1 },
] as const;

/** Raw API keys — printed by the seed, hashed in the DB. Mock platform: not secrets. */
export const RAW_KEYS = {
  admin: 'vck_admin_0000000000000000',
  operatorA: 'vck_operator_a_000000000000',
  operatorB: 'vck_operator_b_000000000000',
  compliance: 'vck_compliance_000000000000',
  clientPrefix: 'vck_client_', // + client index, padded
} as const;

export function hashKey(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

export function clientKey(index: number): string {
  return `${RAW_KEYS.clientPrefix}${String(index).padStart(2, '0')}_0000000000`;
}

/** Delete everything in FK-safe order so seeds are reproducible. */
export async function wipe(prisma: PrismaClient): Promise<void> {
  await prisma.webhookDelivery.deleteMany();
  await prisma.webhookSubscription.deleteMany();
  await prisma.auditLogEntry.deleteMany();
  await prisma.travelRuleRecord.deleteMany();
  await prisma.complianceHold.deleteMany();
  await prisma.approval.deleteMany();
  await prisma.processedEvent.deleteMany();
  await prisma.ledgerEntry.deleteMany();
  await prisma.transaction.deleteMany();
  await prisma.allowlistedAddress.deleteMany();
  await prisma.approvalPolicy.deleteMany();
  await prisma.wallet.deleteMany();
  await prisma.account.deleteMany();
  await prisma.apiKey.deleteMany();
  await prisma.client.deleteMany();
  await prisma.asset.deleteMany();
  await prisma.chainState.deleteMany();
}

/** Obviously fictional clients. Unicode names are deliberate (UI search edge case). */
export const FICTIONAL_CLIENTS = [
  { legalName: 'Aldgate Digital Partners LLP', type: 'INSTITUTION', jurisdiction: 'GB', vaspId: 'vasp-aldgate' },
  { legalName: 'Wren & Hart Capital Ltd', type: 'INSTITUTION', jurisdiction: 'GB', vaspId: 'vasp-wrenhart' },
  { legalName: 'Pemberley Family Office Ltd', type: 'INSTITUTION', jurisdiction: 'GB', vaspId: null },
  { legalName: 'Foxwhelp Markets OÜ', type: 'INSTITUTION', jurisdiction: 'EE', vaspId: 'vasp-foxwhelp' },
  { legalName: 'Kohaku Trading KK (琥珀トレーディング)', type: 'INSTITUTION', jurisdiction: 'JP', vaspId: 'vasp-kohaku' },
  { legalName: 'Ada Quill', type: 'INDIVIDUAL', jurisdiction: 'GB', vaspId: null },
  { legalName: 'Björn Ölandsson', type: 'INDIVIDUAL', jurisdiction: 'SE', vaspId: null },
  { legalName: 'Marisol Quintana-Vega', type: 'INDIVIDUAL', jurisdiction: 'ES', vaspId: null },
] as const;

export const SIM_CLOCK_START = 1_750_000_000_000n;

export function printKeyTable(clientCount: number): void {
  console.log('\n=== API keys (mock — printed on purpose) ===');
  console.log(`  ADMIN               ${RAW_KEYS.admin}`);
  console.log(`  OPERATOR (A)        ${RAW_KEYS.operatorA}`);
  console.log(`  OPERATOR (B)        ${RAW_KEYS.operatorB}`);
  console.log(`  COMPLIANCE_OFFICER  ${RAW_KEYS.compliance}`);
  for (let i = 0; i < clientCount; i += 1) {
    console.log(`  CLIENT #${i + 1}          ${clientKey(i + 1)}`);
  }
  console.log('===========================================\n');
}
