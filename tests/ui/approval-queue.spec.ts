// UI journey: dual approval from the queue (PRD §A.5 — THE screen that must
// be UI). State is API-seeded via the builders; the browser only does what a
// checker actually does: find the row, click, read the outcome.

import { test, expect, UI_STATE } from '../fixtures/index.js';

test.use({ storageState: UI_STATE.operatorB });

test('checker approves from the queue; maker is refused; second checker completes it', async ({
  page,
  browser,
  build,
}) => {
  // API-first seeding: funded wallet, active address, pending withdrawal
  // (maker = operator A). Fee-exact 1500.00, domestic -> no travel rule.
  const funded = await build.fundedWallet({ asset: 'GBPX', amount: '10000.00' });
  const dest = await build.activeAddress({ accountId: funded.accountId, asset: 'GBPX' });
  const wd = await build.withdrawal({ walletId: funded.walletId, amount: '1500.00', address: dest.address });

  // Checker (operator B) sees the row and approves: 1 of 2 -> still pending.
  await page.goto(`/ui/queue?walletId=${funded.walletId}`);
  await expect(page.getByTestId(`queue-row-${wd.id}`)).toBeVisible();
  await page.getByTestId(`approve-${wd.id}`).click();
  await expect(page.getByTestId('flash')).toContainText('Approval recorded');
  await expect(page.getByTestId(`queue-row-${wd.id}`), 'one approval of two: still queued').toBeVisible();

  // The MAKER (operator A) tries to check its own withdrawal: refused, on-screen.
  const makerContext = await browser.newContext({ storageState: UI_STATE.operatorA });
  const makerPage = await makerContext.newPage();
  await makerPage.goto(`/ui/queue?walletId=${funded.walletId}`);
  await makerPage.getByTestId(`approve-${wd.id}`).click();
  await expect(makerPage.getByTestId('flash')).toContainText('Maker cannot check');
  await makerContext.close();

  // A second DISTINCT checker (admin) completes the approval: row leaves the queue.
  const adminContext = await browser.newContext({ storageState: UI_STATE.admin });
  const adminPage = await adminContext.newPage();
  await adminPage.goto(`/ui/queue?walletId=${funded.walletId}`);
  await adminPage.getByTestId(`approve-${wd.id}`).click();
  await expect(adminPage.getByTestId('flash')).toContainText('recorded');
  await expect(adminPage.getByTestId(`queue-row-${wd.id}`)).toHaveCount(0);
  await adminContext.close();

  // Detail shows the progressed state (domestic: broadcast path, no travel rule).
  await page.goto(`/ui/transactions/${wd.id}`);
  await expect(page.getByTestId('tx-state')).toHaveText('PENDING_CONFIRMATION');
  await expect(page.getByTestId('travel-rule-count')).toContainText('0 record');
});

test('a malformed decision is rejected 400 and never defaults to approve (D27)', async ({ page, build }) => {
  const funded = await build.fundedWallet({ asset: 'GBPX', amount: '4000.00' });
  const dest = await build.activeAddress({ accountId: funded.accountId, asset: 'GBPX' });
  const wd = await build.withdrawal({ walletId: funded.walletId, amount: '1500.00', address: dest.address });

  // Direct form post with a decision the buttons never send (tampering).
  const res = await page.request.post(`/ui/queue/${wd.id}/decision`, {
    form: { decision: 'MAYBE', walletId: funded.walletId },
  });
  expect(res.status(), 'unknown decision must be 400, not a silent approve').toBe(400);

  // The withdrawal is untouched — still awaiting approval.
  await page.goto(`/ui/transactions/${wd.id}`);
  await expect(page.getByTestId('tx-state')).toHaveText('PENDING_APPROVAL');
  await expect(page.getByTestId('approvals-empty')).toBeVisible();
});

test('rejecting from the queue terminates the withdrawal', async ({ page, build }) => {
  const funded = await build.fundedWallet({ asset: 'GBPX', amount: '4000.00' });
  const dest = await build.activeAddress({ accountId: funded.accountId, asset: 'GBPX' });
  const wd = await build.withdrawal({ walletId: funded.walletId, amount: '1500.00', address: dest.address });

  await page.goto(`/ui/queue?walletId=${funded.walletId}`);
  await page.getByTestId(`reject-${wd.id}`).click();
  await expect(page.getByTestId('flash')).toContainText('REJECTED');
  await expect(page.getByTestId(`queue-row-${wd.id}`)).toHaveCount(0);

  await page.goto(`/ui/transactions/${wd.id}`);
  await expect(page.getByTestId('tx-state')).toHaveText('REJECTED');
});
