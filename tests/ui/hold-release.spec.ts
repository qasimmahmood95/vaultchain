// UI journey: compliance hold resolution from the transaction detail page
// (PRD §A.5 screen 4). The FLAG is queued via the simulator; the browser does
// what a compliance officer does: open the detail, read the hold, release it.
//
// Serialized ui project: the screening queue is race-free here. Audit entries
// for HOLD resolution are NOT asserted (P4 territory) — the timeline shown is
// the TRANSACTION's audit trail.

import { test, expect, ApiClient, UI_STATE } from '../fixtures/index.js';

test.use({ storageState: UI_STATE.compliance });

test('a flagged deposit is HELD; compliance releases it from the detail page and it credits', async ({
  page,
  browser,
  asOperatorA,
  build,
  chain,
}) => {
  const operator = new ApiClient(asOperatorA);
  const account = await build.account({ assets: ['GBPX'] });
  const wallet = account.wallets[0]!;

  // Flush pending settlements so the queued FLAG hits OUR deposit's screening.
  await chain.advanceBlocks(12);
  await chain.queueScreening('FLAG');
  const dep = await operator.post<{ id: string }>(`/wallets/${wallet.id}/deposits/simulate`, {
    amount: '2500.00',
    chainTxRef: build.uniqueRef('ui-flag'),
  });
  await chain.advanceBlocks(1);

  // An OPERATOR sees the hold but no resolve controls (segregation of duties).
  const operatorContext = await browser.newContext({ storageState: UI_STATE.operatorB });
  const operatorPage = await operatorContext.newPage();
  await operatorPage.goto(`/ui/transactions/${dep.json.id}`);
  await expect(operatorPage.getByTestId('tx-state')).toHaveText('HELD');
  await expect(operatorPage.getByTestId('hold-open')).toBeVisible();
  await expect(operatorPage.getByTestId('hold-release')).toHaveCount(0);
  await expect(operatorPage.getByTestId('hold-no-resolve')).toBeVisible();
  await operatorContext.close();

  // The COMPLIANCE OFFICER releases it from the same screen.
  await page.goto(`/ui/transactions/${dep.json.id}`);
  await expect(page.getByTestId('tx-state')).toHaveText('HELD');
  await page.getByTestId('hold-release').click();
  await expect(page.getByTestId('flash')).toContainText('Hold released');
  await expect(page.getByTestId('tx-state')).toHaveText('CREDITED');
  await expect(
    page.getByTestId('timeline-action').filter({ hasText: 'TRANSACTION_CREDITED' }),
  ).toBeVisible();
});
