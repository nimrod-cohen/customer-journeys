// E2E (real Chromium): Campaigns is a LIST page (like Broadcasts) and the canvas
// builder lives at a SEPARATE /campaigns/:id route (§9B phase 7). There is NO
// top-level "Design email" affordance on the list — email design lives ONLY inside
// a send node's editor. Proven against real Postgres (cdp_e2e) with the seeded
// "Welcome journey" campaign.
import { test, expect } from '@playwright/test';
import { loginAs } from './helpers.js';
import { DEV_MKT, CAMP_A } from './seed.js';

test('the campaigns route is a LIST (not the canvas) with no Design email button', async ({ page }) => {
  await loginAs(page, DEV_MKT);
  await page.getByTestId('nav-campaigns').click();

  // The LIST screen renders, NOT the canvas builder.
  await page.getByTestId('campaigns-list-screen').waitFor();
  await expect(page.getByTestId('campaign-canvas')).toHaveCount(0);
  await expect(page.getByTestId('campaign-builder')).toHaveCount(0);

  // No top-level Design email button on the list (the removed PageHeader affordance).
  await expect(page.getByTestId('design-email')).toHaveCount(0);
});

test('New campaign navigates to a SEPARATE detail route with the canvas', async ({ page }) => {
  await loginAs(page, DEV_MKT);
  await page.getByTestId('nav-campaigns').click();
  await page.getByTestId('campaigns-list-screen').waitFor();

  await page.getByTestId('campaign-new').click();
  // The builder is NOT the top-level page — the URL is a separate detail route.
  await expect(page).toHaveURL(/#\/campaigns\/(new|[0-9a-f-]{36})$/);
  await page.getByTestId('campaign-canvas').waitFor();
  await expect(page.getByTestId('campaign-builder')).toBeVisible();
});

test('opening the seeded row navigates to /campaigns/:id and reconstructs the DSL', async ({ page }) => {
  await loginAs(page, DEV_MKT);
  await page.getByTestId('nav-campaigns').click();
  await page.getByTestId('campaigns-list-screen').waitFor();

  await page.getByTestId('campaign-item').filter({ hasText: 'Welcome journey' }).getByTestId('campaign-open').click();
  await expect(page).toHaveURL(new RegExp(`#/campaigns/${CAMP_A}$`));
  await page.getByTestId('campaign-canvas').waitFor();
  await expect(page.getByTestId('node-trigger')).toBeVisible();
  await expect(page.getByTestId('node-wait')).toBeVisible();
  await expect(page.getByTestId('node-condition')).toBeVisible();
});

test('Design email lives ONLY inside a send-node editor (not on the list)', async ({ page }) => {
  await loginAs(page, DEV_MKT);
  await page.getByTestId('nav-campaigns').click();
  await page.getByTestId('campaigns-list-screen').waitFor();
  await page.getByTestId('campaign-item').filter({ hasText: 'Welcome journey' }).getByTestId('campaign-open').click();
  await page.getByTestId('campaign-canvas').waitFor();

  // Open the send node's editor → it still exposes a Design email affordance.
  await page.getByTestId('node-send').getByTestId(/node-open-/).first().click();
  const drawer = page.getByTestId('node-editor-send');
  await expect(drawer).toBeVisible();
  await expect(drawer.getByTestId('send-design-email')).toBeVisible();
});

test('each list row shows a status badge + an enrollment-counts summary', async ({ page }) => {
  await loginAs(page, DEV_MKT);
  await page.getByTestId('nav-campaigns').click();
  await page.getByTestId('campaigns-list-screen').waitFor();

  const row = page.getByTestId('campaign-item').filter({ hasText: 'Welcome journey' });
  await expect(row.getByTestId('campaign-status')).toBeVisible();
  await expect(row.getByTestId('campaign-counts')).toBeVisible();
  // The seed enrolled one active + one completed profile → counts are non-zero.
  await expect(row.getByTestId('campaign-count-active')).toContainText('1');
  await expect(row.getByTestId('campaign-count-completed')).toContainText('1');
});

test('Back navigation from the detail builder returns to the list', async ({ page }) => {
  await loginAs(page, DEV_MKT);
  await page.getByTestId('nav-campaigns').click();
  await page.getByTestId('campaigns-list-screen').waitFor();
  await page.getByTestId('campaign-item').filter({ hasText: 'Welcome journey' }).getByTestId('campaign-open').click();
  await page.getByTestId('campaign-canvas').waitFor();

  await page.getByTestId('campaigns-back').click();
  await expect(page).toHaveURL(/#\/campaigns$/);
  await page.getByTestId('campaigns-list-screen').waitFor();
});
