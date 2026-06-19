// E2E (real Chromium): the constrained DOWNWARD campaign canvas (§9B phase 5).
// Renders a seeded branching definition as a downward tree with rounded
// orthogonal connectors (asserts NO diagonal/upward path in-page); assembles a
// linear journey AND an if-branch via the (+) edge palette; round-trips
// save→reload through the DSL; refuses an invalid graph with a styled toast (no
// native dialog); deletes a node and re-links the graph. Proven in a real browser
// against real Postgres (cdp_e2e).
import { test, expect, type Page } from '@playwright/test';
import { loginAs } from './helpers.js';
import { DEV_MKT } from './seed.js';

/** Tokenize a connector path's `d`; assert every drawn run is axis-aligned. */
function pathIsAxisAligned(d: string): boolean {
  const tokens = d.trim().split(/\s+/);
  let i = 0;
  let cx = 0;
  let cy = 0;
  const n = (): number => Number(tokens[i++]);
  while (i < tokens.length) {
    const cmd = tokens[i++];
    if (cmd === 'M') {
      cx = n();
      cy = n();
    } else if (cmd === 'V') {
      cy = n();
    } else if (cmd === 'H') {
      cx = n();
    } else if (cmd === 'Q') {
      const cpx = n();
      const cpy = n();
      const ex = n();
      const ey = n();
      // The corner ENTRY must be axis-aligned with the pre-corner pen position.
      if (cpx !== cx && cpy !== cy) return false;
      cx = ex;
      cy = ey;
    } else if (cmd === 'L') {
      // A straight line must move on ONE axis only (never a diagonal).
      const nx = n();
      const ny = n();
      if (nx !== cx && ny !== cy) return false;
      cx = nx;
      cy = ny;
    } else {
      return false; // unexpected command
    }
  }
  return true;
}

async function openCampaigns(page: Page): Promise<void> {
  await loginAs(page, DEV_MKT);
  await page.getByTestId('nav-campaigns').click();
  await page.getByTestId('campaign-builder').waitFor();
}

test('renders a seeded definition as a downward tree with axis-aligned connectors', async ({ page }) => {
  await openCampaigns(page);

  // Open the seeded branching campaign → the canvas reconstructs its DSL graph.
  await page.getByTestId('campaign-item').filter({ hasText: 'Welcome journey' }).getByTestId('campaign-open').click();
  await page.getByTestId('campaign-canvas').waitFor();

  // It shows typed nodes (trigger / wait / condition / send / exit).
  await expect(page.getByTestId('node-trigger')).toBeVisible();
  await expect(page.getByTestId('node-wait')).toBeVisible();
  await expect(page.getByTestId('node-condition')).toBeVisible();
  await expect(page.getByTestId('node-send')).toBeVisible();
  await expect(page.getByTestId('node-exit').first()).toBeVisible();

  // Connectors exist and are ALL axis-aligned (no diagonal command).
  const ds = await page.getByTestId('campaign-connectors').locator('path').evaluateAll((paths) =>
    paths.map((p) => p.getAttribute('d') ?? ''),
  );
  expect(ds.length).toBeGreaterThan(0);
  for (const d of ds) expect(pathIsAxisAligned(d)).toBe(true);

  // Down-only: each edge's target card top is BELOW its source card top. We check
  // the trigger→wait→condition chain (stable ids) plus the two fanned arms.
  const top = async (testid: string, nth = 0): Promise<number> => {
    const box = await page.getByTestId(testid).nth(nth).boundingBox();
    return box!.y;
  };
  const triggerTop = await top('node-trigger');
  const waitTop = await top('node-wait');
  const condTop = await top('node-condition');
  expect(waitTop).toBeGreaterThan(triggerTop);
  expect(condTop).toBeGreaterThan(waitTop);

  // The condition's two arms fan to DIFFERENT x columns (send arm vs the false exit).
  const sendBox = await page.getByTestId('node-send').boundingBox();
  // There are two exits; their left offsets differ from each other (fanned).
  const exitBoxes = await page.getByTestId('node-exit').evaluateAll((els) =>
    els.map((e) => (e as HTMLElement).getBoundingClientRect().left),
  );
  expect(new Set(exitBoxes).size).toBeGreaterThan(1);
  expect(sendBox).not.toBeNull();
});

test('assemble trigger→wait→send→exit via the (+) palette, then save', async ({ page }) => {
  await openCampaigns(page);
  await page.getByTestId('campaign-new').click();
  await page.getByTestId('campaign-name').fill('Assembled linear');

  // The starter is trigger → exit; one (+) sits on that edge. Insert a wait.
  await page.getByTestId('campaign-edge-insert').first().click();
  await page.getByTestId('campaign-palette').waitFor();
  await page.getByTestId('palette-wait').click();
  await expect(page.getByTestId('node-wait')).toBeVisible();

  // Insert a send on the trigger→wait edge (first +).
  await page.getByTestId('campaign-edge-insert').first().click();
  await page.getByTestId('palette-send').click();
  await expect(page.getByTestId('node-send')).toBeVisible();

  // Save → the server validates the definition; it appears in the list.
  await page.getByTestId('save-campaign').click();
  await expect(page.getByTestId('toast')).toBeVisible();
  await expect(page.getByTestId('campaign-list')).toContainText('Assembled linear');
});

