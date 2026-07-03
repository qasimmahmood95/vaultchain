// Address allowlisting with a cooling-off window (PRD §A.1). Activation is
// measured on the SIM CLOCK — the same clock as every other time comparison
// in the domain — so tests cross the boundary via /simulator, never by waiting.

import type { AllowlistedAddress } from '@prisma/client';
import { COOLING_OFF_MS, type Actor } from '../config.js';
import type { Db } from '../db.js';
import { writeAudit } from './audit.js';
import { simNow } from './clock.js';

/** Comparison form: ETH lowercased, others trimmed (DECISIONS.md D12). */
export function normalizeAddress(assetSymbol: string, address: string): string {
  const trimmed = address.trim();
  return assetSymbol === 'ETH' ? trimmed.toLowerCase() : trimmed;
}

export async function addAllowlistedAddress(
  db: Db,
  input: { accountId: string; assetSymbol: string; address: string; label: string; actor: Actor },
): Promise<AllowlistedAddress> {
  const activatesAt = (await simNow(db)) + COOLING_OFF_MS;
  const entry = await db.allowlistedAddress.create({
    data: {
      accountId: input.accountId,
      assetSymbol: input.assetSymbol,
      address: input.address.trim(),
      addressNorm: normalizeAddress(input.assetSymbol, input.address),
      label: input.label,
      addedByApiKeyId: input.actor.apiKeyId,
      activatesAt: activatesAt.toString(),
      status: 'PENDING',
    },
  });
  await writeAudit(db, {
    actor: input.actor,
    action: 'ALLOWLIST_ADDRESS_ADDED',
    entityType: 'AllowlistedAddress',
    entityId: entry.id,
    after: { address: entry.address, assetSymbol: entry.assetSymbol, activatesAt: entry.activatesAt },
  });
  return entry;
}

/**
 * An entry is withdrawable only at/after activatesAt, measured on the sim
 * clock, and only while not removed.
 */
export async function isActive(db: Db, entry: AllowlistedAddress): Promise<boolean> {
  if (entry.status === 'REMOVED') return false;
  const now = await simNow(db);
  return now >= BigInt(entry.activatesAt);
}

/** Find the allowlist entry matching a withdrawal target, if any. */
export async function findEntry(
  db: Db,
  accountId: string,
  assetSymbol: string,
  address: string,
): Promise<AllowlistedAddress | null> {
  return db.allowlistedAddress.findFirst({
    where: {
      accountId,
      assetSymbol,
      addressNorm: normalizeAddress(assetSymbol, address),
      status: { not: 'REMOVED' },
    },
  });
}

export async function removeEntry(db: Db, entry: AllowlistedAddress, actor: Actor): Promise<void> {
  await db.allowlistedAddress.update({ where: { id: entry.id }, data: { status: 'REMOVED' } });
  await writeAudit(db, {
    actor,
    action: 'ALLOWLIST_ADDRESS_REMOVED',
    entityType: 'AllowlistedAddress',
    entityId: entry.id,
    before: { status: entry.status },
    after: { status: 'REMOVED' },
  });
}
