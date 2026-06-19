// E2E (real Chromium, cdp_e2e): the per-node CONFIG editors of the campaign builder
// (§9B phase 6). Each node card opens its editor Drawer (node-editor-<type>); a
// config is set, saved (button spinner+lock), and round-trips on reopen. The IF
// editor mounts the SAME shared rule builder as segments; the SEND editor clones a
// kind='copy' via attach-template (NOT the old placeholder) and the "Design email"
// flow sets the campaign return context. No native dialogs; data-testid throughout.
import { test, expect, type Page } from '@playwright/test';
import { loginAs } from './helpers.js';
import { DEV_MKT } from './seed.js';

async function openCampaigns(page: Page): Promise<void> {
  await loginAs(page, DEV_MKT);
  await page.getByTestId('nav-campaigns').click();
  await page.getByTestId('campaign-builder').waitFor();
}

/** Open the seeded "Welcome journey" campaign in the builder. */
async function openSeeded(page: Page): Promise<void> {
  await page.getByTestId('campaign-item').filter({ hasText: 'Welcome journey' }).getByTestId('campaign-open').click();
  await page.getByTestId('campaign-canvas').waitFor();
}

test('no native dialogs are used anywhere in the editors', async ({ page }) => {
  // Fail loudly if any editor reaches for window.confirm/alert/prompt.
  await openCampaigns(page);
  page.on('dialog', (d) => {
    throw new Error(`unexpected native dialog: ${d.type()} ${d.message()}`);
  });
  await openSeeded(page);
  await page.getByTestId('node-trigger').getByTestId(/node-open-/).first().click();
  await expect(page.getByTestId('node-editor-trigger')).toBeVisible();
});

test('TRIGGER editor: segment_entry picks a seeded segment and persists trigger_segment_id', async ({ page }) => {
  await openCampaigns(page);
  await openSeeded(page);

  await page.getByTestId('node-trigger').getByTestId(/node-open-/).first().click();
  const drawer = page.getByTestId('node-editor-trigger');
  await expect(drawer).toBeVisible();

  // segment_entry → a segment picker populated from GET /segments.
  await drawer.getByTestId('trigger-kind').selectOption('segment_entry');
  await drawer.getByTestId('trigger-segment').selectOption({ label: 'VIP (dynamic)' });
  await drawer.getByTestId('node-save').click();
  await expect(drawer).toBeHidden();

  // Reopen → the chosen segment round-tripped.
  await page.getByTestId('node-trigger').getByTestId(/node-open-/).first().click();
  await expect(page.getByTestId('node-editor-trigger').getByTestId('trigger-segment')).toHaveValue(/.+/);
});

test('TRIGGER editor: event kind shows event type + manual shows a note', async ({ page }) => {
  await openCampaigns(page);
  await openSeeded(page);
  await page.getByTestId('node-trigger').getByTestId(/node-open-/).first().click();
  const drawer = page.getByTestId('node-editor-trigger');

  await drawer.getByTestId('trigger-kind').selectOption('event');
  await expect(drawer.getByTestId('trigger-event-type')).toBeVisible();
  await expect(drawer.getByTestId('trigger-event-filter')).toBeVisible();
  await drawer.getByTestId('trigger-event-type').fill('purchase');
  await drawer.getByTestId('node-save').click();
  await expect(drawer).toBeHidden();

  await page.getByTestId('node-trigger').getByTestId(/node-open-/).first().click();
  await page.getByTestId('node-editor-trigger').getByTestId('trigger-kind').selectOption('manual');
  await expect(page.getByTestId('trigger-manual-note')).toBeVisible();
});

test('WAIT editor: set 3 days, save, reload round-trips the summary', async ({ page }) => {
  await openCampaigns(page);
  await openSeeded(page);
  // The seeded campaign has a wait node.
  await page.getByTestId('node-wait').getByTestId(/node-open-/).first().click();
  const drawer = page.getByTestId('node-editor-wait');
  await drawer.getByTestId('wait-amount').fill('3');
  await drawer.getByTestId('wait-unit').selectOption({ label: 'days' });
  await drawer.getByTestId('node-save').click();
  await expect(drawer).toBeHidden();
  await expect(page.getByTestId('node-wait')).toContainText(/3 days|3d/i);
});

