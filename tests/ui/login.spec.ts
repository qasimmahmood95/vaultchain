// UI journey: login (PRD §B.3 — one of the flows that MUST be a browser).
// No storageState here: the form interaction IS the test. Other journeys
// reuse the setup project's saved sessions instead of re-logging in.

import { test, expect } from '../fixtures/index.js';
import { RAW_KEYS } from '../../scripts/seed-lib.js';

test('an unknown API key is rejected with a visible error', async ({ page }) => {
  await page.goto('/ui/login');
  await page.getByTestId('login-key').fill('not-a-real-key');
  await page.getByTestId('login-submit').click();
  await expect(page.getByTestId('login-error')).toContainText('Unknown or inactive');
});

test('a valid operator key lands on the approval queue with the role shown', async ({ page }) => {
  await page.goto('/ui/login');
  await page.getByTestId('login-key').fill(RAW_KEYS.operatorB);
  await page.getByTestId('login-submit').click();
  await expect(page).toHaveURL(/\/ui\/queue/);
  await expect(page.getByTestId('page-queue')).toBeVisible();
  await expect(page.getByTestId('nav-role')).toContainText('OPERATOR');
});

test('an unauthenticated deep link redirects to login', async ({ page }) => {
  await page.goto('/ui/transactions');
  await expect(page).toHaveURL(/\/ui\/login/);
  await expect(page.getByTestId('page-login')).toBeVisible();
});
