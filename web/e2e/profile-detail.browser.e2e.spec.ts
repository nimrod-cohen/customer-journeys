// E2E (real Chromium): the Profile detail workspace (§12). A marketer opens a
// profile, edits its status, adds an attribute, and reads its event history and
// segment memberships — exercising the four endpoints end-to-end through the SPA.
import { test, expect } from '@playwright/test';
import { loginAs } from './helpers.js';
import { DEV_MKT } from './seed.js';

test('open a profile, edit it, add an attribute, view events and segments', async ({ page }) => {
  await loginAs(page, DEV_MKT);

  // Go to Profiles and open the seeded profile a1 (has events + a membership).
  await page.getByTestId('nav-profiles').click();
  await page.getByTestId('profile-explorer').waitFor();
  await page.getByTestId('profile-search').fill('a1@acme.com');
  await page.getByTestId('profile-row').first().click();

  // Detail header resolves the right profile.
  await page.getByTestId('profile-detail').waitFor();
  await expect(page.getByTestId('profile-email')).toContainText('a1@acme.com');

  // Details tab: change the email status and save.
  await page.getByTestId('tab-details').click();
  await page.getByTestId('profile-status-select').selectOption('unsubscribed');
  await page.getByTestId('profile-save').click();
  await expect(page.getByTestId('profile-save-status')).toContainText('Saved');

  // Attributes tab: add a new key/value and save.
  await page.getByTestId('tab-attributes').click();
  await page.getByTestId('attr-add').click();
  await page.getByTestId('attr-key').last().fill('plan');
  await page.getByTestId('attr-value').last().fill('pro');
  await page.getByTestId('attrs-save').click();
  await expect(page.getByTestId('attrs-save-status')).toContainText('Saved');

  // Events tab: the seeded history shows newest-first.
  await page.getByTestId('tab-events').click();
  await expect(page.getByTestId('event-row')).toHaveCount(2);
  await expect(page.getByTestId('event-row').first()).toContainText('purchase');

  // Segments tab: the manual VIPs membership is listed.
  await page.getByTestId('tab-segments').click();
  await expect(page.getByTestId('profile-segment-row')).toContainText('Manual VIPs');
});
