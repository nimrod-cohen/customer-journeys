// E2E (real Chromium): a NEVER-published automation (active_version_id null) shows
// DELETE in its row ActionMenu (not Archive); confirming the styled dialog hard-
// deletes it and the row disappears. A PUBLISHED automation shows ARCHIVE (not
// Delete). The server's never-delete-a-published-automation guard (409) is covered
// at the API tier (services/local-api/test/automation-delete.integration.test.ts).
// Real Postgres (cdp_e2e).
//
// IMPORTANT: this spec creates its OWN throwaway automations and never touches the
// shared seeded "Welcome journey" — deleting that would pollute cdp_e2e for the
// other automation specs that depend on it (the suite shares one DB serially).
import { test, expect } from '@playwright/test';
import { loginAs, publishAutomation } from './helpers.js';
import { DEV_MKT } from './seed.js';

/** Create a fresh DRAFT automation on the detail page (never published — its first
 *  persist is POST /automations, so active_version_id stays null) and return to the
 *  list. Attaches the seeded "Welcome" template to a send node so it is sendable
 *  (which also makes it publishable for the published-variant test). */
async function createDraftAutomation(page: import('@playwright/test').Page, name: string): Promise<void> {
  await page.getByTestId('nav-automations').click();
  await page.getByTestId('automations-list-screen').waitFor();
  await page.getByTestId('automation-new').click();
  await page.getByTestId('automation-canvas').waitFor();
  await page.getByTestId('automation-name').fill(name);

  // Insert a send node on the starter trigger→exit edge (this persists the draft).
  await page.getByTestId('automation-edge-insert').first().click();
  await page.getByTestId('automation-palette').waitFor();
  await page.getByTestId('palette-send').click();
  await expect(page.getByTestId('node-send')).toBeVisible();

  // Attach the seeded "Welcome" template (sender + subject + to all set).
  await page.getByTestId('node-send').getByTestId(/node-open-/).first().click();
  const drawer = page.getByTestId('node-editor-send');
  await drawer.getByTestId('send-template-pick').selectOption({ label: 'Welcome' });
  await drawer.getByTestId('send-attach-template').click();
  // The editor STAYS OPEN and shows the instance view (attach no longer auto-closes);
  // close it explicitly to return to the canvas.
  await expect(drawer.getByTestId('send-email-instance')).toBeVisible();
  await drawer.getByTestId('drawer-close').click();
  await expect(drawer).toBeHidden();
}

test('a never-published draft offers DELETE; confirming removes the row', async ({ page }) => {
  await loginAs(page, DEV_MKT);
  await createDraftAutomation(page, 'Delete-me draft');

  // Back to the list — the draft (never published) is there.
  await page.getByTestId('automations-back').click();
  const row = page.getByTestId('automation-item').filter({ hasText: 'Delete-me draft' });
  await expect(row).toBeVisible();

  // Its row menu shows DELETE — and NOT Archive (never published).
  await row.getByTestId('automation-actions').click();
  await expect(page.getByTestId('automation-delete')).toBeVisible();
  await expect(page.getByTestId('automation-archive')).toHaveCount(0);

  // Delete via the styled confirm dialog (never a native dialog) → row gone.
  await page.getByTestId('automation-delete').click();
  await page.getByTestId('app-dialog').waitFor();
  await page.getByTestId('dialog-confirm').click();
  await expect(page.getByTestId('automation-item').filter({ hasText: 'Delete-me draft' })).toHaveCount(0);
});

test('a PUBLISHED automation offers ARCHIVE, not Delete', async ({ page }) => {
  await loginAs(page, DEV_MKT);
  await createDraftAutomation(page, 'Publish then archive-only');
  // Publish it (draft → active, active_version_id set) — now history, archive-only.
  await publishAutomation(page, 'v1');
  await expect(page.getByTestId('automation-status')).toContainText('active');

  await page.getByTestId('automations-back').click();
  const row = page.getByTestId('automation-item').filter({ hasText: 'Publish then archive-only' });
  await expect(row).toBeVisible();

  // A published automation is history — its row menu shows ARCHIVE, NOT Delete.
  await row.getByTestId('automation-actions').click();
  await expect(page.getByTestId('automation-archive')).toBeVisible();
  await expect(page.getByTestId('automation-delete')).toHaveCount(0);

  // Leave the suite's shared DB clean for downstream specs: archive this one so it
  // drops from the default list (it is published, so it can't be deleted).
  await page.getByTestId('automation-archive').click();
  await page.getByTestId('app-dialog').waitFor();
  await page.getByTestId('dialog-confirm').click();
  await expect(page.getByTestId('automation-item').filter({ hasText: 'Publish then archive-only' })).toHaveCount(0);
});
