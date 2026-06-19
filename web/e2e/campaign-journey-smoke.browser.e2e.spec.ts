// E2E (real Chromium) — a THIN journey BUILD smoke (§9B phase 7). It assembles the
// full-node journey (trigger → wait → hour-window → if → update-profile → send →
// webhook → exit) in the browser via the (+) palette, configures each node via its
// drawer, attaches a sendable seeded template to the send node, points the webhook
// at the seeded-allowlisted host, and PUBLISHES it to active. The runner advance /
// send / webhook assertions live in the integration test
// (services/local-api/test/campaign-journey-live-enroll.integration.test.ts) —
// here we only prove the journey BUILDS + PUBLISHES. Real Postgres (cdp_e2e).
import { test, expect } from '@playwright/test';
import { loginAs } from './helpers.js';
import { DEV_MKT } from './seed.js';

/** Insert a node on the FIRST (+) control, picking it from the palette. */
async function insertFirst(page: import('@playwright/test').Page, paletteTestId: string): Promise<void> {
  await page.getByTestId('campaign-edge-insert').first().click();
  await page.getByTestId('campaign-palette').waitFor();
  await page.getByTestId(paletteTestId).click();
}

test('build the full-node journey in the browser and publish it to active', async ({ page }) => {
  await loginAs(page, DEV_MKT);
  await page.getByTestId('nav-campaigns').click();
  await page.getByTestId('campaigns-list-screen').waitFor();
  await page.getByTestId('campaign-new').click();
  await page.getByTestId('campaign-canvas').waitFor();
  await page.getByTestId('campaign-name').fill('Full journey smoke');

  // Build the linear spine on the trigger→exit edge: each insert lands on the first
  // (+) (the trigger→… edge), pushing the chain down. Order of inserts yields:
  // trigger → wait → hour-window → if → update-profile → send → webhook → exit.
  await insertFirst(page, 'palette-send');
  await expect(page.getByTestId('node-send')).toBeVisible();
  await insertFirst(page, 'palette-update-profile');
  await expect(page.getByTestId('node-set_attribute')).toBeVisible();
  await insertFirst(page, 'palette-hour-window');
  await expect(page.getByTestId('node-hour_of_day_window')).toBeVisible();
  await insertFirst(page, 'palette-wait');
  await expect(page.getByTestId('node-wait')).toBeVisible();

  // Add a webhook AFTER the send (insert on the send→exit edge). Find the (+) just
  // below the send card.
  const sendBox = await page.getByTestId('node-send').boundingBox();
  const inserts = await page.getByTestId('campaign-edge-insert').evaluateAll((els) =>
    els.map((e) => (e as HTMLElement).getBoundingClientRect().top),
  );
  const belowSend = inserts
    .map((top, i) => ({ top, i }))
    .filter((x) => x.top > (sendBox!.y + sendBox!.height))
    .sort((a, b) => a.top - b.top)[0];
  await page.getByTestId('campaign-edge-insert').nth(belowSend!.i).click();
  await page.getByTestId('palette-webhook').click();
  await expect(page.getByTestId('node-webhook')).toBeVisible();

  // Configure the update-profile node (literal welcomed=y).
  await page.getByTestId('node-set_attribute').getByTestId(/node-open-/).first().click();
  let drawer = page.getByTestId('node-editor-set_attribute');
  await drawer.getByTestId('update-key').fill('welcomed');
  await drawer.getByTestId('node-save').click();
  await expect(drawer).toBeHidden();

  // Attach the sendable seeded "Welcome" template to the send node.
  await page.getByTestId('node-send').getByTestId(/node-open-/).first().click();
  drawer = page.getByTestId('node-editor-send');
  await drawer.getByTestId('send-template-pick').selectOption({ label: 'Welcome' });
  await drawer.getByTestId('send-attach-template').click();
  await expect(drawer).toBeHidden();

  // Configure the webhook node URL to the seeded-allowlisted host.
  await page.getByTestId('node-webhook').getByTestId(/node-open-/).first().click();
  drawer = page.getByTestId('node-editor-webhook');
  await drawer.getByTestId('webhook-url').fill('https://hooks.example.com/journey');
  await drawer.getByTestId('node-save').click();
  await expect(drawer).toBeHidden();

  // Save the assembled journey (server validates the graph).
  await page.getByTestId('save-campaign').click();
  await expect(page.getByTestId('toast')).toBeVisible();

  // Publish → status flips to active (the seeded workspace has a verified domain
  // and the attached template is sendable).
  await page.getByTestId('campaign-publish').click();
  await expect(page.getByTestId('campaign-status')).toContainText('active');

  // Back on the list, the row shows active + a (zero) enrollment-counts cell.
  await page.getByTestId('campaigns-back').click();
  const row = page.getByTestId('campaign-item').filter({ hasText: 'Full journey smoke' });
  await expect(row.getByTestId('campaign-status')).toContainText('active');
  await expect(row.getByTestId('campaign-counts')).toBeVisible();
});