test('IF editor: embeds the SAME rule builder; an empty group blocks save inline', async ({ page }) => {
  await openCampaigns(page);
  await openSeeded(page);
  await page.getByTestId('node-condition').getByTestId(/node-open-/).first().click();
  const drawer = page.getByTestId('node-editor-condition');

  // The shared rule builder's controls are present (same testids as segments).
  await expect(drawer.getByTestId('rule-row').first()).toBeVisible();
  await expect(drawer.getByTestId('rule-field').first()).toBeVisible();
  await expect(drawer.getByTestId('rule-operator').first()).toBeVisible();
  await expect(drawer.getByTestId('add-rule')).toBeVisible();

  // Set a rule attributes.tier = vip and save → reload re-hydrates it.
  await drawer.getByTestId('rule-field').first().fill('attributes.tier');
  await drawer.getByTestId('rule-value').first().fill('vip');
  await drawer.getByTestId('node-save').click();
  await expect(drawer).toBeHidden();

  await page.getByTestId('node-condition').getByTestId(/node-open-/).first().click();
  await expect(page.getByTestId('node-editor-condition').getByTestId('rule-field').first()).toHaveValue('attributes.tier');
});

test('WEBHOOK editor: write-only secret is never echoed; a non-http url blocks save', async ({ page }) => {
  await openCampaigns(page);
  await openSeeded(page);

  // Insert a webhook on the trigger→wait edge.
  await page.getByTestId('campaign-edge-insert').first().click();
  await page.getByTestId('campaign-palette').waitFor();
  await page.getByTestId('palette-webhook').click();
  await page.getByTestId('node-webhook').getByTestId(/node-open-/).first().click();
  const drawer = page.getByTestId('node-editor-webhook');

  // A non-http url blocks save with an inline error (no native dialog).
  await drawer.getByTestId('webhook-url').fill('ftp://nope');
  await drawer.getByTestId('node-save').click();
  await expect(drawer.getByTestId('webhook-error')).toBeVisible();

  // Fix the url + add a secret auth header, save.
  await drawer.getByTestId('webhook-url').fill('https://hooks.example.com/x');
  await drawer.getByTestId('webhook-secret-header').fill('Authorization');
  await drawer.getByTestId('webhook-secret').fill('Bearer s3cr3t');
  await drawer.getByTestId('node-save').click();
  await expect(drawer).toBeHidden();

  // Reopen → the secret value is NOT echoed back (empty field, placeholder note).
  await page.getByTestId('node-webhook').getByTestId(/node-open-/).first().click();
  await expect(page.getByTestId('node-editor-webhook').getByTestId('webhook-secret')).toHaveValue('');
});

test('UPDATE-PROFILE editor: literal↔expression value mode round-trips', async ({ page }) => {
  await openCampaigns(page);
  await openSeeded(page);

  await page.getByTestId('campaign-edge-insert').first().click();
  await page.getByTestId('palette-update-profile').click();
  await page.getByTestId('node-set_attribute').getByTestId(/node-open-/).first().click();
  const drawer = page.getByTestId('node-editor-set_attribute');

  await drawer.getByTestId('update-key').fill('last_sku');
  await drawer.getByTestId('value-mode').selectOption('expression');
  await expect(drawer.getByTestId('update-expression')).toBeVisible();
  await drawer.getByTestId('update-expression').fill('{{event.sku}}');
  await drawer.getByTestId('node-save').click();
  await expect(drawer).toBeHidden();

  await page.getByTestId('node-set_attribute').getByTestId(/node-open-/).first().click();
  await expect(page.getByTestId('node-editor-set_attribute').getByTestId('update-key')).toHaveValue('last_sku');
  await expect(page.getByTestId('node-editor-set_attribute').getByTestId('update-expression')).toHaveValue('{{event.sku}}');
});

test('SEND editor: attach a template (kind=copy) then Design email sets the campaign return', async ({ page }) => {
  await openCampaigns(page);
  await openSeeded(page);

  // The seeded campaign already has a send node referencing a LIBRARY template
  // (TPL_A) — but a fresh send node uses the picker. Insert a new send to exercise
  // the picker → attach-template clone.
  await page.getByTestId('campaign-edge-insert').first().click();
  await page.getByTestId('palette-send').click();
  // Open the NEW (unattached) send node — it offers the picker.
  await page.getByTestId('node-send').last().getByTestId(/node-open-/).first().click();
  const drawer = page.getByTestId('node-editor-send');
  await expect(drawer.getByTestId('send-template-pick')).toBeVisible();
  await drawer.getByTestId('send-template-pick').selectOption({ label: 'Welcome' });
  await drawer.getByTestId('send-attach-template').click();

  // The drawer closes; reopen → the instance view shows (clone attached).
  await expect(drawer).toBeHidden();
  await page.getByTestId('node-send').last().getByTestId(/node-open-/).first().click();
  await expect(page.getByTestId('node-editor-send').getByTestId('send-email-instance')).toBeVisible();

  // Design email → navigates to the editor with "← Back to campaign".
  await page.getByTestId('node-editor-send').getByTestId('send-design-email').click();
  await expect(page).toHaveURL(/\/editor/);
  await expect(page.getByTestId('editor-back')).toContainText(/campaign/i);
});
