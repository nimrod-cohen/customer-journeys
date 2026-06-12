// §11 / §16A tier 3 (browser): the custom email designer renders in REAL
// Chromium and EMITS MJML — the browser tier of the "emit MJML, never
// hand-rolled HTML" invariant (unit: email-designer-serializer; integration:
// save-template). Click-to-add keeps the flow drag-free and deterministic.
import { test, expect } from '@playwright/test';
import { loginAs } from './helpers.js';
import { DEV_MKT } from './seed.js';

async function openDesigner(page: import('@playwright/test').Page): Promise<void> {
  await loginAs(page, DEV_MKT);
  await page.getByTestId('nav-templates').click();
  await page.getByTestId('templates-screen').waitFor();
  await page.getByTestId('new-template').click();
  await page.getByTestId('email-editor').waitFor();
  await expect(page.getByTestId('email-designer-component')).toBeVisible();
}

test('the designer renders and emits MJML rooted at <mjml>', async ({ page }) => {
  await openDesigner(page);

  // Click-to-add a text component → a row + element appear on the canvas.
  await page.getByTestId('toolbox-text').click();
  await expect(page.getByTestId('canvas-row')).toHaveCount(1);
  await expect(page.getByTestId('canvas-element')).toHaveCount(1);

  // The live MJML output is rooted at <mjml> — never hand-rolled email HTML.
  const output = page.getByTestId('mjml-output');
  await expect(output).toHaveValue(/^<mjml>/);
  const mjml = await output.inputValue();
  expect(mjml).toContain('<mj-body');
  expect(mjml).toContain('<mj-text');
  expect(mjml).not.toMatch(/<!DOCTYPE|<html/i);
});

test('an image element serializes as <mj-image src> referencing its URL', async ({ page }) => {
  await openDesigner(page);

  await page.getByTestId('toolbox-image').click();
  // Click the element on the canvas → the properties panel shows the URL field.
  await page.getByTestId('canvas-element').click();
  await page.getByTestId('asset-url').fill('https://images.cdp.example/ws/sample-hero.png');
  await page.keyboard.press('Tab');

  const output = page.getByTestId('mjml-output');
  await expect(output).toHaveValue(/<mj-image/);
  const mjml = await output.inputValue();
  expect(mjml).toContain('https://images.cdp.example/ws/sample-hero.png');
});
