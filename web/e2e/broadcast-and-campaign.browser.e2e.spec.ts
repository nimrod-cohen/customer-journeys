// E2E (real Chromium): compose + send a broadcast, and build + save a campaign
// (§12, §9A, §9B). The broadcast targets the seeded manual segment + template and
// sends through the real broadcast core (SQS mocked locally) → status flips. The
// campaign builder assembles a trigger→wait→send→exit graph that the server
// validates and persists. Proven in a real browser against real Postgres.
import { test, expect } from '@playwright/test';
import { loginAs } from './helpers.js';
import { DEV_MKT } from './seed.js';

test('create a broadcast via the wizard and Send now sends it immediately', async ({ page }) => {
  await loginAs(page, DEV_MKT);
  await page.getByTestId('nav-broadcasts').click();
  await page.getByTestId('broadcast-composer').waitFor();

  // "New broadcast" opens the multi-step wizard.
  await page.getByTestId('new-broadcast').click();
  await page.getByTestId('broadcast-wizard').waitFor();

  // Step 1 — audience: the seeded manual segment is the first non-empty option.
  await page.getByTestId('broadcast-name').fill('Spring sale');
  await page.getByTestId('broadcast-segment').selectOption({ index: 1 });
  await page.getByTestId('wizard-next').click();
  // Step 2 — content: start from a template. Choosing one CLONES it into this
  // broadcast's own email instance — after which the picker is gone (no swapping
  // the underlying template) and only the instance with Edit/Start over remains.
  await page.getByTestId('broadcast-template').selectOption({ index: 1 });
  await expect(page.getByTestId('email-instance')).toBeVisible();
  await expect(page.getByTestId('broadcast-template')).toHaveCount(0);
  await page.getByTestId('wizard-next').click();
  // Step 3 — "Send now" is the default; the finish button SENDS immediately
  // (not a draft) and returns to the list.
  await expect(page.getByTestId('wizard-save')).toHaveText('Send now');
  await page.getByTestId('wizard-save').click();

  // Back on the list with a success toast; the broadcast is sent (not a draft),
  // so it shows its metrics and no longer offers a Send button.
  await page.getByTestId('broadcast-composer').waitFor();
  await expect(page.getByTestId('toast')).toBeVisible();
  const item = page.getByTestId('broadcast-item').filter({ hasText: 'Spring sale' });
  await expect(item.getByTestId('broadcast-metrics')).toBeVisible();
  await expect(item.getByTestId('broadcast-metrics')).toContainText('Delivered');
  // The full conversion funnel renders: Sent · Delivered · Failed · Opened ·
  // Clicked · Unsubscribed — each a COUNT and a % (0 in local dev for the
  // feedback-pipeline metrics; the cells still render).
  for (const id of ['bc-sent', 'bc-delivered', 'bc-failed', 'bc-opened', 'bc-clicked', 'bc-unsubscribed']) {
    await expect(item.getByTestId(id)).toBeVisible();
    await expect(item.getByTestId(`${id}-count`)).toBeVisible();
    await expect(item.getByTestId(`${id}-pct`)).toContainText('%');
  }
  // Row actions live in a kebab (⋮) menu. A SENT broadcast offers only Duplicate —
  // no Send action even with the menu open.
  await item.getByTestId('broadcast-actions').click();
  await expect(item.getByTestId('broadcast-duplicate')).toBeVisible();
  await expect(item.getByTestId('send-broadcast')).toHaveCount(0);
});

test('duplicate a broadcast, then delete an unsent one from the list', async ({ page }) => {
  await loginAs(page, DEV_MKT);
  await page.getByTestId('nav-broadcasts').click();
  await page.getByTestId('broadcast-composer').waitFor();

  // Create a draft to work with.
  await page.getByTestId('new-broadcast').click();
  await page.getByTestId('broadcast-wizard').waitFor();
  await page.getByTestId('broadcast-name').fill('Dup source');
  await page.getByTestId('broadcast-segment').selectOption({ index: 1 });
  await page.getByTestId('wizard-next').click();
  await page.getByTestId('broadcast-template').selectOption({ index: 1 });
  await page.getByTestId('wizard-next').click();
  await page.getByTestId('wizard-save-draft').click();
  await page.getByTestId('broadcast-composer').waitFor();

  // Duplicate it (via the ⋮ actions menu) → a "(copy)" draft appears.
  const source = page.getByTestId('broadcast-item').filter({ hasText: 'Dup source' }).first();
  await source.getByTestId('broadcast-actions').click();
  await source.getByTestId('broadcast-duplicate').click();
  const copy = page.getByTestId('broadcast-item').filter({ hasText: 'Dup source (copy)' });
  await expect(copy).toHaveCount(1);

  // Delete the copy via the styled confirm → it's gone; the original remains.
  await copy.getByTestId('broadcast-actions').click();
  await copy.getByTestId('broadcast-delete').click();
  await page.getByTestId('app-dialog').waitFor();
  await page.getByTestId('dialog-confirm').click();
  await expect(page.getByTestId('broadcast-item').filter({ hasText: 'Dup source (copy)' })).toHaveCount(0);
  await expect(page.getByTestId('broadcast-item').filter({ hasText: 'Dup source' })).toHaveCount(1);
});

