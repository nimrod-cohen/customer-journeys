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

test('the post-merge trunk is STRAIGHT below the join (no spurious knee / re-centering)', async ({ page }) => {
  await openCampaigns(page);
  await page.getByTestId('campaign-item').filter({ hasText: 'Welcome journey' }).getByTestId('campaign-open').click();
  await page.getByTestId('campaign-canvas').waitFor();

  // Seed: cond.onTrue→sendY→join, cond.onFalse→join, then join→exit1 (the merged
  // trunk continuation). All path coords are in the SAME layout space (we compare
  // paths to paths, never to screen boundingBoxes which carry pan/zoom transforms).
  const ds = await page.getByTestId('campaign-connectors').locator('path').evaluateAll((paths) =>
    paths.map((p) => p.getAttribute('d') ?? ''),
  );
  const segs = ds.map((d) => ({ d, s: pathStartPoint(d), e: pathEndPoint(d) }));

  // The CONVERGENCE point: the (x,y) ≥2 connectors (the two arms) END at — the join's
  // top-center. The join's OUTGOING trunk edge then STARTS at the same x (the join's
  // bottom-center) and a deeper y.
  const endCounts = new Map<string, { x: number; y: number; n: number }>();
  for (const { e } of segs) {
    const k = key(e);
    const cur = endCounts.get(k) ?? { x: e.x, y: e.y, n: 0 };
    cur.n += 1;
    endCounts.set(k, cur);
  }
  const join = [...endCounts.values()].find((p) => p.n >= 2);
  expect(join, `no convergence point (join) found among ${JSON.stringify(ds)}`).toBeTruthy();

  // The trunk edge leaving the join: starts at the join's x, below the join's top.
  const trunk = segs.find((p) => Math.abs(p.s.x - join!.x) < 1.5 && p.s.y > join!.y);
  expect(trunk, `no join→exit trunk connector found among ${JSON.stringify(ds)}`).toBeTruthy();
  // STRAIGHT vertical below the join — same x in and out, ZERO horizontal knee, NOT
  // pulled back toward the board center.
  expect(Math.abs(trunk!.s.x - trunk!.e.x)).toBeLessThan(1.5);
  expect(Math.abs(trunk!.e.x - join!.x)).toBeLessThan(1.5);
  expect(trunk!.d.includes(' H ')).toBe(false);
});

