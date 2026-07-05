// UI journey: transaction search (PRD §A.5). API-seeded data; the browser
// exercises the filter form, result rows, and the click-through to detail.

import { test, expect, UI_STATE } from '../fixtures/index.js';

test.use({ storageState: UI_STATE.compliance });

test('search narrows by wallet + state and clicks through to the timeline', async ({ page, build }) => {
  const funded = await build.fundedWallet({ asset: 'GBPX', amount: '5000.00' });
  const dest = await build.activeAddress({ accountId: funded.accountId, asset: 'GBPX' });
  const wd = await build.withdrawal({ walletId: funded.walletId, amount: '1500.00', address: dest.address });

  await page.goto('/ui/transactions');
  await page.getByTestId('search-wallet').fill(funded.walletId);
  await page.getByTestId('search-state').selectOption('PENDING_APPROVAL');
  await page.getByTestId('search-submit').click();

  await expect(page.getByTestId(`tx-row-${wd.id}`)).toBeVisible();
  // The funding DEPOSIT on the same wallet must be filtered OUT by state.
  await expect(page.getByTestId(`tx-row-${funded.depositTxId}`)).toHaveCount(0);

  // Non-matching state: empty result set, stated visibly.
  await page.getByTestId('search-state').selectOption('CONFIRMED');
  await page.getByTestId('search-submit').click();
  await expect(page.getByTestId('search-empty')).toBeVisible();

  // Click through to the detail timeline.
  await page.getByTestId('search-state').selectOption('PENDING_APPROVAL');
  await page.getByTestId('search-submit').click();
  await page.getByTestId(`tx-link-${wd.id}`).click();
  await expect(page.getByTestId('page-detail')).toBeVisible();
  await expect(page.getByTestId('tx-state')).toHaveText('PENDING_APPROVAL');
  await expect(page.getByTestId('tx-fee')).toHaveText('1.50');
  await expect(page.getByTestId('approvals-empty')).toBeVisible();
  await expect(
    page.getByTestId('timeline-action').filter({ hasText: 'WITHDRAWAL_CREATED' }),
  ).toBeVisible();
});
