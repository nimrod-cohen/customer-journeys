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

test('viewport preview: mobile narrows the frame and stacks grid columns', async ({ page }) => {
  await openDesigner(page);

  // A 2-column grid renders side-by-side on desktop.
  await page.getByTestId('toolbox-grid').click();
  const grid = page.locator('.nm-grid');
  await expect(grid).toHaveCSS('flex-direction', 'row');

  // Mobile preview: the canvas page narrows to phone width and columns STACK
  // (exactly what MJML's responsive output does below its breakpoint).
  await page.getByTestId('viewport-mobile').click();
  await expect(page.locator('.nm-canvas-page')).toHaveCSS('width', '375px');
  await expect(grid).toHaveCSS('flex-direction', 'column');

  // Tablet/desktop: the email body returns to its design width (600px default;
  // assert the style — the computed width may clamp to the available column).
  await page.getByTestId('viewport-tablet').click();
  await expect(page.locator('.nm-canvas-page')).toHaveAttribute('style', /width: 600px/);
  await page.getByTestId('viewport-desktop').click();
  await expect(page.locator('.nm-canvas-page')).toHaveAttribute('style', /width: 600px/);
  await expect(grid).toHaveCSS('flex-direction', 'row');
});

test('image gallery: uploads land in folders and can be reused', async ({ page }) => {
  await openDesigner(page);

  // First image element: UPLOAD a real png into the "logos" folder.
  await page.getByTestId('toolbox-image').click();
  await page.getByTestId('canvas-element').click();
  await page.getByTestId('asset-folder').fill('logos');
  await page.getByTestId('asset-file').setInputFiles({
    name: 'pixel.png',
    mimeType: 'image/png',
    buffer: Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
      'base64',
    ),
  });
  // The upload commits the served asset URL as the image src.
  await expect(page.getByTestId('asset-url')).toHaveValue(/\/assets\//);

  // Second image element: pick the SAME image from the gallery's folder.
  await page.getByTestId('tab-add').click(); // back to the toolbox
  await page.getByTestId('toolbox-image').click();
  await page.getByTestId('canvas-element').nth(1).click();
  await page.getByTestId('gallery-toggle').click();
  await page.getByTestId('asset-gallery').waitFor();
  await page.getByTestId('gallery-folder').filter({ hasText: 'logos' }).click();
  await page.getByTestId('gallery-item').filter({ hasText: 'pixel.png' }).click();
  await expect(page.getByTestId('asset-url')).toHaveValue(/\/assets\//);

  // Both serialize as mj-image with asset URLs.
  const mjml = await page.getByTestId('mjml-output').inputValue();
  expect(mjml.match(/<mj-image/g)?.length).toBe(2);
});

test('the text toolbar sits right above the text element, right-aligned', async ({ page }) => {
  await openDesigner(page);
  await page.getByTestId('toolbox-text').click();

  // Focus the text → the formatting toolbar appears.
  await page.getByTestId('text-editable').click();
  const toolbar = page.getByTestId('rte-toolbar');
  await toolbar.waitFor();

  const tb = (await toolbar.boundingBox())!;
  const txt = (await page.getByTestId('text-editable').boundingBox())!;
  // Right edges align (±2px) and the toolbar sits immediately above the text.
  expect(Math.abs(tb.x + tb.width - (txt.x + txt.width))).toBeLessThanOrEqual(2);
  expect(tb.y + tb.height).toBeLessThanOrEqual(txt.y);
  expect(txt.y - (tb.y + tb.height)).toBeLessThanOrEqual(12);
});