test('the merge + sits on a VISIBLE vertical line: ABOVE it the arms close, BELOW it the join', async ({ page }) => {
  await openCampaigns(page);
  // The seeded Welcome journey is a POPULATED diamond (an arm has a send before the
  // rejoin) — so the closing arm corners in HIGH (top knee) and a tall central run
  // descends to the join. The merge (+) must sit in the MIDDLE of that run.
  await page.getByTestId('campaign-item').filter({ hasText: 'Welcome journey' }).getByTestId('campaign-open').click();
  await page.getByTestId('campaign-canvas').waitFor();

  // All comparisons are in LOCAL canvas coords: path `d` coords AND the inline-styled
  // top of the merge (+) live in the SAME (un-transformed) canvas frame, so no
  // pan/zoom conversion is needed (we never mix in a screen boundingBox here).
  const ds = await page.getByTestId('campaign-connectors').locator('path').evaluateAll((paths) =>
    paths.map((p) => p.getAttribute('d') ?? ''),
  );
  const segs = ds.map((d) => ({ d, e: pathEndPoint(d) }));

  // The convergence point: the (x,y) ≥2 connectors END at — the join card's top.
  const endCounts = new Map<string, { x: number; y: number; n: number }>();
  for (const { e } of segs) {
    const k = key(e);
    const cur = endCounts.get(k) ?? { x: e.x, y: e.y, n: 0 };
    cur.n += 1;
    endCounts.set(k, cur);
  }
  const join = [...endCounts.values()].find((p) => p.n >= 2);
  expect(join, `no convergence point found among ${JSON.stringify(ds)}`).toBeTruthy();

  // A CLOSING arm path: ends AT the join AND lands on the join column (its final V is
  // at the join x). Its single horizontal knee (V→H) is the closure corner — read the
  // corner y as the y at the H command after a V (the high crossing).
  const closingD = ds.find((d) => {
    const ep = pathEndPoint(d);
    return key(ep) === key(join!) && d.includes(' H ');
  });
  expect(closingD, `no closing arm path landing on the join among ${JSON.stringify(ds)}`).toBeTruthy();
  // Trace the path to the y at the moment it turns horizontal (the closure corner).
  const closureCornerY = await page.evaluate((d: string) => {
    const t = d.trim().split(/\s+/);
    let i = 0;
    let cy = 0;
    const n = (): number => Number(t[i++]);
    while (i < t.length) {
      const cmd = t[i++];
      if (cmd === 'M') { n(); cy = n(); }
      else if (cmd === 'V') { cy = n(); }
      else if (cmd === 'H') { return cy; } // the corner: y where it turns across
      else if (cmd === 'Q') { n(); n(); n(); cy = n(); }
    }
    return cy;
  }, closingD!);

  // The merge (+)'s LOCAL y (its inline style top — same frame as the path coords).
  const mergeTop = await page.getByTestId('campaign-merge-insert').first().evaluate((el) =>
    parseFloat((el as HTMLElement).style.top),
  );

  // The visible line: closure corner ABOVE the (+), the join card top BELOW it.
  expect(mergeTop).toBeGreaterThan(closureCornerY + 8); // a real line ABOVE the +
  expect(mergeTop).toBeLessThan(join!.y - 8); // a real line BELOW the + (down to the join)
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

test('empty If renders as a rectangle: each arm + on its OWN lane (distinct x) + a merge +', async ({ page }) => {
  await openCampaigns(page);
  await page.getByTestId('campaign-new').click();
  await page.getByTestId('campaign-name').fill('Empty diamond');

  // Insert an If on trigger→exit_1 → both arms point straight at exit_1 (empty).
  await page.getByTestId('campaign-edge-insert').first().click();
  await page.getByTestId('palette-if').click();
  await expect(page.getByTestId('node-condition')).toBeVisible();

  // The two ARM (+)s (below the condition card) sit on DISTINCT lanes — their x's
  // must differ (no stacking), one left + one right.
  const condBottom = await conditionBottom(page);
  const armBoxes = await page.getByTestId('campaign-edge-insert').evaluateAll((els, by) => {
    return els
      .map((e) => (e as HTMLElement).getBoundingClientRect())
      .filter((r) => r.top > by)
      .map((r) => ({ x: Math.round(r.left + r.width / 2), y: Math.round(r.top) }));
  }, condBottom);
  expect(armBoxes.length).toBe(2);
  expect(armBoxes[0]!.x).not.toBe(armBoxes[1]!.x); // distinct lanes

  // Exactly ONE merge (+) below the branch (the after-the-branch control on the trunk).
  await expect(page.getByTestId('campaign-merge-insert')).toHaveCount(1);
  // Its x differs from BOTH arm lanes (it sits on the central merged trunk).
  const merge = await page.getByTestId('campaign-merge-insert').evaluate((el) => {
    const r = (el as HTMLElement).getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top) };
  });
  expect(merge.x).not.toBe(armBoxes[0]!.x);
  expect(merge.x).not.toBe(armBoxes[1]!.x);
  // Each arm (+) sits ABOVE the merge (+) — straight below the condition, before the
  // turn — with a CLEAR vertical gap (never adjoining the low merge (+)).
  for (const arm of armBoxes) {
    expect(arm.y).toBeLessThan(merge.y - 24);
  }

  // Connectors stay axis-aligned + the arms still converge on the single join.
  const ds = await page.getByTestId('campaign-connectors').locator('path').evaluateAll((paths) =>
    paths.map((p) => p.getAttribute('d') ?? ''),
  );
  for (const d of ds) expect(pathIsAxisAligned(d)).toBe(true);
  const counts = new Map<string, number>();
  for (const d of ds) counts.set(key(pathEndPoint(d)), (counts.get(key(pathEndPoint(d))) ?? 0) + 1);
  expect([...counts.values()].some((c) => c >= 2)).toBe(true);
});

