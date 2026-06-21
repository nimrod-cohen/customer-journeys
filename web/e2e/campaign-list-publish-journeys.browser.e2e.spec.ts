// E2E (real Chromium, cdp_e2e): two campaign-builder additions —
//   1) PUBLISH from the campaigns LIST: a publishable (never-published draft OR a
//      campaign with an unsaved draft) row exposes "Publish…" in its ActionMenu,
//      which opens the SAME publish modal as the detail screen; a forward publish
//      flips the row to active.
//   2) The JOURNEYS tab on the detail screen lists the profiles that have passed
//      through the campaign (email + status + enrolled time + current step).
//
// IMPORTANT: the publish test creates its OWN throwaway draft campaign. The Journeys
// test READS the shared seeded "Welcome journey" (it has two enrollments seeded) and
// does NOT mutate it. The suite shares one DB serially. Real Postgres (cdp_e2e).
import { test, expect, type Page } from '@playwright/test';
import { loginAs } from './helpers.js';
import { DEV_MKT } from './seed.js';

/** Build a sendable DRAFT campaign on the detail page (never published — its first
 *  persist is POST /campaigns, active_version_id stays null) and return to the list.
 *  Attaches the seeded "Welcome" template (sender + subject + to all set) so the
 *  publish gate passes. */
async function createDraftCampaign(page: Page, name: string): Promise<void> {
  await page.getByTestId('nav-campaigns').click();
  await page.getByTestId('campaigns-list-screen').waitFor();
  await page.getByTestId('campaign-new').click();
  await page.getByTestId('campaign-canvas').waitFor();
  await page.getByTestId('campaign-name').fill(name);

  await page.getByTestId('campaign-edge-insert').first().click();
  await page.getByTestId('campaign-palette').waitFor();
  await page.getByTestId('palette-send').click();
  await expect(page.getByTestId('node-send')).toBeVisible();

  await page.getByTestId('node-send').getByTestId(/node-open-/).first().click();
  const drawer = page.getByTestId('node-editor-send');
  await drawer.getByTestId('send-template-pick').selectOption({ label: 'Welcome' });
  await drawer.getByTestId('send-attach-template').click();
  await expect(drawer).toBeHidden();

  await page.getByTestId('campaigns-back').click();
  await page.getByTestId('campaigns-list-screen').waitFor();
}

test('a draft campaign exposes "Publish…" in its list menu → modal → forward publish flips it active', async ({ page }) => {
  await loginAs(page, DEV_MKT);
  await createDraftCampaign(page, 'List-publish journey');

  const row = page.getByTestId('campaign-item').filter({ hasText: 'List-publish journey' });
  await expect(row).toBeVisible();
  await expect(row.getByTestId('campaign-status')).toContainText('draft');

  // The row menu offers Publish… for a publishable (never-published) draft.
  await row.getByTestId('campaign-actions').click();
  await page.getByTestId('campaign-publish').click();

  // The SAME publish modal as the detail screen opens.
  await page.getByTestId('publish-modal').waitFor();
  await page.getByTestId('version-name').fill('From the list');
  await page.getByTestId('publish-confirm').click();

  // Success toast + the row flips to active (status updated, modal closed).
  await expect(page.getByTestId('toast').filter({ hasText: /Published v1/i })).toBeVisible();
  await expect(page.getByTestId('publish-modal')).toHaveCount(0);
  await expect(row.getByTestId('campaign-status')).toContainText('active');

  // Once published with no fresh draft, the row no longer offers Publish….
  await row.getByTestId('campaign-actions').click();
  await expect(page.getByTestId('campaign-publish')).toHaveCount(0);
});

test('the Journeys tab lists the profiles that have entered the campaign', async ({ page }) => {
  await loginAs(page, DEV_MKT);
  await page.getByTestId('nav-campaigns').click();
  await page.getByTestId('campaigns-list-screen').waitFor();

  // Open the seeded "Welcome journey" (it has two seeded enrollments).
  await page.getByTestId('campaign-item').filter({ hasText: 'Welcome journey' }).getByTestId('campaign-open').click();
  await page.getByTestId('campaign-canvas').waitFor();

  // Switch to the Journeys tab → it lists the seeded enrollments.
  await page.getByTestId('campaign-tab-journeys').click();
  await expect(page.getByTestId('campaign-journeys')).toBeVisible();
  await expect(page.getByTestId('journey-row')).toHaveCount(2);

  // The seeded active enrollment (enr-active@acme.com) shows its email + active status.
  const activeRow = page.getByTestId('journey-row').filter({ hasText: 'enr-active@acme.com' });
  await expect(activeRow).toBeVisible();
  await expect(activeRow.getByTestId('journey-status')).toContainText('active');
  // The completed enrollment is listed too.
  await expect(page.getByTestId('journey-row').filter({ hasText: 'enr-completed@acme.com' })).toBeVisible();
});
