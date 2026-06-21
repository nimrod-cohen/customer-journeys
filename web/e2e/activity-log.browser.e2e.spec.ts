// E2E (real Chromium): the Activity log unifies events + email + sends, and the
// filters (source, outcome) narrow the feed server-side.
import { test, expect } from '@playwright/test';
import { loginAs } from './helpers.js';
import { DEV_MKT } from './seed.js';

test('activity log shows merged activity and filters by outcome', async ({ page }) => {
  await loginAs(page, DEV_MKT);
  await page.getByTestId('nav-activity').click();
  await page.getByTestId('activity').waitFor();

  // Seeded for a1: 2 events + delivery + bounce + send = 5 rows.
  await expect(page.getByTestId('activity-row')).toHaveCount(5);

  // Filter to failures → only the bounce.
  await page.getByTestId('activity-outcome').selectOption('failure');
  await page.getByTestId('activity-apply').click();
  await expect(page.getByTestId('activity-row')).toHaveCount(1);
  await expect(page.getByTestId('activity-row').first()).toContainText('bounce');

  // Filter to the email source → delivery + bounce.
  await page.getByTestId('activity-reset').click();
  await page.getByTestId('activity-source').selectOption('email');
  await page.getByTestId('activity-apply').click();
  await expect(page.getByTestId('activity-row')).toHaveCount(2);
});

test('master/detail: a row expands its detail below; the profile link opens the profile', async ({ page }) => {
  await loginAs(page, DEV_MKT);
  await page.getByTestId('nav-activity').click();
  await page.getByTestId('activity').waitFor();

  // Events carry payload detail — filter to them so a row is expandable.
  await page.getByTestId('activity-source').selectOption('event');
  await page.getByTestId('activity-apply').click();

  // No detail row until a row is clicked; clicking expands a detail row below with
  // a pretty JSON block (not inside the column).
  await expect(page.getByTestId('activity-detail-row')).toHaveCount(0);
  await page.getByTestId('activity-expand').first().click();
  await expect(page.getByTestId('activity-detail-row').first()).toBeVisible();
  await expect(page.getByTestId('activity-detail-row').first().getByTestId('json-view')).toBeVisible();

  // The profile cell is a link straight to that profile.
  await page.getByTestId('activity-profile-link').first().click();
  await page.getByTestId('profile-detail').waitFor();
});
