// E2E (real Chromium): the campaign canvas board interactions added in v0.41.4 —
// (1) drag-to-PAN the board background (scrolls the overflow viewport) and
// (2) trackpad PINCH zoom (ctrl+wheel changes the zoom level, plain wheel does
// not). Asserts the background-only pan does NOT swallow node/+/menu clicks.
// Proven in a real browser against real Postgres (cdp_e2e).
import { test, expect, type Page } from '@playwright/test';
import { loginAs } from './helpers.js';
import { DEV_MKT } from './seed.js';

async function openSeededCampaign(page: Page): Promise<void> {
  await loginAs(page, DEV_MKT);
  await page.getByTestId('nav-campaigns').click();
  await page.getByTestId('campaigns-list-screen').waitFor();
  await page
    .getByTestId('campaign-item')
    .filter({ hasText: 'Welcome journey' })
    .getByTestId('campaign-open')
    .click();
  await page.getByTestId('campaign-canvas').waitFor();
}

/** Read the current zoom level (integer percent) from the toolbar readout. */
async function zoomLevel(page: Page): Promise<number> {
  const txt = await page.getByTestId('canvas-zoom-level').innerText();
  return Number(txt.replace('%', '').trim());
}

/** The viewport's current scroll offset. */
async function scrollOffset(page: Page): Promise<{ left: number; top: number }> {
  return page.getByTestId('campaign-canvas').evaluate((el) => ({
    left: el.scrollLeft,
    top: el.scrollTop,
  }));
}

/** A point on the BACKGROUND of the canvas — inside the lower-LEFT area, kept away
 *  from the top-of-tree cards, the top-right zoom toolbar, AND the right/bottom
 *  scrollbar gutters (a press on the gutter never reaches the board). */
async function backgroundPoint(page: Page): Promise<{ x: number; y: number }> {
  const box = (await page.getByTestId('campaign-canvas').boundingBox())!;
  return { x: box.x + 40, y: box.y + box.height - 60 };
}

test('PAN: dragging the board background scrolls the viewport', async ({ page }) => {
  await openSeededCampaign(page);

  // Zoom IN first so the (tall) content overflows the viewport vertically and
  // there is room to pan. (The seeded tree is narrow → vertical overflow only.)
  for (let i = 0; i < 4; i++) await page.getByTestId('canvas-zoom-in').click();

  const before = await scrollOffset(page);
  const start = await backgroundPoint(page);

  // Press on the background and drag UP → the viewport scrolls down (scrollTop
  // INCREASES, since pan = startScrollTop - deltaY and deltaY < 0).
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x - 120, start.y - 160, { steps: 10 });
  await page.mouse.up();

  const after = await scrollOffset(page);
  // The board scrolled (panned) — vertical movement is the load-bearing axis here.
  expect(after.top).toBeGreaterThan(before.top);
});

test('PAN: dragging the background does NOT open a node or the insert palette', async ({ page }) => {
  await openSeededCampaign(page);
  for (let i = 0; i < 4; i++) await page.getByTestId('canvas-zoom-in').click();

  const start = await backgroundPoint(page);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x - 100, start.y - 60, { steps: 6 });
  await page.mouse.up();

  // No node editor drawer + no insert palette opened from a background drag.
  await expect(page.getByTestId('campaign-palette')).toHaveCount(0);
  await expect(page.getByTestId('placement-banner')).toHaveCount(0);
});

test('node / + / menu clicks still work after the pan pointerdown wiring', async ({ page }) => {
  await loginAs(page, DEV_MKT);
  await page.getByTestId('nav-campaigns').click();
  await page.getByTestId('campaigns-list-screen').waitFor();
  await page.getByTestId('campaign-new').click();
  await page.getByTestId('campaign-canvas').waitFor();

  // The (+) edge insert still opens the palette (not swallowed by the pan handler).
  await page.getByTestId('campaign-edge-insert').first().click();
  await page.getByTestId('campaign-palette').waitFor();
  await page.getByTestId('palette-wait').click();
  await expect(page.getByTestId('node-wait')).toBeVisible();

  // A node card click still opens its editor (the card's open button → drawer).
  await page.getByTestId('node-wait').getByTestId(/node-open-/).first().click();
  await expect(page.getByTestId('node-editor-wait')).toBeVisible();
});

test('PINCH: ctrl+wheel up zooms IN, ctrl+wheel down zooms OUT; plain wheel does not zoom', async ({ page }) => {
  await openSeededCampaign(page);

  const base = await zoomLevel(page);
  const pt = await backgroundPoint(page);

  // Dispatch a ctrl+wheel with negative deltaY (pinch-open) over the canvas → zoom IN.
  await page.getByTestId('campaign-canvas').evaluate((el, p) => {
    el.dispatchEvent(
      new WheelEvent('wheel', {
        deltaY: -100,
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
        clientX: p.x,
        clientY: p.y,
      }),
    );
  }, pt);
  await expect.poll(() => zoomLevel(page)).toBeGreaterThan(base);

  const afterIn = await zoomLevel(page);

  // ctrl+wheel with positive deltaY (pinch-close) → zoom OUT.
  await page.getByTestId('campaign-canvas').evaluate((el, p) => {
    el.dispatchEvent(
      new WheelEvent('wheel', {
        deltaY: 100,
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
        clientX: p.x,
        clientY: p.y,
      }),
    );
  }, pt);
  await expect.poll(() => zoomLevel(page)).toBeLessThan(afterIn);

  // A NON-ctrl wheel must NOT change the zoom (native scroll instead).
  const beforePlain = await zoomLevel(page);
  await page.getByTestId('campaign-canvas').evaluate((el, p) => {
    el.dispatchEvent(
      new WheelEvent('wheel', {
        deltaY: -200,
        ctrlKey: false,
        bubbles: true,
        cancelable: true,
        clientX: p.x,
        clientY: p.y,
      }),
    );
  }, pt);
  // Give any (incorrect) handler a chance to run, then assert unchanged.
  await page.waitForTimeout(150);
  expect(await zoomLevel(page)).toBe(beforePlain);
});
