// E2E (real Chromium, cdp_e2e): the SELECTED automation node stays highlighted +
// centered, and the selection SURVIVES (a) opening the editor drawer and coming
// back, and (b) a full page refresh — persisted per-automation in sessionStorage.
import { test, expect, type Page } from '@playwright/test';
import { loginAs } from './helpers.js';
import { DEV_MKT } from './seed.js';

async function openSeeded(page: Page): Promise<void> {
  await loginAs(page, DEV_MKT);
  await page.getByTestId('nav-automations').click();
  await page.getByTestId('automations-list-screen').waitFor();
  await page.getByTestId('automation-item').filter({ hasText: 'Welcome journey' }).getByTestId('automation-open').click();
  await page.getByTestId('automation-canvas').waitFor();
}

/** The selected node's center is within the central band of the canvas viewport. */
async function expectCentered(page: Page, testid: string): Promise<void> {
  const vp = await page.getByTestId('automation-canvas').boundingBox();
  const node = await page.getByTestId(testid).first().boundingBox();
  expect(vp && node).toBeTruthy();
  const nodeCx = node!.x + node!.width / 2;
  const nodeCy = node!.y + node!.height / 2;
  const vpCx = vp!.x + vp!.width / 2;
  const vpCy = vp!.y + vp!.height / 2;
  // Centering puts the node center at the viewport center; allow a generous band.
  expect(Math.abs(nodeCx - vpCx)).toBeLessThan(vp!.width * 0.3);
  expect(Math.abs(nodeCy - vpCy)).toBeLessThan(vp!.height * 0.35);
}

test('selecting a node highlights + centers it; survives the drawer round-trip AND a refresh', async ({ page }) => {
  await openSeeded(page);

  // Open the condition node's editor → it becomes the SELECTED node.
  await page.getByTestId('node-condition').getByTestId(/node-open-/).first().click();
  await page.getByTestId('node-editor-condition').waitFor();

  // Close the drawer (X) → we return to the canvas with the node still selected.
  await page.getByTestId('drawer-close').click();
  await expect(page.getByTestId('node-editor-condition')).toBeHidden();

  // The condition card is highlighted (data-selected) and centered in the viewport.
  await expect(page.getByTestId('node-condition')).toHaveAttribute('data-selected', 'true');
  await expectCentered(page, 'node-condition');

  // A FULL refresh re-restores the selection (sessionStorage, per automation) + centers it.
  await page.reload();
  await page.getByTestId('automation-canvas').waitFor();
  await expect(page.getByTestId('node-condition')).toHaveAttribute('data-selected', 'true');
  await expectCentered(page, 'node-condition');
});
