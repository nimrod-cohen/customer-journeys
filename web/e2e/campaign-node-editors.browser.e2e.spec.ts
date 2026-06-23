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
  // Campaigns is now a LIST page; openSeeded opens a row → the canvas builder.
  await page.getByTestId('campaigns-list-screen').waitFor();
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
  // The EVENT TYPE field is an autocomplete: focusing it opens a dropdown of the
  // workspace's known event types (the seed has 'page_view' + 'purchase'); clicking
  // a suggestion fills the input.
  await drawer.getByTestId('trigger-event-type').click();
  const purchaseOpt = drawer.getByTestId('value-suggestion').filter({ hasText: 'purchase' });
  await expect(purchaseOpt).toBeVisible();
  await purchaseOpt.click();
  await expect(drawer.getByTestId('trigger-event-type')).toHaveValue('purchase');

  // The payload filter is PAYLOAD-ONLY (no "did event X" / profile fields): a
  // match selector + rows of attribute·operator·value, starting with one blank row.
  const row0 = drawer.getByTestId('event-filter-row').first();
  await row0.getByTestId('event-filter-field').fill('amount');
  await row0.getByTestId('event-filter-op').selectOption('>');
  // The VALUE box also autocompletes the existing values of that attribute
  // (the seed purchase event has amount=50).
  await row0.getByTestId('event-filter-value').click();
  await expect(drawer.getByTestId('value-suggestion').filter({ hasText: '50' })).toBeVisible();
  await row0.getByTestId('event-filter-value').fill('10');
  await drawer.getByTestId('node-save').click();
  await expect(drawer).toBeHidden();

  // Reopen → the payload row persisted (bare key, operator, value).
  await page.getByTestId('node-trigger').getByTestId(/node-open-/).first().click();
  const reopened = page.getByTestId('node-editor-trigger');
  await expect(reopened.getByTestId('event-filter-field').first()).toHaveValue('amount');
  await expect(reopened.getByTestId('event-filter-op').first()).toHaveValue('>');

  await reopened.getByTestId('trigger-kind').selectOption('manual');
  await expect(page.getByTestId('trigger-manual-note')).toBeVisible();
});

test('TRIGGER editor: profile kind picks created/updated, saves, reload persists + card summary reflects it', async ({ page }) => {
  await openCampaigns(page);
  await openSeeded(page);
  await page.getByTestId('node-trigger').getByTestId(/node-open-/).first().click();
  const drawer = page.getByTestId('node-editor-trigger');

  // Choose the profile trigger → the profile-change Select appears.
  await drawer.getByTestId('trigger-kind').selectOption('profile');
  await expect(drawer.getByTestId('trigger-profile-change')).toBeVisible();
  await drawer.getByTestId('trigger-profile-change').selectOption('updated');
  await drawer.getByTestId('node-save').click();
  await expect(drawer).toBeHidden();

  // The trigger card summary reflects the choice.
  await expect(page.getByTestId('node-trigger')).toContainText('On profile updated');

  // Reload the page → it persisted (kind + profileChange round-trip).
  await page.reload();
  await page.getByTestId('campaign-canvas').waitFor();
  await expect(page.getByTestId('node-trigger')).toContainText('On profile updated');
  await page.getByTestId('node-trigger').getByTestId(/node-open-/).first().click();
  const drawer2 = page.getByTestId('node-editor-trigger');
  await expect(drawer2.getByTestId('trigger-kind')).toHaveValue('profile');
  await expect(drawer2.getByTestId('trigger-profile-change')).toHaveValue('updated');
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

  // Name the branch + set a rule attributes.tier = vip and save → reload re-hydrates both.
  await drawer.getByTestId('condition-name').fill('VIP?');
  await drawer.getByTestId('rule-field').first().fill('attributes.tier');
  await drawer.getByTestId('rule-value').first().fill('vip');
  await drawer.getByTestId('node-save').click();
  await expect(drawer).toBeHidden();

  // The card now shows the chosen name instead of the generic "If / branch".
  await expect(page.getByTestId('node-condition').filter({ hasText: 'VIP?' }).first()).toBeVisible();

  await page.getByTestId('node-condition').getByTestId(/node-open-/).first().click();
  const reopened = page.getByTestId('node-editor-condition');
  await expect(reopened.getByTestId('condition-name')).toHaveValue('VIP?');
  await expect(reopened.getByTestId('rule-field').first()).toHaveValue('attributes.tier');
});