test('insert a step AFTER the branch via the merge +: it lands BETWEEN the join and the exit', async ({ page }) => {
  await openCampaigns(page);
  await page.getByTestId('campaign-new').click();
  await page.getByTestId('campaign-name').fill('After branch');

  // An empty If → both arms rejoin exit_1.
  await page.getByTestId('campaign-edge-insert').first().click();
  await page.getByTestId('palette-if').click();
  await expect(page.getByTestId('node-condition')).toBeVisible();
  await expect(page.getByTestId('node-exit')).toHaveCount(1);

  // Click the merge (+) → palette opens (after-branch mode) → add a wait.
  await page.getByTestId('campaign-merge-insert').click();
  await page.getByTestId('campaign-palette').waitFor();
  await page.getByTestId('palette-wait').click();
  await expect(page.getByTestId('node-wait')).toBeVisible();

  // The wait sits BETWEEN the condition and the (still single) exit (down-only).
  const condTop = (await page.getByTestId('node-condition').boundingBox())!.y;
  const waitTop = (await page.getByTestId('node-wait').boundingBox())!.y;
  const exitTop = (await page.getByTestId('node-exit').boundingBox())!.y;
  expect(waitTop).toBeGreaterThan(condTop); // below the branch
  expect(exitTop).toBeGreaterThan(waitTop); // above the exit
  await expect(page.getByTestId('node-exit')).toHaveCount(1);

  // Both arms now flow THROUGH the wait before the exit: exactly TWO connectors
  // converge on the wait's top (one per arm), and the wait→exit trunk is single.
  const ds = await page.getByTestId('campaign-connectors').locator('path').evaluateAll((paths) =>
    paths.map((p) => p.getAttribute('d') ?? ''),
  );
  for (const d of ds) expect(pathIsAxisAligned(d)).toBe(true);
  const counts = new Map<string, number>();
  for (const d of ds) counts.set(key(pathEndPoint(d)), (counts.get(key(pathEndPoint(d))) ?? 0) + 1);
  expect([...counts.values()].some((c) => c >= 2)).toBe(true);

  // Persists through a save + reload.
  await page.getByTestId('save-campaign').click();
  await expect(page.getByTestId('toast')).toBeVisible();
  await page.getByTestId('campaigns-back').click();
  await page.getByTestId('campaign-item').filter({ hasText: 'After branch' }).getByTestId('campaign-open').click();
  await page.getByTestId('campaign-canvas').waitFor();
  await expect(page.getByTestId('node-wait')).toBeVisible();
  await expect(page.getByTestId('node-exit')).toHaveCount(1);
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

  // USER FIX: the arm edge (+)s — the cond→send arm and the send→join arm — sit on
  // the source-side UPPER vertical run (straight below their source node, before the
  // turn toward the join), so they are clearly ABOVE the low merge (+) with a real
  // gap. None of them adjoins the merge (+).
  const condBottom = await conditionBottom(page);
  const armEdgeYs = await page.getByTestId('campaign-edge-insert').evaluateAll((els, by) => {
    return els
      .map((e) => (e as HTMLElement).getBoundingClientRect())
      .filter((r) => r.top > by)
      .map((r) => Math.round(r.top));
  }, condBottom);
  const mergeY = await page.getByTestId('campaign-merge-insert').evaluate((el) =>
    Math.round((el as HTMLElement).getBoundingClientRect().top),
  );
  expect(armEdgeYs.length).toBeGreaterThan(0);
  for (const y of armEdgeYs) expect(y).toBeLessThan(mergeY - 24);

  await page.getByTestId('save-campaign').click();
  await expect(page.getByTestId('toast')).toBeVisible();
});

