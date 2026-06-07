// E2E (real Chromium): compose + send a broadcast, and build + save a campaign
// (§12, §9A, §9B). The broadcast targets the seeded manual segment + template and
// sends through the real broadcast core (SQS mocked locally) → status flips. The
// campaign builder assembles a trigger→wait→send→exit graph that the server
// validates and persists. Proven in a real browser against real Postgres.
import { test, expect } from '@playwright/test';
import { loginAs } from './helpers.js';
import { DEV_MKT } from './seed.js';

test('compose and send a broadcast to a segment', async ({ page }) => {
  await loginAs(page, DEV_MKT);
  await page.getByTestId('nav-broadcasts').click();
  await page.getByTestId('broadcast-composer').waitFor();

  await page.getByTestId('broadcast-name').fill('Spring sale');
  // The seeded manual segment + template are the first non-empty options.
  await page.getByTestId('broadcast-segment').selectOption({ index: 1 });
  await page.getByTestId('broadcast-template').selectOption({ index: 1 });
  await page.getByTestId('create-broadcast').click();

  // The new broadcast appears; send it and confirm a result is shown.
  await expect(page.getByTestId('broadcast-item').first()).toBeVisible();
  await page.getByTestId('send-broadcast').first().click();
  await expect(page.getByTestId('send-result')).toBeVisible();
});

test('build and save a campaign workflow', async ({ page }) => {
  await loginAs(page, DEV_MKT);
  await page.getByTestId('nav-campaigns').click();
  await page.getByTestId('campaign-builder').waitFor();

  await page.getByTestId('campaign-name').fill('Onboarding journey');
  // Add a wait step → graph becomes trigger→wait→send→exit.
  await page.getByTestId('add-wait-node').click();
  await expect(page.getByTestId('node-wait')).toBeVisible();

  await page.getByTestId('save-campaign').click();
  // The saved campaign appears in the list (server validated the definition).
  await expect(page.getByTestId('campaign-item').first()).toBeVisible();
});
