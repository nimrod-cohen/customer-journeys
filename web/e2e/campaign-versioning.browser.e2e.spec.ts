// E2E (real Chromium, cdp_e2e): campaign VERSIONING in the builder (§9B). The
// builder edits a DRAFT (PUT /campaigns/:id/draft) — the LIVE campaign is untouched
// until you Save & publish, which appends a VERSION. We prove:
//   - editing a node shows the unsaved-draft indicator (live unchanged, no version yet)
//   - Save & publish (modal: name + forward scope) flips status to active, clears the
//     indicator, and creates a version that the History tab lists as Active
//   - a second edit + publish makes v2 (v2 active, v1 not)
//   - revert to v1 from History (styled confirm) loads it into the draft + toasts
//   - pause / resume from the EDIT-screen header
// The seed has a verified sending domain + a named sender (LOCAL_SES_FORCE_MOCK) so
// the send node + verified-domain gate pass. Real Postgres (cdp_e2e). Run SOLO.
import { test, expect, type Page } from '@playwright/test';
import { loginAs, publishCampaign } from './helpers.js';
import { DEV_MKT } from './seed.js';

/** Build a minimal sendable trigger→send→exit campaign (attaches the seeded
 *  "Welcome" template — a complete envelope). Leaves the builder open. */
async function buildSendableCampaign(page: Page, name: string): Promise<void> {
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
}

/** Insert a wait on the first (+) edge — a structurally-valid edit that dirties the
 *  draft without needing further config. */
async function insertWait(page: Page): Promise<void> {
  await page.getByTestId('campaign-tab-builder').click();
  await page.getByTestId('campaign-edge-insert').first().click();
  await page.getByTestId('campaign-palette').waitFor();
  await page.getByTestId('palette-wait').click();
  await expect(page.getByTestId('node-wait').first()).toBeVisible();
}

test('edit → draft indicator → publish v1 → History lists it active → v2 → revert v1 → pause/resume', async ({ page }) => {
  await loginAs(page, DEV_MKT);
  await buildSendableCampaign(page, 'Versioned journey');

  // Publish v1 (forward) — the first publish establishes the live baseline.
  await publishCampaign(page, 'Initial');
  await expect(page.getByTestId('campaign-status')).toContainText('active');
  // No unsaved draft right after publishing.
  await expect(page.getByTestId('draft-indicator')).toHaveCount(0);

  // EDIT a node → the unsaved-draft indicator appears (live is untouched: still active).
  await insertWait(page);
  await expect(page.getByTestId('draft-indicator')).toBeVisible();
  await expect(page.getByTestId('campaign-status')).toContainText('active');

  // History still shows only v1 as Active (the edit is a draft, not a version yet).
  await page.getByTestId('campaign-tab-history').click();
  await expect(page.getByTestId('campaign-history')).toBeVisible();
  await expect(page.getByTestId('version-row')).toHaveCount(1);
  await expect(page.getByTestId('version-row').first()).toContainText('Initial');
  await expect(page.getByTestId('version-row').first().getByTestId('version-active')).toBeVisible();

  // Publish v2 from the Builder → the draft promotes to live, indicator clears.
  await page.getByTestId('campaign-tab-builder').click();
  await publishCampaign(page, 'Added a wait');
  await expect(page.getByTestId('draft-indicator')).toHaveCount(0);

  // History now lists TWO versions, newest-first, with v2 active (v1 not).
  await page.getByTestId('campaign-tab-history').click();
  await expect(page.getByTestId('version-row')).toHaveCount(2);
  const rows = page.getByTestId('version-row');
  await expect(rows.nth(0)).toContainText('v2');
  await expect(rows.nth(0)).toContainText('Added a wait');
  await expect(rows.nth(0).getByTestId('version-active')).toBeVisible();
  await expect(rows.nth(1)).toContainText('v1');
  await expect(rows.nth(1).getByTestId('version-active')).toHaveCount(0);

  // REVERT to v1 → styled confirm → loads it into the draft, back on the Builder tab.
  await rows.nth(1).getByTestId('version-revert').click();
  await page.getByTestId('app-dialog').waitFor();
  await page.getByTestId('dialog-confirm').click();
  await expect(page.getByTestId('toast').filter({ hasText: /Loaded v1 into the draft/i })).toBeVisible();
  await page.getByTestId('campaign-canvas').waitFor();
  // v1 had no wait (send→exit only) → the reverted draft differs from the live (v2),
  // so the unsaved-draft indicator shows; live (v2) is still active.
  await expect(page.getByTestId('draft-indicator')).toBeVisible();
  await expect(page.getByTestId('node-wait')).toHaveCount(0);
  await expect(page.getByTestId('campaign-status')).toContainText('active');

  // PAUSE / RESUME from the edit-screen header.
  await page.getByTestId('campaign-pause').click();
  await expect(page.getByTestId('campaign-status')).toContainText('paused');
  await page.getByTestId('campaign-resume').click();
  await expect(page.getByTestId('campaign-status')).toContainText('active');
});

test('backfill scope is offered only for a segment_entry trigger with a segment selected', async ({ page }) => {
  await loginAs(page, DEV_MKT);
  await buildSendableCampaign(page, 'Backfill choice');

  // The seeded send-only campaign's starter trigger is segment_entry but has NO
  // segment selected yet → the publish modal offers forward-only (a hint, no radios).
  await page.getByTestId('publish-version').click();
  await page.getByTestId('publish-modal').waitFor();
  await expect(page.getByTestId('publish-scope-hint')).toBeVisible();
  await expect(page.getByTestId('publish-scope-backfill')).toHaveCount(0);
  await page.getByTestId('publish-cancel').click();

  // Pick a segment on the trigger node → now the modal offers the backfill radio.
  await page.getByTestId('node-trigger').getByTestId(/node-open-/).first().click();
  const drawer = page.getByTestId('node-editor-trigger');
  await drawer.getByTestId('trigger-kind').selectOption('segment_entry');
  await drawer.getByTestId('trigger-segment').selectOption({ label: 'VIP (dynamic)' });
  await drawer.getByTestId('node-save').click();
  await expect(drawer).toBeHidden();

  await page.getByTestId('publish-version').click();
  await page.getByTestId('publish-modal').waitFor();
  await expect(page.getByTestId('publish-scope-forward')).toBeVisible();
  await expect(page.getByTestId('publish-scope-backfill')).toBeVisible();
  // Publish with backfill → succeeds (verified domain) and flips to active.
  await page.getByTestId('publish-scope-backfill').check();
  await page.getByTestId('version-name').fill('With segment');
  await page.getByTestId('publish-confirm').click();
  await expect(page.getByTestId('campaign-status')).toContainText('active');
});
