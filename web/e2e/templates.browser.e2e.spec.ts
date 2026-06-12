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

  // Save STAYS in the editor (a new template moves to its /editor/:id URL). The
  // saved design reloaded from the server — name + image are present.
  await expect(page.getByTestId('email-editor')).toBeVisible();
  await expect(page.getByTestId('template-name')).toHaveValue('Newsletter');
  await expect(page.getByTestId('mjml-output')).toHaveValue(/<mj-image/, { timeout: 20_000 });

  // It's in the Templates list too.
  await page.getByTestId('editor-back').click();
  await page.getByTestId('templates-screen').waitFor();
  await expect(page.getByTestId('template-list')).toContainText('Newsletter');
});

test('mark a template RTL (right-to-left) and it round-trips', async ({ page }) => {
  await loginAs(page, DEV_MKT);
  await page.getByTestId('nav-templates').click();
  await page.getByTestId('templates-screen').waitFor();
  await page.getByTestId('new-template').click();
  await page.getByTestId('email-editor').waitFor();
  await expect(page.getByTestId('mjml-output')).toHaveValue(/<mj-body/, { timeout: 20_000 });

  await page.getByTestId('template-name').fill('Hebrew news');
  // Toggle RTL → the emitted MJML carries the document-level RTL head AND the
  // canvas preview flips to right-to-left so bidi renders correctly.
  await page.getByTestId('rtl-toggle').check();
  await expect(page.getByTestId('mjml-output')).toHaveValue(/cdp-rtl/);
  await expect(page.frameLocator('iframe.gjs-frame').locator('body')).toHaveAttribute('dir', 'rtl');
  await page.getByTestId('save-template').click();

  // Save stays in the editor; the new template reloads from /editor/:id and RTL is
  // detected from the stored doc (toggle stays checked, canvas stays RTL).
  await expect(page.getByTestId('rtl-toggle')).toBeChecked();
  await expect(page.frameLocator('iframe.gjs-frame').locator('body')).toHaveAttribute('dir', 'rtl');
});
