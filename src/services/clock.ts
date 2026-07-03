// The fake-chain clock (PRD §A.7). Domain logic never reads Date.now();
// all time comparisons go through simNow(), backed by ChainState.simClockMs.

import type { ChainState } from '@prisma/client';
import type { Db } from '../db.js';

const CHAIN_ID = 'chain';

/** Fetch (creating on first use) the single-row chain control plane. */
export async function getChain(db: Db): Promise<ChainState> {
  const existing = await db.chainState.findUnique({ where: { id: CHAIN_ID } });
  if (existing) return existing;
  return db.chainState.create({ data: { id: CHAIN_ID } });
}

/** Current simulated time in ms. The only clock the domain is allowed to use. */
export async function simNow(db: Db): Promise<bigint> {
  const chain = await getChain(db);
  return BigInt(chain.simClockMs);
}
