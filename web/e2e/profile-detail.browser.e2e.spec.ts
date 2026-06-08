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

test('configure profile table columns: add an attribute column, toggle external_id', async ({ page }) => {
  await loginAs(page, DEV_MKT);
  await page.getByTestId('nav-profiles').click();
  await page.getByTestId('profile-explorer').waitFor();

  // External ID column is shown by default; no attribute columns yet.
  await expect(page.getByTestId('extid-col-header')).toBeVisible();
  await expect(page.getByTestId('attr-col-header')).toHaveCount(0);

  // Open the column picker and add the `tier` attribute as a column.
  await page.getByTestId('columns-button').click();
  await page.getByTestId('columns-menu').waitFor();
  await page.getByTestId('columns-search').fill('tier');
  await page.locator('[data-testid="col-option"][data-col="tier"] input[type="checkbox"]').check();
  // The new column appears with the seeded values (a1/a2 are 'vip').
  await expect(page.getByTestId('attr-col-header')).toHaveCount(1);
  await expect(page.getByTestId('attr-col-header').first()).toHaveText('tier');
  // The tier column renders the seeded values (a1/a2 are 'vip').
  await expect(page.getByTestId('attr-col-cell').filter({ hasText: 'vip' }).first()).toBeVisible();

  // Hide the External ID column.
  await page.getByTestId('col-external_id').uncheck();
  await expect(page.getByTestId('extid-col-header')).toHaveCount(0);
});

test('manually add a profile (with attributes) via the drawer', async ({ page }) => {
  await loginAs(page, DEV_MKT);
  await page.getByTestId('nav-profiles').click();
  await page.getByTestId('profile-explorer').waitFor();

  // Open the sliding drawer and fill the email (identity key) + an attribute.
  await page.getByTestId('new-profile').click();
  await page.getByTestId('new-profile-drawer').waitFor();
  await page.getByTestId('new-profile-email').fill('walkin@acme.com');
  await page.getByTestId('new-attr-add').click();
  await page.getByTestId('new-attr-key').fill('walksource'); // a brand-new attribute key
  await page.getByTestId('new-attr-value').fill('storefront');
  await page.getByTestId('create-profile').click();

  // The drawer closes and we STAY on the list, where the new profile now appears.
  await expect(page.getByTestId('new-profile-drawer')).toHaveCount(0);

  // The column picker is reactive: the new attribute key is now selectable.
  await page.getByTestId('columns-button').click();
  await expect(page.locator('[data-testid="col-option"][data-col="walksource"]')).toHaveCount(1);
  await page.getByTestId('columns-backdrop').click(); // close the menu

  await page.getByTestId('profile-search').fill('walkin@acme.com');
  await expect(page.getByTestId('profile-row')).toHaveCount(1);

  // Open it to confirm the email + attribute were persisted.
  await page.getByTestId('profile-row').first().click();
  await page.getByTestId('profile-detail').waitFor();
  await expect(page.getByTestId('profile-email')).toContainText('walkin@acme.com');
  await page.getByTestId('tab-attributes').click();
  await expect(page.getByTestId('attr-key').first()).toHaveValue('walksource');
  await expect(page.getByTestId('attr-value').first()).toHaveValue('storefront');
});

test('merge a secondary profile into the lead (survivor remains, secondary deleted)', async ({ page }) => {
  await loginAs(page, DEV_MKT);
  await page.getByTestId('nav-profiles').click();
  await page.getByTestId('profile-explorer').waitFor();

  // Open the lead (a1) and start a merge with a2.
  await page.getByTestId('profile-search').fill('a1@acme.com');
  await page.getByTestId('profile-row').first().click();
  await page.getByTestId('profile-detail').waitFor();
  await page.getByTestId('merge-button').click();
  await page.getByTestId('merge-drawer').waitFor();
  await page.getByTestId('merge-secondary-select').selectOption({ label: 'a2@acme.com' });
  await page.getByTestId('merge-confirm').click();

  // The survivor (a1) remains; the drawer closes.
  await expect(page.getByTestId('merge-drawer')).toHaveCount(0);
  await expect(page.getByTestId('profile-email')).toContainText('a1@acme.com');

  // The secondary (a2) is gone from the list.
  await page.getByTestId('profile-back').click();
  await page.getByTestId('profile-search').fill('a2@acme.com');
  await expect(page.getByTestId('profile-row')).toHaveCount(0);
});
