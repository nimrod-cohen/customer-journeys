// E2E (real Chromium): build a dynamic segment with a LIVE size preview (§12).
// The marketer enters a rule (attributes.tier = vip), previews the size (must be
// 2 — the two seeded VIPs in WS_A, never WS_B's profile), and saves it. Proves
// the builder → API → §8 compiler → real Postgres path in a browser.
import { test, expect } from '@playwright/test';
import { loginAs } from './helpers.js';
import { USER_MKT } from './seed.js';

test('build a dynamic segment and see a live size preview', async ({ page }) => {
  await loginAs(page, USER_MKT);
  await page.getByTestId('nav-segments').click();
  await page.getByTestId('segment-builder').waitFor();

  await page.getByTestId('segment-name').fill('VIP members');
  // The first rule row: attributes.tier = vip.
  await page.getByTestId('rule-field').first().fill('attributes.tier');
  await page.getByTestId('rule-operator').first().selectOption('=');
  await page.getByTestId('rule-value').first().fill('vip');

  await page.getByTestId('preview-size').click();
  // Two seeded VIPs in WS_A; WS_B's VIP-less profile is excluded by scoping.
  // (Copy-resilient: the preview element shows the matched count "2".)
  await expect(page.getByTestId('segment-size')).toContainText('2');

  await page.getByTestId('save-segment').click();
  await expect(page.getByTestId('segment-saved')).toBeVisible();
});