test('populated arms render as COMPACT straight columns: each arm + directly above its child, a 2nd node stays in the same column', async ({ page }) => {
  await openCampaigns(page);
  await page.getByTestId('campaign-new').click();
  await page.getByTestId('campaign-name').fill('Compact columns');

  // Insert an If → both arms initially point at the single exit.
  await page.getByTestId('campaign-edge-insert').first().click();
  await page.getByTestId('palette-if').click();
  await expect(page.getByTestId('node-condition')).toBeVisible();
  await expect(page.getByTestId('campaign-edge-insert')).toHaveCount(3);

  // Populate the LEFT (Yes) arm with a Send email.
  let arms = await armInsertIndices(page, await conditionBottom(page));
  expect(arms.length).toBe(2);
  await page.getByTestId('campaign-edge-insert').nth(arms[0]!).click();
  await page.getByTestId('palette-send').click();
  await expect(page.getByTestId('node-send')).toBeVisible();
  await expect(page.getByTestId('campaign-palette')).toHaveCount(0); // palette closed

  // Populate the RIGHT (No) arm with a Wait. The empty No-arm + routes out to its
  // own side lane (off the Send card), so it stays clickable.
  arms = await armInsertIndices(page, await conditionBottom(page));
  await page.getByTestId('campaign-edge-insert').nth(arms[arms.length - 1]!).click();
  await page.getByTestId('palette-wait').click();
  await expect(page.getByTestId('node-wait')).toBeVisible();
  await expect(page.getByTestId('campaign-palette')).toHaveCount(0); // palette closed

  // The two arm CARDS (Send + Wait) sit at a COMPACT horizontal distance — their
  // center-to-center x-gap is modest (a small gap between two ~200px cards), NOT
  // spread to the canvas edges. BRANCH_HALF_GAP=140 ⇒ ~280px center-to-center.
  const sendBox = (await page.getByTestId('node-send').boundingBox())!;
  const waitBox = (await page.getByTestId('node-wait').boundingBox())!;
  const sendCx = sendBox.x + sendBox.width / 2;
  const waitCx = waitBox.x + waitBox.width / 2;
  const cardGap = Math.abs(sendCx - waitCx);
  expect(cardGap).toBeGreaterThan(sendBox.width); // not overlapping
  expect(cardGap).toBeLessThan(sendBox.width * 2); // COMPACT — well under "edge-spread"

  // Each arm's + sits DIRECTLY ABOVE its child (same column x). The arm inserts are
  // the (+) controls below the condition; match each to the nearer child by x.
  const condBottom = await conditionBottom(page);
  const armPlusXs = await page.getByTestId('campaign-edge-insert').evaluateAll(
    (els, by) =>
      els
        .map((e) => (e as HTMLElement).getBoundingClientRect())
        .filter((r) => r.top > by)
        .map((r) => Math.round(r.left + r.width / 2)),
    condBottom,
  );
  // One arm + aligns (≈) with the Send column, the other with the Wait column.
  const nearSend = armPlusXs.some((x) => Math.abs(x - sendCx) <= 2);
  const nearWait = armPlusXs.some((x) => Math.abs(x - waitCx) <= 2);
  expect(nearSend).toBe(true);
  expect(nearWait).toBe(true);

  // Insert a SECOND node down the Yes arm (on the send→join edge): it must stay in
  // the SAME column as the Send (a straight vertical, no per-node jog).
  // The send→join (+) is the edge insert sitting just below the Send card on its column.
  const sendBottom = sendBox.y + sendBox.height;
  const belowSend = await page.getByTestId('campaign-edge-insert').evaluateAll(
    (els, ctx) =>
      els
        .map((e, i) => ({ r: (e as HTMLElement).getBoundingClientRect(), i }))
        .filter(({ r }) => r.top > ctx.y && Math.abs(r.left + r.width / 2 - ctx.x) <= 4)
        .sort((a, b) => a.r.top - b.r.top)
        .map(({ i }) => i),
    { x: sendCx, y: sendBottom },
  );
  expect(belowSend.length).toBeGreaterThan(0);
  await page.getByTestId('campaign-edge-insert').nth(belowSend[0]!).click();
  await page.getByTestId('palette-update-profile').click();
  await expect(page.getByTestId('node-set_attribute')).toBeVisible();

  const setBox = (await page.getByTestId('node-set_attribute').boundingBox())!;
  const setCx = setBox.x + setBox.width / 2;
  expect(Math.abs(setCx - sendCx)).toBeLessThanOrEqual(2); // SAME column as the Send

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

test('MOVE a node to a chosen + relocates it (placement mode), source closes up', async ({ page }) => {
  await openCampaigns(page);
  await page.getByTestId('campaign-new').click();
  await page.getByTestId('campaign-name').fill('Move me');

  // Build a diamond with a movable single node on the Yes arm:
  //   trigger → cond(onTrue → wait → exit_1, onFalse → exit_1).
  await page.getByTestId('campaign-edge-insert').first().click();
  await page.getByTestId('palette-if').click();
  await expect(page.getByTestId('node-condition')).toBeVisible();
  const arms = await armInsertIndices(page, await conditionBottom(page));
  expect(arms.length).toBe(2);
  await page.getByTestId('campaign-edge-insert').nth(arms[0]!).click();
  await page.getByTestId('palette-wait').click();
  await expect(page.getByTestId('node-wait')).toBeVisible();

  // Open the wait's ⋮ → "Move to…" → the placement banner appears.
  const waitCard = page.getByTestId('node-wait');
  await waitCard.getByLabel('Step actions').click();
  await waitCard.getByTestId('node-move').click();
  await expect(page.getByTestId('placement-banner')).toBeVisible();

  // Pick the FIRST placement target (the trunk trigger→cond edge — outside the
  // moving subtree). The wait relocates above the condition; the Yes arm closes up.
  await page.getByTestId('placement-target').first().click();
  await expect(page.getByTestId('placement-banner')).toHaveCount(0);
  await expect(page.getByTestId('toast')).toContainText(/moved/i);

  // The wait now sits ABOVE the condition (down-only: its card top is above cond's).
  const waitTop = (await page.getByTestId('node-wait').boundingBox())!.y;
  const condTop = (await page.getByTestId('node-condition').boundingBox())!.y;
  expect(waitTop).toBeLessThan(condTop);

  // Persisted: reopen and the wait still precedes the condition.
  await page.getByTestId('campaigns-back').click();
  await page.getByTestId('campaign-item').filter({ hasText: 'Move me' }).getByTestId('campaign-open').click();
  await page.getByTestId('campaign-canvas').waitFor();
  await expect(page.getByTestId('node-wait')).toBeVisible();
  await expect(page.getByTestId('node-condition')).toBeVisible();
});

test('placement mode cancels via the banner button and via Escape', async ({ page }) => {
  await openCampaigns(page);
  await page.getByTestId('campaign-new').click();
  await page.getByTestId('campaign-edge-insert').first().click();
  await page.getByTestId('palette-wait').click();
  await expect(page.getByTestId('node-wait')).toBeVisible();

  const waitCard = page.getByTestId('node-wait');
  // Cancel via the banner button.
  await waitCard.getByLabel('Step actions').click();
  await waitCard.getByTestId('node-move').click();
  await expect(page.getByTestId('placement-banner')).toBeVisible();
  await page.getByTestId('placement-cancel').click();
  await expect(page.getByTestId('placement-banner')).toHaveCount(0);

  // Cancel via Escape.
  await waitCard.getByLabel('Step actions').click();
  await waitCard.getByTestId('node-move').click();
  await expect(page.getByTestId('placement-banner')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('placement-banner')).toHaveCount(0);
});

test('DUPLICATE a node to a chosen + adds a second card; the original stays', async ({ page }) => {
  await openCampaigns(page);
  await page.getByTestId('campaign-new').click();
  await page.getByTestId('campaign-name').fill('Dupe me');

  // Diamond with a wait on the Yes arm: trigger → cond(onTrue → wait → exit_1, onFalse → exit_1).
  await page.getByTestId('campaign-edge-insert').first().click();
  await page.getByTestId('palette-if').click();
  await expect(page.getByTestId('node-condition')).toBeVisible();
  const arms = await armInsertIndices(page, await conditionBottom(page));
  await page.getByTestId('campaign-edge-insert').nth(arms[0]!).click();
  await page.getByTestId('palette-wait').click();
  await expect(page.getByTestId('node-wait')).toHaveCount(1);

  // ⋮ → "Duplicate…" → pick a destination target. A second wait appears.
  const waitCard = page.getByTestId('node-wait');
  await waitCard.getByLabel('Step actions').click();
  await waitCard.getByTestId('node-duplicate').click();
  await expect(page.getByTestId('placement-banner')).toContainText(/copy/i);
  // Place the copy on the LAST target (the onFalse arm, outside the wait's subtree).
  await page.getByTestId('placement-target').last().click();
  await expect(page.getByTestId('placement-banner')).toHaveCount(0);
  await expect(page.getByTestId('toast')).toContainText(/duplicated/i);

  // Two wait cards now exist; the original is still present.
  await expect(page.getByTestId('node-wait')).toHaveCount(2);

  await page.getByTestId('save-campaign').click();
  await expect(page.getByTestId('toast').first()).toBeVisible();
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
