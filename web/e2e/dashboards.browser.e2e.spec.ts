// E2E (real Chromium): the Dashboards delivery-health section (§10). The seeded
// email events are months old (outside the 30-day window) so outcomes read 0 and
// reputation is healthy; the seeded a3 unsubscribe shows on the suppression list.
// (Delivered/bounced populate in a deployed SES-feedback pipeline, not local dev.)
import { test, expect } from '@playwright/test';
import { loginAs } from './helpers.js';
import { DEV_MKT } from './seed.js';

test('dashboard shows workspace delivery-health (outcomes, reputation, suppression)', async ({ page }) => {
  await loginAs(page, DEV_MKT);
  await page.getByTestId('nav-dashboards').click();
  await page.getByTestId('dashboards').waitFor();

  const dh = page.getByTestId('delivery-health');
  await dh.waitFor();
  await expect(dh).toContainText('last 30 days');

  // Outcomes: the seeded events are older than the window → all zero locally.
  await expect(page.getByTestId('dh-sent')).toHaveText('0');
  await expect(page.getByTestId('dh-delivered')).toHaveText('0');

  // Reputation: zero bounces/complaints → healthy, no warning banner.
  await expect(page.getByTestId('dh-bounce-rate')).toHaveText('0.00%');
  await expect(page.getByTestId('dh-reputation-warning')).toHaveCount(0);

  // Suppression list (not windowed): the seeded a3 unsubscribe shows.
  await expect(page.getByTestId('dh-suppressed-total')).toHaveText('1');
  await expect(page.getByTestId('dh-supp-unsubscribe')).toHaveText('1');

  // The sends-per-day trend sparkline renders.
  await expect(page.getByTestId('dh-trend')).toBeVisible();
});