test('clicking a SENT broadcast opens a read-only email preview', async ({ page }) => {
  await loginAs(page, DEV_MKT);
  await page.getByTestId('nav-broadcasts').click();
  await page.getByTestId('broadcast-composer').waitFor();
  await page.getByTestId('new-broadcast').click();
  await page.getByTestId('broadcast-wizard').waitFor();

  await page.getByTestId('broadcast-name').fill('Preview me');
  await page.getByTestId('broadcast-segment').selectOption({ index: 1 });
  await page.getByTestId('wizard-next').click();
  await page.getByTestId('broadcast-template').selectOption({ index: 1 });
  await page.getByTestId('wizard-next').click();
  await page.getByTestId('wizard-save').click(); // Send now
  await page.getByTestId('broadcast-composer').waitFor();

  // Open the SENT broadcast → a read-only preview (not the editable wizard).
  await page.getByTestId('broadcast-item').filter({ hasText: 'Preview me' }).getByTestId('broadcast-open').click();
  await page.getByTestId('broadcast-preview').waitFor();
  await expect(page.getByTestId('broadcast-wizard')).toHaveCount(0);
  await expect(page.getByTestId('preview-from')).toBeVisible();
  await expect(page.getByTestId('preview-subject')).toBeVisible();
  await expect(page.getByTestId('preview-body')).toBeVisible();

  await page.getByTestId('broadcasts-back').click();
  await page.getByTestId('broadcast-composer').waitFor();
});

test('Save as draft creates a draft — not sent, not scheduled', async ({ page }) => {
  await loginAs(page, DEV_MKT);
  await page.getByTestId('nav-broadcasts').click();
  await page.getByTestId('broadcast-composer').waitFor();
  await page.getByTestId('new-broadcast').click();
  await page.getByTestId('broadcast-wizard').waitFor();

  await page.getByTestId('broadcast-name').fill('Draft me');
  await page.getByTestId('broadcast-segment').selectOption({ index: 1 });
  await page.getByTestId('wizard-next').click();
  await page.getByTestId('broadcast-template').selectOption({ index: 1 });
  await page.getByTestId('wizard-next').click();

  // On the Schedule step, "Save as draft" persists WITHOUT sending or scheduling.
  await page.getByTestId('wizard-save-draft').click();
  await page.getByTestId('broadcast-composer').waitFor();

  const item = page.getByTestId('broadcast-item').filter({ hasText: 'Draft me' });
  await expect(item.getByTestId('broadcast-status')).toHaveText('draft');
  // A draft is editable and can be sent later from the list — both live in the ⋮ menu.
  await item.getByTestId('broadcast-actions').click();
  await expect(item.getByTestId('send-broadcast')).toBeVisible();
  await expect(item.getByTestId('broadcast-edit')).toBeVisible();
});

test('edit a scheduled broadcast (rename) — only drafts/scheduled are editable', async ({ page }) => {
  await loginAs(page, DEV_MKT);
  await page.getByTestId('nav-broadcasts').click();
  await page.getByTestId('broadcast-composer').waitFor();

  // Create a SCHEDULED (not-yet-sent, editable) broadcast to edit.
  await page.getByTestId('new-broadcast').click();
  await page.getByTestId('broadcast-wizard').waitFor();
  await page.getByTestId('broadcast-name').fill('Editable');
  await page.getByTestId('broadcast-segment').selectOption({ index: 1 });
  await page.getByTestId('wizard-next').click();
  await page.getByTestId('broadcast-template').selectOption({ index: 1 });
  await page.getByTestId('wizard-next').click();
  await page.getByTestId('schedule-mode').selectOption('later');
  await page.getByTestId('broadcast-scheduled-at').fill('2099-12-31T10:00');
  await page.getByTestId('wizard-save').click();
  await page.getByTestId('broadcast-composer').waitFor();

  // Open it via the ⋮ menu → Edit — the wizard hydrates from the saved broadcast.
  const editable = page.getByTestId('broadcast-item').filter({ hasText: 'Editable' });
  await editable.getByTestId('broadcast-actions').click();
  await editable.getByTestId('broadcast-edit').click();
  await page.getByTestId('broadcast-wizard').waitFor();
  await expect(page.getByTestId('broadcast-name')).toHaveValue('Editable');

  // Rename and save → the list reflects it.
  await page.getByTestId('broadcast-name').fill('Editable v2');
  await page.getByTestId('wizard-next').click();
  await page.getByTestId('wizard-next').click();
  await page.getByTestId('wizard-save').click();
  await page.getByTestId('broadcast-composer').waitFor();
  await expect(page.getByTestId('broadcast-list')).toContainText('Editable v2');
});

