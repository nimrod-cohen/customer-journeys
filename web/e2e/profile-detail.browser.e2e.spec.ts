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

  // Details tab: change the email (deliverability) status and save.
  await page.getByTestId('tab-details').click();
  await page.getByTestId('profile-status-select').selectOption('bounced');
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

test('filter the profiles list by manual and dynamic segments', async ({ page }) => {
  await loginAs(page, DEV_MKT);
  await page.getByTestId('nav-profiles').click();
  await page.getByTestId('profile-explorer').waitFor();

  // All three seeded A profiles are listed unfiltered.
  await expect(page.getByTestId('profile-row')).toHaveCount(3);
  // a3 is unsubscribed → exactly one unsubscribed marker in the table.
  await expect(page.getByTestId('profile-unsub')).toHaveCount(1);

  // MANUAL segment: uses materialized membership rows — a1 is the only member.
  await page.getByTestId('profile-segment-filter').selectOption({ label: 'Manual VIPs' });
  await expect(page.getByTestId('profile-row')).toHaveCount(1);
  await expect(page.getByTestId('profile-row').first()).toContainText('a1@acme.com');

  // DYNAMIC segment: live-evaluates the rule (attributes.tier = vip) with NO
  // materialized memberships — the two VIP profiles match.
  await page.getByTestId('profile-segment-filter').selectOption({ label: 'VIP (dynamic)' });
  await expect(page.getByTestId('profile-row')).toHaveCount(2);
  await expect(page.getByTestId('profile-explorer')).toContainText('a1@acme.com');
  await expect(page.getByTestId('profile-explorer')).toContainText('a2@acme.com');

  // Clearing the filter restores the full list.
  await page.getByTestId('profile-segment-filter').selectOption({ label: 'All segments' });
  await expect(page.getByTestId('profile-row')).toHaveCount(3);
});

test('manually add a profile and land on its detail page', async ({ page }) => {
  await loginAs(page, DEV_MKT);
  await page.getByTestId('nav-profiles').click();
  await page.getByTestId('profile-explorer').waitFor();

  await page.getByTestId('new-profile').click();
  await page.getByTestId('new-profile-external').fill('walk-in-1');
  await page.getByTestId('new-profile-email').fill('walkin@acme.com');
  await page.getByTestId('create-profile').click();

  // Lands on the new profile's detail page.
  await page.getByTestId('profile-detail').waitFor();
  await expect(page.getByTestId('profile-email')).toContainText('walkin@acme.com');
});
