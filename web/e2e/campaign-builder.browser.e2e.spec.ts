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

/** The final pen point (x,y) of an orthogonal path `d` — where the connector
 *  LANDS (the target card's top-center). Used to assert two arms CONVERGE. */
function pathEndPoint(d: string): { x: number; y: number } {
  const tokens = d.trim().split(/\s+/);
  let i = 0;
  let x = 0;
  let y = 0;
  const n = (): number => Number(tokens[i++]);
  while (i < tokens.length) {
    const cmd = tokens[i++];
    if (cmd === 'M') { x = n(); y = n(); }
    else if (cmd === 'V') { y = n(); }
    else if (cmd === 'H') { x = n(); }
    else if (cmd === 'Q') { n(); n(); x = n(); y = n(); }
    else if (cmd === 'L') { x = n(); y = n(); }
  }
  return { x, y };
}

/** The starting pen point (the M command) of an orthogonal path `d`. */
function pathStartPoint(d: string): { x: number; y: number } {
  const tokens = d.trim().split(/\s+/);
  return { x: Number(tokens[1]), y: Number(tokens[2]) };
}

/** Round a point so two paths that converge on the same node compare equal. */
function key(p: { x: number; y: number }): string {
  return `${Math.round(p.x)},${Math.round(p.y)}`;
}

/** The (+) controls BELOW a given y (the condition card's bottom) — i.e. the two
 *  ARM inserts, not the trunk insert above the condition — left-to-right. Returns
 *  their integer indices into the campaign-edge-insert locator. */
async function armInsertIndices(page: Page, belowY: number): Promise<number[]> {
  const boxes = await page.getByTestId('campaign-edge-insert').evaluateAll((els) =>
    els.map((e) => {
      const r = (e as HTMLElement).getBoundingClientRect();
      return { top: r.top, left: r.left };
    }),
  );
  return boxes
    .map((b, i) => ({ ...b, i }))
    .filter((b) => b.top > belowY)
    .sort((a, b) => a.left - b.left)
    .map((b) => b.i);
}

/** The condition card's bottom y (arm + controls sit below this). */
async function conditionBottom(page: Page): Promise<number> {
  const box = await page.getByTestId('node-condition').boundingBox();
  return box!.y + box!.height;
}