test('scheduling lets you pick a timezone and round-trips the send time in it', async ({ page }) => {
  await loginAs(page, DEV_MKT);
  await page.getByTestId('nav-broadcasts').click();
  await page.getByTestId('broadcast-composer').waitFor();
  await page.getByTestId('new-broadcast').click();
  await page.getByTestId('broadcast-wizard').waitFor();

  await page.getByTestId('broadcast-name').fill('Tokyo send');
  await page.getByTestId('broadcast-segment').selectOption({ index: 1 });
  await page.getByTestId('wizard-next').click();
  await page.getByTestId('broadcast-template').selectOption({ index: 1 });
  await page.getByTestId('wizard-next').click();

  // Schedule for a date/time IN a chosen timezone.
  await page.getByTestId('schedule-mode').selectOption('later');
  await page.getByTestId('broadcast-scheduled-at').fill('2099-06-15T09:00');
  await page.getByTestId('schedule-tz').selectOption('Asia/Tokyo');
  await page.getByTestId('wizard-save').click();
  await page.getByTestId('broadcast-composer').waitFor();

  // The list shows a live countdown to the scheduled send (far future → days).
  await expect(page.getByTestId('broadcast-item').filter({ hasText: 'Tokyo send' })).toContainText(
    /in \d+\s+(day|hour|minute)/,
  );

  // Re-open and jump to Schedule via the breadcrumb: the timezone and its
  // wall-clock time round-trip (independent of the browser's own zone — the
  // stored UTC instant is read back in Tokyo, which has no DST → 09:00).
  const tokyo = page.getByTestId('broadcast-item').filter({ hasText: 'Tokyo send' });
  await tokyo.getByTestId('broadcast-actions').click();
  await tokyo.getByTestId('broadcast-edit').click();
  await page.getByTestId('broadcast-wizard').waitFor();
  await page.getByTestId('wizard-step-2').click();
  await expect(page.getByTestId('schedule-tz')).toHaveValue('Asia/Tokyo');
  await expect(page.getByTestId('broadcast-scheduled-at')).toHaveValue('2099-06-15T09:00');
});

test('a broadcast cannot be scheduled sooner than 5 minutes from now', async ({ page }) => {
  await loginAs(page, DEV_MKT);
  await page.getByTestId('nav-broadcasts').click();
  await page.getByTestId('broadcast-composer').waitFor();
  await page.getByTestId('new-broadcast').click();
  await page.getByTestId('broadcast-wizard').waitFor();

  await page.getByTestId('broadcast-name').fill('Too soon');
  await page.getByTestId('broadcast-segment').selectOption({ index: 1 });
  await page.getByTestId('wizard-next').click();
  await page.getByTestId('broadcast-template').selectOption({ index: 1 });
  await page.getByTestId('wizard-next').click();

  // Choose "Schedule" and pick a clearly-past time → the gate trips: a hint shows
  // and the save button is disabled.
  await page.getByTestId('schedule-mode').selectOption('later');
  await page.getByTestId('broadcast-scheduled-at').fill('2020-01-01T10:00');
  await expect(page.getByTestId('schedule-too-early')).toBeVisible();
  await expect(page.getByTestId('wizard-save')).toBeDisabled();

  // A far-future time clears it → save is enabled again.
  await page.getByTestId('broadcast-scheduled-at').fill('2099-12-31T10:00');
  await expect(page.getByTestId('schedule-too-early')).toHaveCount(0);
  await expect(page.getByTestId('wizard-save')).toBeEnabled();
});

