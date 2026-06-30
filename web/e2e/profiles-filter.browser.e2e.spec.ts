// E2E (real Chromium): on-the-fly profile filtering in the Profiles screen using the SAME
// segment RuleBuilder. An ad-hoc attribute rule (tier = vip) filters the list server-side
// (POST /profiles/query, workspace_id = $1) and shows a live "N matching" count; Clear
// restores the full list. Real Postgres (cdp_e2e); two seeded VIPs in WS_A.
import { test, expect } from '@playwright/test';
import { loginAs } from './helpers.js';
import { DEV_MKT } from './seed.js';

test('filter profiles on the fly with an ad-hoc rule, then clear', async ({ page }) => {
  await loginAs(page, DEV_MKT);
  await page.getByTestId('nav-profiles').click();
  await page.getByTestId('profile-explorer').waitFor();
  // Wait for the initial (unfiltered) list to render.
  await expect(page.getByTestId('profile-row').first()).toBeVisible();
  const total = await page.getByTestId('profile-row').count();
  expect(total).toBeGreaterThan(2); // seed has non-VIP profiles too (std/free/…)

  // Open the advanced filter and build "attributes.tier = vip".
  await page.getByTestId('profile-filter-toggle').click();
  const panel = page.getByTestId('profile-filter-panel');
  await panel.waitFor();
  await panel.getByTestId('rule-field').first().fill('attributes.tier');
  await panel.getByTestId('rule-operator').first().selectOption('=');
  await panel.getByTestId('rule-value').first().fill('vip');

  // The live count shows the matching total (2 seeded VIPs) and the table narrows.
  await expect(page.getByTestId('profile-filter-count')).toContainText(/matching profile/, { timeout: 10_000 });
  await expect.poll(async () => page.getByTestId('profile-row').count(), { timeout: 10_000 }).toBe(2);
  expect(await page.getByTestId('profile-row').count()).toBeLessThan(total);

  // The segment dropdown is disabled while the advanced filter is active.
  await expect(page.getByTestId('profile-segment-filter')).toBeDisabled();

  // Clear → the full list returns.
  await page.getByTestId('profile-filter-clear').click();
  await expect.poll(async () => page.getByTestId('profile-row').count(), { timeout: 10_000 }).toBe(total);
  await expect(page.getByTestId('profile-segment-filter')).toBeEnabled();
});
