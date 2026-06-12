// E2E (real Chromium): email templates have a home (the Templates list) and the
// editor SAVES + LOADS them. Create a template, see it listed, then re-open it
// for editing (the name hydrates). §11/§12.
import { test, expect } from '@playwright/test';
import { loginAs } from './helpers.js';
import { DEV_MKT } from './seed.js';

test('create an email template, then re-open it to edit', async ({ page }) => {
  await loginAs(page, DEV_MKT);
  await page.getByTestId('nav-templates').click();
  await page.getByTestId('templates-screen').waitFor();

  // New template → the editor.
  await page.getByTestId('new-template').click();
  await page.getByTestId('email-editor').waitFor();
  await expect(page.getByTestId('gjs-host')).toBeVisible();
  // Wait for the editor to emit MJML before saving — and it must include an
  // <mj-body> so the canvas has a valid drop target for dragged blocks.
  await expect(page.getByTestId('mjml-output')).toHaveValue(/<mj-body/, { timeout: 20_000 });

  await page.getByTestId('template-name').fill('Newsletter');
  // Make a DESIGN change (insert an image) and save WITHOUT manually refreshing —
  // the saved MJML must capture the edit, not a stale snapshot.
  await page.getByTestId('insert-image').click();
  await page.getByTestId('save-template').click();

  // Back on the list; the template appears.
  await page.getByTestId('templates-screen').waitFor();
  await expect(page.getByTestId('template-list')).toContainText('Newsletter');

  // Re-open it — the editor hydrates the name AND the saved design (the image).
  await page.getByTestId('template-item').filter({ hasText: 'Newsletter' }).getByTestId('template-edit').click();
  await page.getByTestId('email-editor').waitFor();
  await expect(page.getByTestId('template-name')).toHaveValue('Newsletter');
  await expect(page.getByTestId('mjml-output')).toHaveValue(/<mj-image/, { timeout: 20_000 });
});

test('mark a template RTL (right-to-left) and it round-trips', async ({ page }) => {
  await loginAs(page, DEV_MKT);
  await page.getByTestId('nav-templates').click();
  await page.getByTestId('templates-screen').waitFor();
  await page.getByTestId('new-template').click();
  await page.getByTestId('email-editor').waitFor();
  await expect(page.getByTestId('mjml-output')).toHaveValue(/<mj-body/, { timeout: 20_000 });

  await page.getByTestId('template-name').fill('Hebrew news');
  // Toggle RTL → the emitted MJML carries the document-level RTL head.
  await page.getByTestId('rtl-toggle').check();
  await expect(page.getByTestId('mjml-output')).toHaveValue(/cdp-rtl/);
  await page.getByTestId('save-template').click();
  await page.getByTestId('templates-screen').waitFor();

  // Re-open → RTL is detected from the stored doc (toggle stays checked).
  await page.getByTestId('template-item').filter({ hasText: 'Hebrew news' }).getByTestId('template-edit').click();
  await page.getByTestId('email-editor').waitFor();
  await expect(page.getByTestId('rtl-toggle')).toBeChecked();
});