async function openCampaigns(page: Page): Promise<void> {
  await loginAs(page, DEV_MKT);
  await page.getByTestId('nav-campaigns').click();
  // Campaigns is now a LIST page; the canvas builder lives at /campaigns/new and
  // /campaigns/:id (reached via New campaign or opening a row).
  await page.getByTestId('campaigns-list-screen').waitFor();
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

  // CONVERGENCE: the seeded journey is a diamond — the condition's arms OPEN and
  // REJOIN a single trunk. There is exactly ONE exit (both sides reach it).
  await expect(page.getByTestId('node-exit')).toHaveCount(1);
  const sendBox = await page.getByTestId('node-send').boundingBox();
  expect(sendBox).not.toBeNull();

  // The join (the set_attribute trunk node) has 2+ incoming connectors that END at
  // the SAME (x,y) point — proving they converge on one node, not two exits.
  const endpoints = ds.map(pathEndPoint);
  const counts = new Map<string, number>();
  for (const p of endpoints) counts.set(key(p), (counts.get(key(p)) ?? 0) + 1);
  const converged = [...counts.values()].filter((c) => c >= 2);
  expect(converged.length).toBeGreaterThanOrEqual(1);

  // Down-only: no connector path's end-y is above its start-y.
  for (const d of ds) expect(pathEndPoint(d).y).toBeGreaterThan(pathStartPoint(d).y);
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

  // Save → the server validates the definition; back on the list it appears.
  await page.getByTestId('save-campaign').click();
  await expect(page.getByTestId('toast')).toBeVisible();
  await page.getByTestId('campaigns-back').click();
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

test('insert an If → a CONVERGING diamond: both arms rejoin a single exit', async ({ page }) => {
  await openCampaigns(page);
  await page.getByTestId('campaign-new').click();
  await page.getByTestId('campaign-name').fill('Branchy');

  // Insert a condition on the trigger→exit_1 edge → BOTH arms rejoin exit_1.
  await page.getByTestId('campaign-edge-insert').first().click();
  await page.getByTestId('palette-if').click();
  await expect(page.getByTestId('node-condition')).toBeVisible();
  // Exactly ONE exit remains (no fresh exit minted — both arms converge on it).
  await expect(page.getByTestId('node-exit')).toHaveCount(1);

  // Every connector is axis-aligned, and ≥2 of them END at the SAME (x,y) — the
  // single join (exit_1) — proving convergence into one node.
  const ds = await page.getByTestId('campaign-connectors').locator('path').evaluateAll((paths) =>
    paths.map((p) => p.getAttribute('d') ?? ''),
  );
  for (const d of ds) expect(pathIsAxisAligned(d)).toBe(true);
  const counts = new Map<string, number>();
  for (const d of ds) {
    const k = key(pathEndPoint(d));
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  expect([...counts.values()].some((c) => c >= 2)).toBe(true);
  // Down-only.
  for (const d of ds) expect(pathEndPoint(d).y).toBeGreaterThan(pathStartPoint(d).y);

  // Three (+) controls: the trunk insert (trigger→If) plus ONE arm insert per
  // outgoing edge (onTrue + onFalse) — each arm has its own +.
  await expect(page.getByTestId('campaign-edge-insert')).toHaveCount(3);
  const arms = await armInsertIndices(page, await conditionBottom(page));
  expect(arms.length).toBe(2);

  await page.getByTestId('save-campaign').click();
  await expect(page.getByTestId('toast')).toBeVisible();
});

test('per-arm + with an empty passthrough: one arm gets a send, both rejoin the trunk', async ({ page }) => {
  await openCampaigns(page);
  await page.getByTestId('campaign-new').click();
  await page.getByTestId('campaign-name').fill('One arm');

  await page.getByTestId('campaign-edge-insert').first().click();
  await page.getByTestId('palette-if').click();
  await expect(page.getByTestId('node-condition')).toBeVisible();
  await expect(page.getByTestId('campaign-edge-insert')).toHaveCount(3);

  // Click the LEFT arm (+) and add a send → it lands BETWEEN If and the join.
  const arms = await armInsertIndices(page, await conditionBottom(page));
  expect(arms.length).toBe(2);
  await page.getByTestId('campaign-edge-insert').nth(arms[0]!).click();
  await page.getByTestId('palette-send').click();
  await expect(page.getByTestId('node-send')).toBeVisible();

  // STILL exactly one exit — the other (empty) arm passes straight through to it.
  await expect(page.getByTestId('node-exit')).toHaveCount(1);

  // Both sides still reach the single join (≥2 connectors converge).
  const ds = await page.getByTestId('campaign-connectors').locator('path').evaluateAll((paths) =>
    paths.map((p) => p.getAttribute('d') ?? ''),
  );
  for (const d of ds) expect(pathIsAxisAligned(d)).toBe(true);
  const counts = new Map<string, number>();
  for (const d of ds) {
    const k = key(pathEndPoint(d));
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  expect([...counts.values()].some((c) => c >= 2)).toBe(true);

  await page.getByTestId('save-campaign').click();
  await expect(page.getByTestId('toast')).toBeVisible();
});

test('an Exit on an arm terminates only that arm (the other still rejoins)', async ({ page }) => {
  await openCampaigns(page);
  await page.getByTestId('campaign-new').click();
  await page.getByTestId('campaign-name').fill('Arm exit');

  await page.getByTestId('campaign-edge-insert').first().click();
  await page.getByTestId('palette-if').click();
  await expect(page.getByTestId('node-condition')).toBeVisible();
  await expect(page.getByTestId('node-exit')).toHaveCount(1);

  // Drop an Exit on one ARM (not the trunk) → that arm terminates; exit count
  // becomes 2 (the new arm-terminal exit + the still-shared continuation exit).
  const arms = await armInsertIndices(page, await conditionBottom(page));
  expect(arms.length).toBe(2);
  await page.getByTestId('campaign-edge-insert').nth(arms[0]!).click();
  await page.getByTestId('palette-exit').click();
  await expect(page.getByTestId('node-exit')).toHaveCount(2);

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
  await page.getByTestId('campaigns-back').click();
  await page.getByTestId('campaign-item').filter({ hasText: 'Round trip me' }).getByTestId('campaign-open').click();
  await expect(page.getByTestId('campaign-name')).toHaveValue('Round trip me');
  await expect(page.getByTestId('node-trigger')).toBeVisible();
  await expect(page.getByTestId('node-wait')).toBeVisible();
  await expect(page.getByTestId('node-exit')).toHaveCount(1);
});

test('round-trip: a populated-arm diamond reopens with the same node set + convergence', async ({ page }) => {
  await openCampaigns(page);
  await page.getByTestId('campaign-new').click();
  await page.getByTestId('campaign-name').fill('Diamond trip');

  await page.getByTestId('campaign-edge-insert').first().click();
  await page.getByTestId('palette-if').click();
  await expect(page.getByTestId('node-condition')).toBeVisible();
  // Populate one ARM with a send (between the If and the join).
  const arms = await armInsertIndices(page, await conditionBottom(page));
  await page.getByTestId('campaign-edge-insert').nth(arms[0]!).click();
  await page.getByTestId('palette-send').click();
  await expect(page.getByTestId('node-send')).toBeVisible();
  await page.getByTestId('save-campaign').click();
  await expect(page.getByTestId('toast')).toBeVisible();

  // Reopen → the canvas rebuilds the SAME node set, connectors still converge.
  await page.getByTestId('campaigns-back').click();
  await page.getByTestId('campaign-item').filter({ hasText: 'Diamond trip' }).getByTestId('campaign-open').click();
  await page.getByTestId('campaign-canvas').waitFor();
  await expect(page.getByTestId('node-condition')).toBeVisible();
  await expect(page.getByTestId('node-send')).toBeVisible();
  await expect(page.getByTestId('node-exit')).toHaveCount(1);
  const ds = await page.getByTestId('campaign-connectors').locator('path').evaluateAll((paths) =>
    paths.map((p) => p.getAttribute('d') ?? ''),
  );
  const counts = new Map<string, number>();
  for (const d of ds) {
    const k = key(pathEndPoint(d));
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  expect([...counts.values()].some((c) => c >= 2)).toBe(true);
});

test('delete the condition of a diamond re-links to a valid converging graph', async ({ page }) => {
  await openCampaigns(page);
  await page.getByTestId('campaign-new').click();
  await page.getByTestId('campaign-name').fill('Delete cond');

  await page.getByTestId('campaign-edge-insert').first().click();
  await page.getByTestId('palette-if').click();
  await expect(page.getByTestId('node-condition')).toBeVisible();
  const arms = await armInsertIndices(page, await conditionBottom(page));
  await page.getByTestId('campaign-edge-insert').nth(arms[0]!).click();
  await page.getByTestId('palette-send').click();
  await expect(page.getByTestId('node-send')).toBeVisible();

  // Delete the condition via its ActionMenu → styled confirm (NOT window.confirm).
  const condCard = page.getByTestId('node-condition');
  await condCard.getByLabel('Step actions').click();
  await condCard.getByTestId('node-delete').click();
  await page.getByTestId('app-dialog').waitFor();
  await page.getByTestId('dialog-confirm').click();

  // The condition is gone; the graph re-links (no orphan) and stays valid.
  await expect(page.getByTestId('node-condition')).toHaveCount(0);
  await expect(page.getByTestId('node-exit')).toHaveCount(1);
  await page.getByTestId('save-campaign').click();
  await expect(page.getByTestId('toast')).toBeVisible();
  await page.getByTestId('campaigns-back').click();
  await expect(page.getByTestId('campaign-list')).toContainText('Delete cond');
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
  await page.getByTestId('campaigns-back').click();
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
