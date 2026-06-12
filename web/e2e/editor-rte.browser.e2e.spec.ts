// E2E (real Chromium): the email editor's rich-text toolbar (shown when a text
// block is double-clicked) exposes the formatting actions we added — alignment,
// bulleted/numbered lists, and a font-size select — beyond the GrapesJS defaults
// (bold/italic/underline/link). §11.
import { test, expect } from '@playwright/test';
import { loginAs } from './helpers.js';
import { DEV_MKT } from './seed.js';

test('the rich-text toolbar exposes alignment, lists and font size on a text block', async ({ page }) => {
  await loginAs(page, DEV_MKT);
  await page.getByTestId('nav-templates').click();
  await page.getByTestId('templates-screen').waitFor();
  await page.getByTestId('new-template').click();
  await page.getByTestId('email-editor').waitFor();
  await expect(page.getByTestId('mjml-output')).toHaveValue(/<mj-body/, { timeout: 20_000 });

  const frame = page.frameLocator('iframe.gjs-frame');
  await frame.getByText('Welcome to the CDP editor').dblclick();
  await expect(page.locator('.gjs-rte-toolbar [title="Align right"]')).toBeVisible({ timeout: 10_000 });
  await expect(page.locator('.gjs-rte-toolbar [title="Bulleted list"]')).toBeVisible();
  await expect(page.locator('.gjs-rte-toolbar select[title="Font size"]')).toBeVisible();
});