test('the step breadcrumbs jump to any reachable step (no clicking Next repeatedly)', async ({ page }) => {
  await loginAs(page, DEV_MKT);
  await page.getByTestId('nav-broadcasts').click();
  await page.getByTestId('broadcast-composer').waitFor();
  await page.getByTestId('new-broadcast').click();
  await page.getByTestId('broadcast-wizard').waitFor();

  // Initially only step 1 is reachable; steps 2 and 3 are disabled.
  await expect(page.getByTestId('wizard-step-1')).toBeDisabled();
  await expect(page.getByTestId('wizard-step-2')).toBeDisabled();

  // Complete Audience → step 2 becomes reachable; jump straight to it.
  await page.getByTestId('broadcast-name').fill('Breadcrumbs');
  await page.getByTestId('broadcast-segment').selectOption({ index: 1 });
  await expect(page.getByTestId('wizard-step-1')).toBeEnabled();
  await page.getByTestId('wizard-step-1').click();
  await expect(page.getByTestId('broadcast-template')).toBeVisible(); // on Content now

  // Attach an email → step 3 becomes reachable; jump to Schedule directly.
  await page.getByTestId('broadcast-template').selectOption({ index: 1 });
  await expect(page.getByTestId('email-instance')).toBeVisible();
  await expect(page.getByTestId('wizard-step-2')).toBeEnabled();
  await page.getByTestId('wizard-step-2').click();
  await expect(page.getByTestId('schedule-mode')).toBeVisible(); // on Schedule now

  // And jump back to Audience by clicking the first crumb.
  await page.getByTestId('wizard-step-0').click();
  await expect(page.getByTestId('broadcast-name')).toHaveValue('Breadcrumbs');
});

test('design an email from the broadcast wizard and return with it selected', async ({ page }) => {
  await loginAs(page, DEV_MKT);
  await page.getByTestId('nav-broadcasts').click();
  await page.getByTestId('broadcast-composer').waitFor();
  await page.getByTestId('new-broadcast').click();
  await page.getByTestId('broadcast-wizard').waitFor();

  // Step 1 — audience.
  await page.getByTestId('broadcast-name').fill('With design');
  await page.getByTestId('broadcast-segment').selectOption({ index: 1 });
  await page.getByTestId('wizard-next').click();

  // Step 2 — no email yet, so choose a starting point. "Start from a blank design"
  // persists a draft and opens the designer in a sliding DRAWER over the wizard
  // (the wizard stays mounted — no navigation away from the broadcast).
  await page.getByTestId('design-email').click();
  await page.getByTestId('email-designer-drawer').waitFor();
  await page.getByTestId('email-editor').waitFor();
  // This is the broadcast's OWN email copy, not a library template: it reads as an
  // email (it HAS a From/To/Subject envelope) and closes via "Save & close".
  await expect(page.getByRole('heading', { name: 'Design email', exact: true })).toBeVisible();
  await expect(page.getByTestId('editor-back')).toContainText('Save & close');
  await expect(page.getByTestId('email-subject')).toBeVisible();
  await page.getByTestId('email-subject').fill('Spring promo subject');
  // The From is mandatory — intentionally choose a real named sender (there is no
  // no-reply fallback).
  await page.getByTestId('email-sender').selectOption({ index: 1 });
  const senderValue = await page.getByTestId('email-sender').inputValue();
  expect(senderValue).not.toBe('');
  await page.getByTestId('toolbox-text').click();
  await expect(page.getByTestId('mjml-output')).toHaveValue(/^<mjml>/);
  // The working copy autosaves.
  await expect(page.getByTestId('template-saved')).toBeVisible({ timeout: 10_000 });
  await page.getByTestId('template-name').fill('Designed in wizard');

  // Save & close flushes the pending change, closes the drawer, and returns to the
  // wizard. The Content step now shows this broadcast's OWN email (the instance) —
  // no template picker any more, just the copy with Edit/Start over.
  await page.getByTestId('editor-back').click();
  await expect(page.getByTestId('email-designer-drawer')).toHaveCount(0);
  await page.getByTestId('broadcast-wizard').waitFor();
  await expect(page.getByTestId('email-instance')).toContainText('Designed in wizard');
  await expect(page.getByTestId('broadcast-template')).toHaveCount(0); // no re-choosing a template

  // Finish: schedule (manual) and save → the broadcast appears in the list.
  await page.getByTestId('wizard-next').click();
  await page.getByTestId('wizard-save').click();
  await page.getByTestId('broadcast-composer').waitFor();
  await expect(page.getByTestId('broadcast-list')).toContainText('With design');

  // The working copy is NOT a library template — the Templates list excludes it.
  await page.getByTestId('nav-templates').click();
  await page.getByTestId('templates-screen').waitFor();
  await expect(page.getByTestId('templates-screen')).not.toContainText('Designed in wizard');
});