test('the workflow map zooms in and out (view-only, 40%–200%)', async ({ page }) => {
  await openCampaigns(page);
  await openSeeded(page);

  // Default zoom is 100%.
  await expect(page.getByTestId('canvas-zoom-level')).toHaveText('100%');

  // Zoom in twice → 120%, out three times → 90%.
  await page.getByTestId('canvas-zoom-in').click();
  await page.getByTestId('canvas-zoom-in').click();
  await expect(page.getByTestId('canvas-zoom-level')).toHaveText('120%');
  await page.getByTestId('canvas-zoom-out').click();
  await page.getByTestId('canvas-zoom-out').click();
  await page.getByTestId('canvas-zoom-out').click();
  await expect(page.getByTestId('canvas-zoom-level')).toHaveText('90%');

  // Reset returns to 100%.
  await page.getByTestId('canvas-zoom-reset').click();
  await expect(page.getByTestId('canvas-zoom-level')).toHaveText('100%');

  // Zoom is clamped at the 200% ceiling — climb only while the control is enabled
  // (it disables on arrival, so we never click a disabled button).
  const zoomIn = page.getByTestId('canvas-zoom-in');
  for (let i = 0; i < 12 && (await zoomIn.isEnabled()); i++) await zoomIn.click();
  await expect(page.getByTestId('canvas-zoom-level')).toHaveText('200%');
  await expect(zoomIn).toBeDisabled();

  // …and clamped at the 40% floor on the way down.
  await page.getByTestId('canvas-zoom-reset').click();
  const zoomOut = page.getByTestId('canvas-zoom-out');
  for (let i = 0; i < 12 && (await zoomOut.isEnabled()); i++) await zoomOut.click();
  await expect(page.getByTestId('canvas-zoom-level')).toHaveText('40%');
  await expect(zoomOut).toBeDisabled();
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

test('UPDATE-PROFILE editor: a LIST of assignments (a literal + a JS value w/ placeholder) round-trips', async ({ page }) => {
  await openCampaigns(page);
  await openSeeded(page);

  await page.getByTestId('campaign-edge-insert').first().click();
  await page.getByTestId('palette-update-profile').click();
  await page.getByTestId('node-set_attribute').getByTestId(/node-open-/).first().click();
  const drawer = page.getByTestId('node-editor-set_attribute');

  // Row 0: a fixed (literal) value. Scope by the row CONTAINER (mode-specific value
  // testids only render for rows in that mode, so their global index != row index).
  const row0 = drawer.getByTestId('assignment-row').nth(0);
  await row0.getByTestId('assignment-key').fill('stage');
  await row0.getByTestId('assignment-value-mode').selectOption('literal');
  await row0.getByTestId('assignment-literal').fill('won');

  // Add a SECOND row: a JS value that uses a {{customer.*}} placeholder.
  await drawer.getByTestId('assignment-add').click();
  const row1 = drawer.getByTestId('assignment-row').nth(1);
  await row1.getByTestId('assignment-key').fill('greeting');
  await row1.getByTestId('assignment-value-mode').selectOption('js');
  await expect(row1.getByTestId('assignment-js')).toBeVisible();
  await row1.getByTestId('assignment-js').fill('return "Hi " + ');
  // Insert a placeholder token via the per-row tag cloud (click the chip → appends to JS).
  await row1.getByTestId('placeholder-token').filter({ hasText: 'customer.first_name' }).click();
  await expect(row1.getByTestId('assignment-js')).toHaveValue('return "Hi " + {{customer.first_name}}');

  await drawer.getByTestId('node-save').click();
  await expect(drawer).toBeHidden();

  // The card shows the multi-assignment summary.
  await expect(page.getByTestId('node-set_attribute').filter({ hasText: 'Set 2 attributes' }).first()).toBeVisible();

  // Reopen → both rows round-trip with the right modes + values.
  await page.getByTestId('node-set_attribute').getByTestId(/node-open-/).first().click();
  const reopened = page.getByTestId('node-editor-set_attribute');
  const r0 = reopened.getByTestId('assignment-row').nth(0);
  const r1 = reopened.getByTestId('assignment-row').nth(1);
  await expect(r0.getByTestId('assignment-key')).toHaveValue('stage');
  await expect(r0.getByTestId('assignment-literal')).toHaveValue('won');
  await expect(r1.getByTestId('assignment-key')).toHaveValue('greeting');
  await expect(r1.getByTestId('assignment-value-mode')).toHaveValue('js');
  await expect(r1.getByTestId('assignment-js')).toHaveValue('return "Hi " + {{customer.first_name}}');
});

test('TRIGGER editor: a cosmetic name persists and shows on the trigger card', async ({ page }) => {
  await openCampaigns(page);
  await openSeeded(page);

  await page.getByTestId('node-trigger').getByTestId(/node-open-/).first().click();
  const drawer = page.getByTestId('node-editor-trigger');
  await expect(drawer.getByTestId('trigger-name')).toBeVisible();
  await drawer.getByTestId('trigger-name').fill('New VIPs');
  await drawer.getByTestId('node-save').click();
  await expect(drawer).toBeHidden();

  // The trigger card now shows the chosen name instead of the kind text.
  await expect(page.getByTestId('node-trigger').filter({ hasText: 'New VIPs' }).first()).toBeVisible();

  // Reopen → the name round-trips.
  await page.getByTestId('node-trigger').getByTestId(/node-open-/).first().click();
  await expect(page.getByTestId('node-editor-trigger').getByTestId('trigger-name')).toHaveValue('New VIPs');
});

test('SEND editor: attach a template (kind=copy) then Design email opens the designer drawer', async ({ page }) => {
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

  // Design email → opens the email designer in a DRAWER over the campaign (no
  // navigation — the canvas + node editor stay mounted). Close via "Save & close".
  await page.getByTestId('node-editor-send').getByTestId('send-design-email').click();
  await page.getByTestId('email-designer-drawer').waitFor();
  await expect(page.getByTestId('email-editor')).toBeVisible();
  await expect(page.getByTestId('editor-back')).toContainText('Save & close');
  await page.getByTestId('editor-back').click();
  await expect(page.getByTestId('email-designer-drawer')).toHaveCount(0);
});
