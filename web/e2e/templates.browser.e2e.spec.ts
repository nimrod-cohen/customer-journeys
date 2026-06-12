// E2E (real Chromium): email templates have a home (the Templates list) and the
// designer SAVES + LOADS the design (the editable source of truth). §11/§12.
import { test, expect } from '@playwright/test';
import { loginAs } from './helpers.js';
import { DEV_MKT } from './seed.js';

test('create a template in the designer, then re-open it to edit', async ({ page }) => {
  await loginAs(page, DEV_MKT);
  await page.getByTestId('nav-templates').click();
  await page.getByTestId('templates-screen').waitFor();

  // New template → the designer; build a heading + button via click-to-add.
  await page.getByTestId('new-template').click();
  await page.getByTestId('email-editor').waitFor();
  await page.getByTestId('toolbox-heading').click();
  await page.getByTestId('toolbox-button').click();
  await expect(page.getByTestId('canvas-element')).toHaveCount(2);

  await page.getByTestId('template-name').fill('Newsletter');
  await page.getByTestId('save-template').click();

  // Save STAYS in the designer (a new template moves to its /editor/:id URL).
  await expect(page.getByTestId('template-saved')).toBeVisible();
  await expect(page.getByTestId('email-editor')).toBeVisible();

  // It's in the Templates list; re-opening hydrates the DESIGN (both elements).
  await page.getByTestId('editor-back').click();
  await page.getByTestId('templates-screen').waitFor();
  await expect(page.getByTestId('template-list')).toContainText('Newsletter');
  await page.getByTestId('template-item').filter({ hasText: 'Newsletter' }).getByTestId('template-edit').click();
  await page.getByTestId('email-editor').waitFor();
  await expect(page.getByTestId('template-name')).toHaveValue('Newsletter');
  await expect(page.getByTestId('canvas-element')).toHaveCount(2);
  await expect(page.getByTestId('mjml-output')).toHaveValue(/<mj-button/);
});

test('Asset management screen: templates and image-gallery tabs share the screen', async ({ page }) => {
  await loginAs(page, DEV_MKT);

  // The sidebar item is "Asset management" (same nav id / route).
  await expect(page.getByTestId('nav-templates')).toHaveText('Asset management');
  await page.getByTestId('nav-templates').click();
  await page.getByTestId('templates-screen').waitFor();

  // Default tab = email templates: the list + "New template" action.
  await expect(page.getByTestId('template-list')).toBeVisible();
  await expect(page.getByTestId('new-template')).toBeVisible();

  // Image-gallery tab embeds the SAME AssetManagerPanel (manager toolbar:
  // search, New Folder, Upload) — no modal, no Select-Asset header.
  await page.getByTestId('assets-tab-gallery').click();
  await page.getByTestId('asset-manager-panel').waitFor();
  await expect(page.getByTestId('am-upload')).toBeVisible();
  await expect(page.getByTestId('am-new-folder')).toBeVisible();
  await expect(page.getByTestId('new-template')).toHaveCount(0);

  // Management works embedded: create a folder via the styled dialog…
  await page.getByTestId('am-new-folder').click();
  await page.getByTestId('dialog-input').fill('embedded-tab');
  await page.getByTestId('dialog-confirm').click();
  // …New Folder steps INTO the folder; breadcrumb shows it.
  await expect(page.getByTestId('am-breadcrumb')).toContainText('embedded-tab');

  // Back to the templates tab: the list returns.
  await page.getByTestId('assets-tab-templates').click();
  await expect(page.getByTestId('template-list')).toBeVisible();
  await expect(page.getByTestId('asset-manager-panel')).toHaveCount(0);
});

test('mark a template RTL (right-to-left) and it round-trips', async ({ page }) => {
  await loginAs(page, DEV_MKT);
  await page.getByTestId('nav-templates').click();
  await page.getByTestId('templates-screen').waitFor();
  await page.getByTestId('new-template').click();
  await page.getByTestId('email-editor').waitFor();

  await page.getByTestId('toolbox-text').click();
  await page.getByTestId('template-name').fill('Hebrew news');

  // Template settings → direction RTL: the canvas flips AND the emitted MJML
  // carries the document-level RTL head (cdp-rtl).
  await page.getByTestId('tab-template').click();
  await page.getByTestId('settings-direction').selectOption('rtl');
  await expect(page.getByTestId('mjml-output')).toHaveValue(/cdp-rtl/);
  await expect(page.locator('.nm-canvas-page')).toHaveAttribute('dir', 'rtl');

  await page.getByTestId('save-template').click();
  await expect(page.getByTestId('template-saved')).toBeVisible();

  // Re-open → RTL came back from the stored design.
  await page.getByTestId('editor-back').click();
  await page.getByTestId('templates-screen').waitFor();
  await page.getByTestId('template-item').filter({ hasText: 'Hebrew news' }).getByTestId('template-edit').click();
  await page.getByTestId('email-editor').waitFor();
  await expect(page.locator('.nm-canvas-page')).toHaveAttribute('dir', 'rtl');
  await page.getByTestId('tab-template').click();
  await expect(page.getByTestId('settings-direction')).toHaveValue('rtl');
});
