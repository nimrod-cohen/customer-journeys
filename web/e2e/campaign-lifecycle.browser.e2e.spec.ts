// E2E (real Chromium): the campaign LIST shows lifecycle status + enrollment
// counts; publish (draft→active), pause (active→paused), resume (paused→active)
// and archive work via the per-row ActionMenu (spinner+lock, no native dialog;
// archive confirmed via the styled app-dialog). Workspace-scoped (WS_A never shows
// WS_B). Capability gating is covered at the API tier in
// services/local-api/test/campaign-lifecycle.integration.test.ts (the e2e seed has
// no accounting user). Real Postgres (cdp_e2e).
import { test, expect } from '@playwright/test';
import { loginAs, publishCampaign } from './helpers.js';
import { DEV_MKT, DEV_OWNER, WS_A2 } from './seed.js';

/** Build a minimal trigger→send→exit campaign on the detail page, attaching the
 *  seeded "Welcome" template (a complete, sendable envelope) to the send node. */
async function buildSendableCampaign(page: import('@playwright/test').Page, name: string): Promise<void> {
  await page.getByTestId('nav-campaigns').click();
  await page.getByTestId('campaigns-list-screen').waitFor();
  await page.getByTestId('campaign-new').click();
  await page.getByTestId('campaign-canvas').waitFor();
  await page.getByTestId('campaign-name').fill(name);

  // Insert a send node on the starter trigger→exit edge.
  await page.getByTestId('campaign-edge-insert').first().click();
  await page.getByTestId('campaign-palette').waitFor();
  await page.getByTestId('palette-send').click();
  await expect(page.getByTestId('node-send')).toBeVisible();

  // Attach the seeded "Welcome" template (sender + subject + to all set) to it.
  await page.getByTestId('node-send').getByTestId(/node-open-/).first().click();
  const drawer = page.getByTestId('node-editor-send');
  await drawer.getByTestId('send-template-pick').selectOption({ label: 'Welcome' });
  await drawer.getByTestId('send-attach-template').click();
  // After attaching, the editor STAYS OPEN showing the email instance; close it explicitly.
  await expect(drawer.getByTestId('send-email-instance')).toBeVisible();
  await drawer.getByTestId('drawer-close').click();
  await expect(drawer).toBeHidden();
}

test('publish → pause → resume → archive via the row ActionMenu', async ({ page }) => {
  await loginAs(page, DEV_MKT);
  await buildSendableCampaign(page, 'Lifecycle journey');

  // Publish a version (Save-version modal, forward) → active.
  await publishCampaign(page, 'Lifecycle v1');
  await expect(page.getByTestId('campaign-status')).toContainText('active');

  // Back to the list — the row shows status active.
  await page.getByTestId('campaigns-back').click();
  const row = page.getByTestId('campaign-item').filter({ hasText: 'Lifecycle journey' });
  await expect(row.getByTestId('campaign-status')).toContainText('active');

  // Pause (active → paused) via the kebab menu.
  await row.getByTestId('campaign-actions').click();
  await page.getByTestId('campaign-pause').click();
  await expect(row.getByTestId('campaign-status')).toContainText('paused');

  // Resume (paused → active).
  await row.getByTestId('campaign-actions').click();
  await page.getByTestId('campaign-resume').click();
  await expect(row.getByTestId('campaign-status')).toContainText('active');

  // Archive (→ archived) — confirmed via the styled dialog; the row drops from the
  // default list afterwards.
  await row.getByTestId('campaign-actions').click();
  await page.getByTestId('campaign-archive').click();
  await page.getByTestId('app-dialog').waitFor();
  await page.getByTestId('dialog-confirm').click();
  await expect(page.getByTestId('campaign-item').filter({ hasText: 'Lifecycle journey' })).toHaveCount(0);
});

test('the list is workspace-scoped: WS_A campaigns only, re-scoped on switch', async ({ page }) => {
  // The multi-workspace owner can switch between the two Acme workspaces. The
  // seeded "Welcome journey" lives in WS_A; switching to WS_A2 drops it.
  await loginAs(page, DEV_OWNER);
  await page.getByTestId('nav-campaigns').click();
  await page.getByTestId('campaigns-list-screen').waitFor();
  await expect(page.getByTestId('campaign-item').filter({ hasText: 'Welcome journey' })).toBeVisible();

  // Switch to the 2nd Acme workspace (West) → its campaign list does NOT show WS_A's.
  await page.getByTestId('workspace-select').selectOption(WS_A2);
  await page.getByTestId('nav-campaigns').click();
  await page.getByTestId('campaigns-list-screen').waitFor();
  await expect(page.getByTestId('campaign-item').filter({ hasText: 'Welcome journey' })).toHaveCount(0);
});