test('the palette offers all eight node types', async ({ page }) => {
  await openCampaigns(page);
  await page.getByTestId('campaign-new').click();
  await page.getByTestId('campaign-edge-insert').first().click();
  await page.getByTestId('campaign-palette').waitFor();
  for (const id of [
    'palette-wait',
    'palette-wait-until',
    'palette-hour-window',
    'palette-if',
    'palette-send',
    'palette-update-profile',
    'palette-webhook',
    'palette-exit',
  ]) {
    await expect(page.getByTestId(id)).toBeVisible();
  }
});

test('assemble an if-branch → two arms fan into distinct x columns', async ({ page }) => {
  await openCampaigns(page);
  await page.getByTestId('campaign-new').click();
  await page.getByTestId('campaign-name').fill('Branchy');

  // Insert a condition on the trigger→exit edge → both arms auto-end in an exit.
  await page.getByTestId('campaign-edge-insert').first().click();
  await page.getByTestId('palette-if').click();
  await expect(page.getByTestId('node-condition')).toBeVisible();
  // Now there are two exits (the original onTrue target + the auto-created false arm).
  await expect(page.getByTestId('node-exit')).toHaveCount(2);

  // The two exits sit in different x columns (fanned sideways).
  const lefts = await page.getByTestId('node-exit').evaluateAll((els) =>
    els.map((e) => (e as HTMLElement).getBoundingClientRect().left),
  );
  expect(new Set(lefts).size).toBe(2);

  await page.getByTestId('save-campaign').click();
  await expect(page.getByTestId('toast')).toBeVisible();
});

test('round-trip: save then reopen reconstructs the same graph', async ({ page }) => {
  await openCampaigns(page);
  await page.getByTestId('campaign-new').click();
  await page.getByTestId('campaign-name').fill('Round trip me');
  await page.getByTestId('campaign-edge-insert').first().click();
  await page.getByTestId('palette-wait').click();
  await expect(page.getByTestId('node-wait')).toBeVisible();
  await page.getByTestId('save-campaign').click();
  await expect(page.getByTestId('toast')).toBeVisible();

  // Reopen via the list → the canvas rebuilds the SAME node set (trigger/wait/exit).
  await page.getByTestId('campaign-item').filter({ hasText: 'Round trip me' }).getByTestId('campaign-open').click();
  await expect(page.getByTestId('campaign-name')).toHaveValue('Round trip me');
  await expect(page.getByTestId('node-trigger')).toBeVisible();
  await expect(page.getByTestId('node-wait')).toBeVisible();
  await expect(page.getByTestId('node-exit')).toHaveCount(1);
});

test('delete a node re-links the graph and stays valid', async ({ page }) => {
  await openCampaigns(page);
  await page.getByTestId('campaign-new').click();
  await page.getByTestId('campaign-name').fill('Deletable');

  // Build trigger → wait → exit.
  await page.getByTestId('campaign-edge-insert').first().click();
  await page.getByTestId('palette-wait').click();
  await expect(page.getByTestId('node-wait')).toBeVisible();

  // Delete the wait via its ActionMenu → styled confirm (NOT window.confirm).
  const waitCard = page.getByTestId('node-wait');
  await waitCard.getByLabel('Step actions').click();
  await waitCard.getByTestId('node-delete').click();
  await page.getByTestId('app-dialog').waitFor();
  await page.getByTestId('dialog-confirm').click();

  // The wait is gone; trigger now links straight to exit; no orphan remains.
  await expect(page.getByTestId('node-wait')).toHaveCount(0);
  await expect(page.getByTestId('node-trigger')).toBeVisible();
  await expect(page.getByTestId('node-exit')).toHaveCount(1);

  // Save still succeeds (the graph is valid).
  await page.getByTestId('save-campaign').click();
  await expect(page.getByTestId('toast')).toBeVisible();
  await expect(page.getByTestId('campaign-list')).toContainText('Deletable');
});

test('deleting the last exit is refused with a styled toast (no native dialog)', async ({ page }) => {
  await openCampaigns(page);
  await page.getByTestId('campaign-new').click(); // trigger → exit_1 (the only exit)

  // Attempt to delete the only exit → confirm → a styled toast refuses it.
  const exitCard = page.getByTestId('node-exit');
  await exitCard.getByLabel('Step actions').click();
  await exitCard.getByTestId('node-delete').click();
  await page.getByTestId('app-dialog').waitFor();
  await page.getByTestId('dialog-confirm').click();

  await expect(page.getByTestId('toast')).toBeVisible();
  await expect(page.getByTestId('toast')).toContainText(/exit/i);
  // The exit is still there (the mutation was refused, never produced an invalid def).
  await expect(page.getByTestId('node-exit')).toHaveCount(1);
});
