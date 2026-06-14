// E2E (real Chromium): compose + send a broadcast, and build + save a campaign
// (§12, §9A, §9B). The broadcast targets the seeded manual segment + template and
// sends through the real broadcast core (SQS mocked locally) → status flips. The
// campaign builder assembles a trigger→wait→send→exit graph that the server
// validates and persists. Proven in a real browser against real Postgres.
import { test, expect } from '@playwright/test';
import { loginAs } from './helpers.js';
import { DEV_MKT } from './seed.js';

test('create a broadcast via the wizard, then send it', async ({ page }) => {
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
  // Step 2 — content: the seeded template.
  await page.getByTestId('broadcast-template').selectOption({ index: 1 });
  await page.getByTestId('wizard-next').click();
  // Step 3 — schedule (send manually = draft) and save.
  await page.getByTestId('wizard-save').click();

  // Back on the list; the new broadcast appears — send it and confirm a result.
  await page.getByTestId('broadcast-composer').waitFor();
  await expect(page.getByTestId('broadcast-list')).toContainText('Spring sale');
  const item = page.getByTestId('broadcast-item').filter({ hasText: 'Spring sale' });
  await item.getByTestId('send-broadcast').click();
  // Feedback is a floating toast (always in view, regardless of list length).
  await expect(page.getByTestId('toast')).toBeVisible();
  // Once sent, the row shows its metrics columns (0s locally — the dispatcher
  // that records delivered/clicked doesn't run in dev).
  await expect(item.getByTestId('broadcast-metrics')).toBeVisible();
  await expect(item.getByTestId('broadcast-metrics')).toContainText('Delivered');
});

test('edit a draft broadcast (rename) — only drafts/scheduled are editable', async ({ page }) => {
  await loginAs(page, DEV_MKT);
  await page.getByTestId('nav-broadcasts').click();
  await page.getByTestId('broadcast-composer').waitFor();

  // Create a draft to edit.
  await page.getByTestId('new-broadcast').click();
  await page.getByTestId('broadcast-wizard').waitFor();
  await page.getByTestId('broadcast-name').fill('Editable');
  await page.getByTestId('broadcast-segment').selectOption({ index: 1 });
  await page.getByTestId('wizard-next').click();
  await page.getByTestId('broadcast-template').selectOption({ index: 1 });
  await page.getByTestId('wizard-next').click();
  await page.getByTestId('wizard-save').click();
  await page.getByTestId('broadcast-composer').waitFor();

  // Open it via Edit — the wizard hydrates from the saved broadcast.
  await page.getByTestId('broadcast-item').filter({ hasText: 'Editable' }).getByTestId('broadcast-edit').click();
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

  // Step 2 — "Design email" persists a draft and opens the designer.
  await page.getByTestId('design-email').click();
  await page.getByTestId('email-editor').waitFor();
  // This is the broadcast's OWN email copy, not a library template: it reads as
  // an email and its Back returns to the broadcast (not the template library).
  await expect(page.getByRole('heading', { name: 'Edit email', exact: true })).toBeVisible();
  await expect(page.getByTestId('editor-back')).toContainText('Back to broadcast');
  await page.getByTestId('toolbox-text').click();
  await expect(page.getByTestId('mjml-output')).toHaveValue(/^<mjml>/);
  await page.getByTestId('template-name').fill('Designed in wizard');

  // No manual save — Back flushes the pending change and returns to the wizard
  // with the new template selected on the Content step (the broadcast's COPY).
  await page.getByTestId('editor-back').click();
  await page.getByTestId('broadcast-wizard').waitFor();
  await expect(page.getByTestId('broadcast-template')).not.toHaveValue('');
  await expect(page.getByTestId('broadcast-template')).toContainText("this broadcast's copy");

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
