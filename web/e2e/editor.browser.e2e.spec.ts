// §11 / §16A tier 3 (browser): the custom email designer renders in REAL
// Chromium and EMITS MJML — the browser tier of the "emit MJML, never
// hand-rolled HTML" invariant (unit: email-designer-serializer; integration:
// save-template). Click-to-add keeps the flow drag-free and deterministic.
import { test, expect } from '@playwright/test';
import { loginAs } from './helpers.js';
import { DEV_MKT } from './seed.js';

// A real 48×48 RGB gradient PNG (so the image editor's crop + canvas work on
// meaningful pixels, unlike the 1×1 fixtures used by the gallery tests).
const BIG_PNG_B64 =
  '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';

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

test('duplicate an element — via the Properties button and the Cmd/Ctrl+D shortcut', async ({ page }) => {
  await openDesigner(page);

  // Use an image (not contenteditable) so neither the floating text toolbar nor
  // focus suppresses the canvas keyboard shortcut.
  await page.getByTestId('toolbox-image').click();
  await expect(page.getByTestId('canvas-element')).toHaveCount(1);

  // Select it → the Properties "Duplicate" button clones it.
  await page.getByTestId('canvas-element').first().click();
  await page.getByTestId('duplicate-node').click();
  await expect(page.getByTestId('canvas-element')).toHaveCount(2);

  // The keyboard shortcut duplicates the SELECTED element too.
  await page.getByTestId('canvas-element').last().click();
  await page.keyboard.press('ControlOrMeta+d');
  await expect(page.getByTestId('canvas-element')).toHaveCount(3);
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

test('asset manager: create a folder, upload into it, reuse from the gallery', async ({ page }) => {
  await openDesigner(page);

  // First image element → "Select image…" opens the Select Asset modal.
  await page.getByTestId('toolbox-image').click();
  await page.getByTestId('canvas-element').click();
  await page.getByTestId('asset-select').click();
  await page.getByTestId('asset-manager').waitFor();

  // New Folder ("logos") via the styled dialog → steps into it; upload lands there.
  await page.getByTestId('am-new-folder').click();
  await page.getByTestId('dialog-input').fill('logos');
  await page.getByTestId('dialog-confirm').click();
  await expect(page.getByTestId('am-breadcrumb')).toContainText('logos');
  await page.getByTestId('am-file-input').setInputFiles({
    name: 'pixel.png',
    mimeType: 'image/png',
    buffer: Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
      'base64',
    ),
  });
  // Inside a folder a [..] parent card is offered (click = up, drop = move out).
  await expect(page.getByTestId('am-up-card')).toBeVisible();
  // The upload appears in the folder; clicking it selects + closes the modal.
  await page.getByTestId('am-item').filter({ hasText: 'pixel.png' }).click();
  await expect(page.getByTestId('asset-url')).toHaveValue(/\/assets\//);

  // Second image element: reuse the SAME image via the folder card.
  await page.getByTestId('tab-add').click();
  await page.getByTestId('toolbox-image').click();
  await page.getByTestId('canvas-element').nth(1).click();
  await page.getByTestId('asset-select').click();
  await page.getByTestId('asset-manager').waitFor();
  await page.getByTestId('am-folder-card').filter({ hasText: 'logos' }).click();
  await page.getByTestId('am-item').filter({ hasText: 'pixel.png' }).click();
  await expect(page.getByTestId('asset-url')).toHaveValue(/\/assets\//);

  // Both serialize as mj-image with asset URLs.
  const mjml = await page.getByTestId('mjml-output').inputValue();
  expect(mjml.match(/<mj-image/g)?.length).toBe(2);
});

test('asset manager: rename, drag-to-move and delete images and folders', async ({ page }) => {
  await openDesigner(page);
  await page.getByTestId('toolbox-image').click();
  await page.getByTestId('canvas-element').click();
  await page.getByTestId('asset-select').click();
  await page.getByTestId('asset-manager').waitFor();

  // Upload at root.
  await page.getByTestId('am-file-input').setInputFiles({
    name: 'mgmt.png',
    mimeType: 'image/png',
    buffer: Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
      'base64',
    ),
  });
  const item = page.getByTestId('am-item').filter({ hasText: 'mgmt.png' });
  await item.waitFor();

  // Rename via the styled dialog.
  await item.getByTestId('am-item-rename').click();
  await page.getByTestId('dialog-input').fill('final.png');
  await page.getByTestId('dialog-confirm').click();
  const renamed = page.getByTestId('am-item').filter({ hasText: 'final.png' });
  await renamed.waitFor();

  // Create a folder (steps in), go back to root.
  await page.getByTestId('am-new-folder').click();
  await page.getByTestId('dialog-input').fill('archive');
  await page.getByTestId('dialog-confirm').click();
  await page.getByTestId('am-breadcrumb').getByText('All files').click();

  // DRAG the image onto the folder card to move it (HTML5 dnd via dispatched events).
  const dataTransfer = await page.evaluateHandle(() => new DataTransfer());
  await renamed.dispatchEvent('dragstart', { dataTransfer });
  const folderCard = page.getByTestId('am-folder-card').filter({ hasText: 'archive' });
  await folderCard.dispatchEvent('dragover', { dataTransfer });
  await folderCard.dispatchEvent('drop', { dataTransfer });
  await expect(folderCard).toContainText('1 item');

  // Inside the folder: DRAG it onto [..] to move it back out to the root.
  await folderCard.click();
  const inFolder = page.getByTestId('am-item').filter({ hasText: 'final.png' });
  await inFolder.waitFor();
  const dt2 = await page.evaluateHandle(() => new DataTransfer());
  await inFolder.dispatchEvent('dragstart', { dataTransfer: dt2 });
  await page.getByTestId('am-up-card').dispatchEvent('dragover', { dataTransfer: dt2 });
  await page.getByTestId('am-up-card').dispatchEvent('drop', { dataTransfer: dt2 });
  await expect(page.getByTestId('am-item')).toHaveCount(0);

  // Back at root: the image is there; delete it (styled danger confirm).
  await page.getByTestId('am-breadcrumb').getByText('All files').click();
  await page.getByTestId('am-item').filter({ hasText: 'final.png' }).getByTestId('am-item-delete').click();
  await page.getByTestId('dialog-confirm').click();
  await expect(page.getByTestId('am-item').filter({ hasText: 'final.png' })).toHaveCount(0);

  // Delete the empty folder (styled confirm; images would move to parent).
  await page.getByTestId('am-folder-card').filter({ hasText: 'archive' }).getByTestId('am-folder-delete').click();
  await page.getByTestId('dialog-confirm').click();
  await expect(page.getByTestId('am-folder-card').filter({ hasText: 'archive' })).toHaveCount(0);
});

test('image editor: crop to a circle bakes a new asset and resizes the image', async ({ page }) => {
  await openDesigner(page);

  // Add an image and select a real (48×48) uploaded asset.
  await page.getByTestId('toolbox-image').click();
  await page.getByTestId('canvas-element').click();
  await page.getByTestId('asset-select').click();
  await page.getByTestId('asset-manager').waitFor();
  await page.getByTestId('am-file-input').setInputFiles({
    name: 'photo.png',
    mimeType: 'image/png',
    // 48×48 gradient PNG (real dimensions so crop/canvas are meaningful).
    buffer: Buffer.from(BIG_PNG_B64, 'base64'),
  });
  await page.getByTestId('am-item').filter({ hasText: 'photo.png' }).click();
  const srcBefore = await page.getByTestId('asset-url').inputValue();
  expect(srcBefore).toMatch(/\/assets\//);

  // Open the crop/resize editor → choose Circle → set output width → Apply.
  await page.getByTestId('image-edit-open').click();
  await page.getByTestId('image-editor').waitFor();
  await page.getByTestId('imgedit-circle').click();
  await page.getByTestId('imgedit-width').fill('64');
  await page.getByTestId('imgedit-apply').click();

  // The editor closes and the element now points at a NEW (edited) asset…
  await expect(page.getByTestId('image-editor')).toHaveCount(0);
  await expect(page.getByTestId('asset-url')).toHaveValue(/\/assets\//);
  const srcAfter = await page.getByTestId('asset-url').inputValue();
  expect(srcAfter).not.toBe(srcBefore);
  // …and it still serializes as an mj-image at the chosen 64px width.
  await expect(page.getByTestId('mjml-output')).toHaveValue(/<mj-image[^>]*width="64px"/);
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
  const canvasBox = (await page.locator('.nm-canvas').boundingBox())!;
  // Right edges align (±2px); the toolbar starts at/above the text and never
  // escapes the canvas area (it clamps to the canvas top when space is tight).
  expect(Math.abs(tb.x + tb.width - (txt.x + txt.width))).toBeLessThanOrEqual(2);
  expect(tb.y).toBeLessThanOrEqual(txt.y);
  expect(tb.y).toBeGreaterThanOrEqual(canvasBox.y);
});

test('asset manager: upload multiple files at once', async ({ page }) => {
  await openDesigner(page);
  await page.getByTestId('toolbox-image').click();
  await page.getByTestId('canvas-element').click();
  await page.getByTestId('asset-select').click();
  await page.getByTestId('asset-manager').waitFor();

  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
    'base64',
  );
  await page.getByTestId('am-file-input').setInputFiles([
    { name: 'batch-1.png', mimeType: 'image/png', buffer: png },
    { name: 'batch-2.png', mimeType: 'image/png', buffer: png },
    { name: 'batch-3.png', mimeType: 'image/png', buffer: png },
  ]);

  // All three land in the gallery (current folder = root).
  await expect(page.getByTestId('am-item').filter({ hasText: 'batch-1.png' })).toHaveCount(1);
  await expect(page.getByTestId('am-item').filter({ hasText: 'batch-2.png' })).toHaveCount(1);
  await expect(page.getByTestId('am-item').filter({ hasText: 'batch-3.png' })).toHaveCount(1);
});

test('text editor: font size steps up and down repeatedly, keeping the selection', async ({ page }) => {
  await openDesigner(page);
  await page.getByTestId('toolbox-text').click();

  const editable = page.getByTestId('text-editable');
  await editable.click();
  const selectAll = (): Promise<void> =>
    page.evaluate(() => {
      const el = document.querySelector('[data-testid="text-editable"]')!;
      const sel = window.getSelection()!;
      sel.removeAllRanges();
      const range = document.createRange();
      range.selectNodeContents(el);
      sel.addRange(range);
    });
  await selectAll();
  const selectedText = await page.evaluate(() => window.getSelection()!.toString());
  expect(selectedText.length).toBeGreaterThan(0);

  await page.getByTestId('rte-toolbar').waitFor();
  const up = page.getByTestId('rte-toolbar').getByTitle('A+', { exact: true });
  const down = page.getByTestId('rte-toolbar').getByTitle('A−', { exact: true });

  // Computed font-size of the element at the selection start (what the user sees).
  const sizeOf = (): Promise<number> =>
    page.evaluate(() => {
      const n = window.getSelection()!.getRangeAt(0).startContainer;
      const el = (n.nodeType === 3 ? n.parentElement : (n as HTMLElement))!;
      return parseFloat(getComputedStyle(el).fontSize);
    });
  const selKept = async (): Promise<void> => {
    expect(await page.evaluate(() => window.getSelection()!.toString())).toBe(selectedText);
  };

  // Three A+ clicks step UP monotonically (selection kept the whole time).
  await up.click();
  await selKept();
  const u1 = await sizeOf();
  await up.click();
  await selKept();
  const u2 = await sizeOf();
  await up.click();
  await selKept();
  const u3 = await sizeOf();
  expect(u2).toBeGreaterThan(u1);
  expect(u3).toBeGreaterThan(u2);

  // Now A− steps back DOWN (the old bug: it stalled / jumped back up).
  await down.click();
  await selKept();
  const d1 = await sizeOf();
  await down.click();
  await selKept();
  const d2 = await sizeOf();
  expect(d1).toBeLessThan(u3);
  expect(d2).toBeLessThan(d1);
});

test('text editor: adding a link via the styled dialog applies to the selection', async ({ page }) => {
  await openDesigner(page);
  await page.getByTestId('toolbox-text').click();

  // Focus the text and select ALL of it programmatically (deterministic).
  const editable = page.getByTestId('text-editable');
  await editable.click();
  await page.evaluate(() => {
    const el = document.querySelector('[data-testid="text-editable"]')!;
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    const range = document.createRange();
    range.selectNodeContents(el);
    sel.addRange(range);
  });

  // Toolbar → link → styled dialog → URL → confirm.
  await page.getByTestId('rte-toolbar').waitFor();
  await page.getByTestId('rte-toolbar').getByTitle('link', { exact: true }).click();
  await page.getByTestId('dialog-input').fill('https://example.com/promo');
  await page.getByTestId('dialog-confirm').click();

  // The link is applied in the editable DOM…
  const link = editable.locator('a[href="https://example.com/promo"]');
  await expect(link).toHaveCount(1);
  // …and is visibly underlined at design time (Tailwind preflight restored).
  await expect(link).toHaveCSS('text-decoration', /underline/);

  // Re-selecting the linked text and clicking "link" PRE-FILLS the URL and
  // updates it in place (the old bug: empty dialog, no change).
  await page.evaluate(() => {
    const a = document.querySelector('[data-testid="text-editable"] a')!;
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    const range = document.createRange();
    range.selectNodeContents(a);
    sel.addRange(range);
  });
  await page.getByTestId('rte-toolbar').getByTitle('link', { exact: true }).click();
  await expect(page.getByTestId('dialog-input')).toHaveValue('https://example.com/promo');
  await page.getByTestId('dialog-input').fill('https://example.com/updated');
  await page.getByTestId('dialog-confirm').click();
  await expect(editable.locator('a[href="https://example.com/updated"]')).toHaveCount(1);

  // …and the updated URL survives into the emitted MJML once the edit commits.
  await page.getByTestId('template-name').click(); // blur the editable → save
  await expect(page.getByTestId('mjml-output')).toHaveValue(/https:\/\/example\.com\/updated/);
});

test('text editor: lists are visible at design time and the toolbar clamps to the canvas', async ({ page }) => {
  await openDesigner(page);
  await page.getByTestId('toolbox-text').click();

  // Make the text a bulleted list via the toolbar.
  const editable = page.getByTestId('text-editable');
  await editable.click();
  await page.evaluate(() => {
    const el = document.querySelector('[data-testid="text-editable"]')!;
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    const range = document.createRange();
    range.selectNodeContents(el);
    sel.addRange(range);
  });
  await page.getByTestId('rte-toolbar').waitFor();
  await page.getByTestId('rte-toolbar').getByTitle('• list').click();

  // The list RENDERS as a list (Tailwind preflight is overridden in the canvas).
  const ul = editable.locator('ul');
  await expect(ul).toHaveCount(1);
  await expect(ul).toHaveCSS('list-style-type', 'disc');
  const pad = await ul.evaluate((el) => getComputedStyle(el).paddingInlineStart);
  expect(parseInt(pad)).toBeGreaterThanOrEqual(20);

  // Toolbar clamp: scroll the text out of view inside the canvas — the toolbar
  // must stick to the CANVAS top (below the designer toolbar), not the page top.
  await page.evaluate(() => {
    // grow the canvas content so it can scroll, then scroll past the text
    const canvas = document.querySelector('.nm-canvas')!;
    const spacer = document.createElement('div');
    spacer.style.height = '1500px';
    canvas.appendChild(spacer);
    canvas.scrollTop = 600;
    canvas.dispatchEvent(new Event('scroll', { bubbles: true }));
  });
  const tb = (await page.getByTestId('rte-toolbar').boundingBox())!;
  const canvasBox = (await page.locator('.nm-canvas').boundingBox())!;
  expect(tb.y).toBeGreaterThanOrEqual(canvasBox.y);
});