test('the From is mandatory — the Content step is gated until a sender is intentionally chosen', async ({ page }) => {
  await loginAs(page, DEV_MKT);
  await page.getByTestId('nav-broadcasts').click();
  await page.getByTestId('broadcast-composer').waitFor();
  await page.getByTestId('new-broadcast').click();
  await page.getByTestId('broadcast-wizard').waitFor();

  await page.getByTestId('broadcast-name').fill('Needs a sender');
  await page.getByTestId('broadcast-segment').selectOption({ index: 1 });
  await page.getByTestId('wizard-next').click();

  // Design a blank email with a subject but DON'T choose a From.
  await page.getByTestId('design-email').click();
  await page.getByTestId('email-editor').waitFor();
  await page.getByTestId('email-subject').fill('Has subject, no sender');
  await page.getByTestId('toolbox-text').click();
  await expect(page.getByTestId('template-saved')).toBeVisible({ timeout: 10_000 });
  await page.getByTestId('editor-back').click();
  await page.getByTestId('broadcast-wizard').waitFor();

  // Content step is INCOMPLETE: the email has no From, so the step is gated — the
  // Next button and the Schedule breadcrumb are both disabled, and a hint says so.
  await expect(page.getByTestId('email-incomplete')).toBeVisible();
  await expect(page.getByTestId('email-incomplete')).toContainText(/from/i);
  await expect(page.getByTestId('wizard-next')).toBeDisabled();
  await expect(page.getByTestId('wizard-step-2')).toBeDisabled();

  // Intentionally choose a real named From → the step becomes complete and reachable.
  await page.getByTestId('design-email').click(); // Edit email
  await page.getByTestId('email-editor').waitFor();
  await page.getByTestId('email-sender').selectOption({ index: 1 });
  await expect(page.getByTestId('template-saved')).toBeVisible({ timeout: 10_000 });
  await page.getByTestId('editor-back').click();
  await page.getByTestId('broadcast-wizard').waitFor();
  await expect(page.getByTestId('email-complete')).toBeVisible();
  await expect(page.getByTestId('wizard-next')).toBeEnabled();

  // Now it can advance to Schedule and send.
  await page.getByTestId('wizard-step-2').click();
  await page.getByTestId('wizard-save').click();
  await page.getByTestId('broadcast-composer').waitFor();
  await expect(page.getByTestId('broadcast-list')).toContainText('Needs a sender');
});

test('returning from the email designer lands back on the Content step (not Audience)', async ({ page }) => {
  await loginAs(page, DEV_MKT);
  await page.getByTestId('nav-broadcasts').click();
  await page.getByTestId('broadcast-composer').waitFor();
  await page.getByTestId('new-broadcast').click();
  await page.getByTestId('broadcast-wizard').waitFor();

  // Step 1 — audience, then on to Content.
  await page.getByTestId('broadcast-name').fill('Return to content');
  await page.getByTestId('broadcast-segment').selectOption({ index: 1 });
  await page.getByTestId('wizard-next').click();

  // Open the blank designer and immediately go Back WITHOUT designing/saving.
  await page.getByTestId('design-email').click();
  await page.getByTestId('email-editor').waitFor();
  await page.getByTestId('editor-back').click();

  // Back on the wizard at the CONTENT step (step 2) — not bounced to Audience.
  await page.getByTestId('broadcast-wizard').waitFor();
  await expect(page.getByTestId('broadcast-template')).toBeVisible(); // Content-step UI
  await expect(page.getByTestId('broadcast-name')).toHaveCount(0); // NOT the Audience step
});

test('build and save a campaign workflow', async ({ page }) => {
  await loginAs(page, DEV_MKT);
  await page.getByTestId('nav-campaigns').click();
  // Campaigns is now a LIST; New campaign → the SEPARATE /campaigns/new builder.
  await page.getByTestId('campaigns-list-screen').waitFor();

  await page.getByTestId('campaign-new').click();
  await page.getByTestId('campaign-builder').waitFor();
  await page.getByTestId('campaign-name').fill('Onboarding journey');
  // Insert a wait step on the starter trigger→exit edge via the (+) palette →
  // graph becomes trigger→wait→exit.
  await page.getByTestId('campaign-edge-insert').first().click();
  await page.getByTestId('campaign-palette').waitFor();
  await page.getByTestId('palette-wait').click();
  await expect(page.getByTestId('node-wait')).toBeVisible();

  await page.getByTestId('save-campaign').click();
  await expect(page.getByTestId('toast')).toBeVisible();
  // Back on the list, the saved campaign appears (server validated the definition).
  await page.getByTestId('campaigns-back').click();
  await expect(page.getByTestId('campaign-item').first()).toBeVisible();
});
