// Contract: cursor pagination on OWN data only (fixtures README rule — the DB
// accumulates across runs, so global counts are never asserted). Five own
// withdrawals are paged with limit=2 to exhaustion: every created id appears
// exactly once, and nextCursor is null on the final page.

import { test, ApiClient, type ApiResult } from '../fixtures/index.js';
import { expect } from './support/matchers.js';
import { createWithdrawal } from './support/robust.js';
import { page, TransactionSchema } from './schemas/index.js';

const CREATED_COUNT = 5;
const PAGE_LIMIT = 2;

interface WithdrawalPage {
  items: Array<{ id: string }>;
  nextCursor: string | null;
}

test('GET /withdrawals?walletId=&limit=2 pages own data to exhaustion without dupes or drops', async ({
  asOperatorA,
  build,
  chain,
}) => {
  // 5 x (1500.00 + 1.50 fee) = 7507.50 <= the default 10000.00 funding.
  const funded = await build.fundedWallet();
  const addr = await build.activeAddress({ accountId: funded.accountId, asset: 'GBPX' });

  const createdIds: string[] = [];
  for (let i = 0; i < CREATED_COUNT; i += 1) {
    const wd = await createWithdrawal(build, chain, {
      walletId: funded.walletId,
      amount: '1500.00',
      address: addr.address,
    }, addr.activatesAt);
    createdIds.push(wd.id);
  }

  const api = new ApiClient(asOperatorA);
  const seen: string[] = [];
  let cursor: string | null = null;
  let pages = 0;
  const maxPages = Math.ceil(CREATED_COUNT / PAGE_LIMIT) + 2; // hard stop against cursor loops

  do {
    const params = new URLSearchParams({ walletId: funded.walletId, limit: String(PAGE_LIMIT) });
    if (cursor !== null) params.set('cursor', cursor);
    const res: ApiResult<WithdrawalPage> = await api.get<WithdrawalPage>(
      `/withdrawals?${params.toString()}`,
    );
    expect(res.status).toBe(200);
    expect(res.json).toMatchSchema(page(TransactionSchema));
    expect(res.json.items.length, 'a page never exceeds its limit').toBeLessThanOrEqual(PAGE_LIMIT);
    seen.push(...res.json.items.map((i) => i.id));
    cursor = res.json.nextCursor;
    pages += 1;
    expect(pages, 'cursor chain must terminate').toBeLessThanOrEqual(maxPages);
  } while (cursor !== null); // nextCursor is null exactly on the last page

  // Every created id appears EXACTLY once across the pages (no dupes, no drops).
  expect(seen).toHaveLength(CREATED_COUNT);
  expect(new Set(seen).size, 'no duplicate ids across pages').toBe(CREATED_COUNT);
  expect([...seen].sort()).toEqual([...createdIds].sort());
});
