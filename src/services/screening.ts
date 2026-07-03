// Transaction screening (PRD §A.3): default CLEAN; the simulator can queue
// the next decision (consumed exactly once) via /simulator/screening/next.

import type { Db } from '../db.js';
import { getChain } from './clock.js';

export type ScreeningOutcome = 'CLEAN' | 'FLAG';

export async function nextScreeningOutcome(db: Db): Promise<ScreeningOutcome> {
  const chain = await getChain(db);
  if (chain.screeningNext === 'FLAG' || chain.screeningNext === 'CLEAN') {
    await db.chainState.update({ where: { id: chain.id }, data: { screeningNext: null } });
    return chain.screeningNext;
  }
  return 'CLEAN';
}
