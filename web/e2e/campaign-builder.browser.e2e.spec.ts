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

test('a NESTED If lets you add a node AFTER the inner closure (before the outer closure)', async ({ page }) => {
  await openCampaigns(page);
  await page.getByTestId('campaign-new').click();
  await page.getByTestId('campaign-canvas').waitFor();

  // Outer If, then an inner If on the outer's first (left) arm, then a node on each
  // inner arm — the inner arms rejoin the SAME continuation the outer's other arm reaches.
  await page.getByTestId('campaign-edge-insert').first().click();
  await page.getByTestId('palette-if').click();
  await expect(page.getByTestId('node-condition')).toHaveCount(1);
  let arms = await armInsertIndices(page, await conditionBottom(page));
  await page.getByTestId('campaign-edge-insert').nth(arms[0]!).click();
  await page.getByTestId('palette-if').click();
  await expect(page.getByTestId('node-condition')).toHaveCount(2);
  const condTops = await page.getByTestId('node-condition').evaluateAll((els) => els.map((e) => (e as HTMLElement).getBoundingClientRect().top));
  const innerY = Math.max(...condTops); // the inner (deeper) condition sits lower
  let iarms = await armInsertIndices(page, innerY);
  await page.getByTestId('campaign-edge-insert').nth(iarms[0]!).click();
  await page.getByTestId('palette-wait').click();
  await expect(page.getByTestId('node-wait')).toHaveCount(1);
  iarms = await armInsertIndices(page, innerY);
  await page.getByTestId('campaign-edge-insert').nth(iarms[iarms.length - 1]!).click();
  await page.getByTestId('palette-send').click();
  await expect(page.getByTestId('node-send')).toBeVisible();

  // The two nested Ifs SHARE a continuation, so only ONE merge (+) renders (the inner's,
  // deepest) — they no longer stack at the same point.
  await expect(page.getByTestId('campaign-merge-insert')).toHaveCount(1);

  // Insert an hour-window AFTER the inner If's closure via that merge (+).
  await page.getByTestId('campaign-merge-insert').first().click();
  await page.getByTestId('palette-hour-window').click();
  await expect(page.getByTestId('node-hour_of_day_window')).toHaveCount(1);

  // The new node sits BELOW both inner-arm nodes (after the inner convergence)…
  const armsBottom = Math.max(
    (await page.getByTestId('node-wait').boundingBox())!.y + (await page.getByTestId('node-wait').boundingBox())!.height,
    (await page.getByTestId('node-send').boundingBox())!.y + (await page.getByTestId('node-send').boundingBox())!.height,
  );
  const newTop = (await page.getByTestId('node-hour_of_day_window').boundingBox())!.y;
  expect(newTop).toBeGreaterThan(armsBottom);
  // …and now TWO merge (+)s exist (the inner's at the new node + the outer's) — the
  // merges have SEPARATED, so you can add after the outer closure too.
  await expect(page.getByTestId('campaign-merge-insert')).toHaveCount(2);
});

test('BOTH arms of an If get a closing (+) below their last node, before the merge', async ({ page }) => {
  await openCampaigns(page);
  await page.getByTestId('campaign-new').click();
  await page.getByTestId('campaign-canvas').waitFor();

  // trigger → If, then a node on EACH arm so each arm has content that CLOSES into the join.
  await page.getByTestId('campaign-edge-insert').first().click();
  await page.getByTestId('palette-if').click();
  await expect(page.getByTestId('node-condition')).toBeVisible();
  let arms = await armInsertIndices(page, await conditionBottom(page));
  await page.getByTestId('campaign-edge-insert').nth(arms[0]!).click();
  await page.getByTestId('palette-wait').click();
  await expect(page.getByTestId('node-wait')).toHaveCount(1);
  arms = await armInsertIndices(page, await conditionBottom(page));
  await page.getByTestId('campaign-edge-insert').nth(arms[arms.length - 1]!).click();
  await page.getByTestId('palette-send').click();
  await expect(page.getByTestId('node-send')).toBeVisible();

  // Both arm CARDS rejoin a single merge. EACH arm must have a closing (+) below its
  // card (one per arm, at distinct x), plus the after-branch merge (+). Find the
  // edge-insert (+)s that sit BELOW both arm cards' bottoms.
  const waitBox = await page.getByTestId('node-wait').boundingBox();
  const sendBox = await page.getByTestId('node-send').boundingBox();
  const armsBottom = Math.max(waitBox!.y + waitBox!.height, sendBox!.y + sendBox!.height);
  const closing = await page.getByTestId('campaign-edge-insert').evaluateAll(
    (els, below) =>
      els
        .map((e) => (e as HTMLElement).getBoundingClientRect())
        .filter((r) => r.top > below)
        .map((r) => Math.round(r.left)),
    armsBottom,
  );
  // Exactly TWO closing (+)s — one per arm — at DISTINCT x (left arm vs right arm).
  expect(closing).toHaveLength(2);
  expect(new Set(closing).size).toBe(2);
  // …and the after-branch merge (+) is present too.
  await expect(page.getByTestId('campaign-merge-insert')).toHaveCount(1);
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

test('branch arm spacing is FIXED & depth-consistent: a ~40px gap between the two arm cards, SAME when nested (v0.42.4)', async ({ page }) => {
  // BRANCH_HALF_GAP = 120 ⇒ arm columns 240px apart ⇒ two 200px cards have a ~40px gap.
  const FIXED_CARD_GAP = 40;
  const GAP_TOL = 24; // sub-pixel/scale rounding tolerance
  const OLD_WIDE_GAP = 200; // the old behavior spread arms FAR wider than this

  /** Screen x-centers of cards matching `selector` below `belowY`, left→right. */
  const cardCentersBelow = async (selector: string, belowY: number): Promise<number[]> => {
    const cxs = await page.locator(selector).evaluateAll((els, by) =>
      els
        .map((e) => (e as HTMLElement).getBoundingClientRect())
        .filter((r) => r.top > by)
        .map((r) => r.left + r.width / 2),
      belowY,
    );
    return cxs.sort((a, b) => a - b);
  };

  await openCampaigns(page);
  await page.getByTestId('campaign-new').click();
  await page.getByTestId('campaign-name').fill('Fixed gap');

  // TOP-LEVEL If, then a node in EACH arm (two waits) so the arms have real cards.
  await page.getByTestId('campaign-edge-insert').first().click();
  await page.getByTestId('palette-if').click();
  await expect(page.getByTestId('node-condition')).toBeVisible();

  const armsTop = await armInsertIndices(page, await conditionBottom(page));
  await page.getByTestId('campaign-edge-insert').nth(armsTop[0]!).click();
  await page.getByTestId('palette-wait').click();
  await expect(page.getByTestId('node-wait')).toHaveCount(1);
  const armsAfterLeft = await armInsertIndices(page, await conditionBottom(page));
  await page.getByTestId('campaign-edge-insert').nth(armsAfterLeft[armsAfterLeft.length - 1]!).click();
  await page.getByTestId('palette-wait').click();
  await expect(page.getByTestId('node-wait')).toHaveCount(2);

  // The two arm wait-cards sit a SMALL, FIXED gap apart — NOT flung wide.
  const condBottom1 = await conditionBottom(page);
  const topArmCenters = await cardCentersBelow('[data-testid="node-wait"]', condBottom1);
  expect(topArmCenters.length).toBe(2);
  const topGap = topArmCenters[1]! - topArmCenters[0]!;
  expect(topGap, `top arm gap ${topGap}`).toBeGreaterThan(0);
  expect(topGap).toBeLessThan(OLD_WIDE_GAP + 120); // well under the old wide spread
  const cardW = 200;
  expect(Math.abs(topGap - cardW - FIXED_CARD_GAP)).toBeLessThanOrEqual(GAP_TOL); // ~40px edge gap

  // NEST an If inside the LEFT arm: click the arm insert nearest the left wait's column.
  const leftWaitX = topArmCenters[0]!;
  const armInserts = await page.getByTestId('campaign-edge-insert').evaluateAll((els, by) =>
    els
      .map((e, i) => ({ r: (e as HTMLElement).getBoundingClientRect(), i }))
      .filter((o) => o.r.top > by)
      .map((o) => ({ cx: o.r.left + o.r.width / 2, i: o.i })),
    condBottom1,
  );
  armInserts.sort((a, b) => Math.abs(a.cx - leftWaitX) - Math.abs(b.cx - leftWaitX));
  await page.getByTestId('campaign-edge-insert').nth(armInserts[0]!.i).click();
  await page.getByTestId('palette-if').click();
  await expect(page.getByTestId('node-condition')).toHaveCount(2); // outer + nested

  // The NESTED If (the lower condition card) — measure its OWN two arm-insert lanes.
  // They straddle its column SYMMETRICALLY and DISTINCTLY (no stacking), and nesting
  // must NOT have blown the top-level gap wide open: it stays the same fixed ~240.
  const nested = await page.getByTestId('node-condition').evaluateAll((els) => {
    const lowest = els
      .map((e) => (e as HTMLElement).getBoundingClientRect())
      .reduce((a, b) => (b.bottom > a.bottom ? b : a));
    return { cx: lowest.left + lowest.width / 2, bottom: lowest.bottom };
  });
  // The nested condition's two arm inserts: the pair straddling its column just below it.
  const nestedArmLanes = await page.getByTestId('campaign-edge-insert').evaluateAll((els, c) => {
    const below = els
      .map((e) => (e as HTMLElement).getBoundingClientRect())
      .filter((r) => r.top > c.bottom)
      .map((r) => r.left + r.width / 2);
    const left = below.filter((x) => x < c.cx).sort((a, b) => Math.abs(a - c.cx) - Math.abs(b - c.cx))[0];
    const right = below.filter((x) => x >= c.cx).sort((a, b) => Math.abs(a - c.cx) - Math.abs(b - c.cx))[0];
    return { left, right };
  }, { cx: nested.cx, bottom: nested.bottom });
  expect(nestedArmLanes.left, 'nested left arm lane').toBeDefined();
  expect(nestedArmLanes.right, 'nested right arm lane').toBeDefined();
  // DISTINCT lanes (no stacking) and SYMMETRIC about the nested column center.
  expect(nestedArmLanes.right! - nestedArmLanes.left!).toBeGreaterThan(0);
  expect(Math.abs((nestedArmLanes.left! + nestedArmLanes.right!) / 2 - nested.cx)).toBeLessThanOrEqual(GAP_TOL);

  // Add a node into EACH nested arm so the nested If has real arm CARDS, then assert
  // those two cards sit the SAME fixed ~240 gap as the top level (depth-consistent).
  // Click both nested arm inserts BY their captured lane x (sorted left→right) in one
  // pass against a snapshot of the current inserts, so each click targets a distinct arm.
  // Fill ONE side of the nested If, then the OTHER — re-resolving the nested condition's
  // arm insert on the chosen side each time (the layout re-centers as the first card
  // appears, so a stale captured x can't pick the wrong control).
  const fillNestedSide = async (side: 'left' | 'right'): Promise<void> => {
    const idx = await page.evaluate((s) => {
      const conds = Array.from(document.querySelectorAll('[data-testid="node-condition"]')).map((e) => e.getBoundingClientRect());
      const lowest = conds.reduce((a, b) => (b.bottom > a.bottom ? b : a));
      const cx = lowest.left + lowest.width / 2;
      const inserts = Array.from(document.querySelectorAll('[data-testid="campaign-edge-insert"]'))
        .map((e, i) => ({ i, r: e.getBoundingClientRect() }))
        .filter((o) => o.r.top > lowest.bottom && o.r.top < lowest.bottom + 160) // the arm-insert row just below
        .map((o) => ({ i: o.i, cx: o.r.left + o.r.width / 2 }));
      const pick = inserts
        .filter((o) => (s === 'left' ? o.cx < cx : o.cx >= cx))
        .sort((a, b) => Math.abs(a.cx - cx) - Math.abs(b.cx - cx))[0];
      return pick ? pick.i : -1;
    }, side);
    expect(idx, `no ${side} nested arm insert in the arm row`).toBeGreaterThanOrEqual(0);
    await page.getByTestId('campaign-edge-insert').nth(idx).click();
    await page.getByTestId('palette-wait').click();
  };
  await fillNestedSide('left');
  await expect(page.getByTestId('node-wait')).toHaveCount(3);
  await fillNestedSide('right');
  await expect(page.getByTestId('node-wait')).toHaveCount(4);

  // The nested If's two arm wait-cards now sit at EQUAL depth straddling its column.
  const nestedFinal = await page.getByTestId('node-condition').evaluateAll((els) => {
    const lowest = els.map((e) => (e as HTMLElement).getBoundingClientRect()).reduce((a, b) => (b.bottom > a.bottom ? b : a));
    return { cx: lowest.left + lowest.width / 2, bottom: lowest.bottom };
  });
  const nestedCards = await page.evaluate((c) => {
    const waits = Array.from(document.querySelectorAll('[data-testid="node-wait"]'))
      .map((e) => ({ cx: e.getBoundingClientRect().left + e.getBoundingClientRect().width / 2, top: e.getBoundingClientRect().top }))
      .filter((w) => w.top > c.bottom);
    const rowTop = Math.min(...waits.map((w) => w.top));
    return waits.filter((w) => Math.abs(w.top - rowTop) < 8).map((w) => w.cx).sort((a, b) => a - b);
  }, nestedFinal);
  expect(nestedCards.length, 'two nested arm cards at equal depth').toBe(2);
  const nestedGap = nestedCards[1]! - nestedCards[0]!;
  expect(Math.abs(nestedGap - topGap), `topGap=${topGap} nestedGap=${nestedGap}`).toBeLessThanOrEqual(GAP_TOL); // SAME fixed gap

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

test('EMPTY If: rounded shoulders, CENTERED arm +s, a PADDED merge + (v0.42.3)', async ({ page }) => {
  await openCampaigns(page);
  await page.getByTestId('campaign-new').click();
  await page.getByTestId('campaign-name').fill('Empty if quality');

  // Insert an If on trigger→exit_1 → both arms empty, straight to exit_1 (empty diamond).
  await page.getByTestId('campaign-edge-insert').first().click();
  await page.getByTestId('palette-if').click();
  await expect(page.getByTestId('node-condition')).toBeVisible();
  await expect(page.getByTestId('node-exit')).toHaveCount(1);
  await expect(page.getByTestId('campaign-merge-insert')).toHaveCount(1);

  // (1) ROUNDED SHOULDERS — every connector path uses Q (or A) corner commands and
  //     NEVER a straight diagonal L. The two empty-arm paths (which land on the join)
  //     must each carry ≥ 3 Q corners (the top split + the two close corners).
  const ds = await page.getByTestId('campaign-connectors').locator('path').evaluateAll((paths) =>
    paths.map((p) => p.getAttribute('d') ?? ''),
  );
  for (const d of ds) {
    expect(pathIsAxisAligned(d)).toBe(true);
    expect(d).not.toMatch(/\bL\b/);
  }
  // The two arm paths land on the SAME join point with a horizontal close knee.
  const counts = new Map<string, string[]>();
  for (const d of ds) {
    const k = key(pathEndPoint(d));
    counts.set(k, [...(counts.get(k) ?? []), d]);
  }
  const armPaths = [...counts.values()].find((arr) => arr.length >= 2)!;
  expect(armPaths, 'two converging empty-arm paths').toBeTruthy();
  for (const d of armPaths) {
    const corners = d.trim().split(/\s+/).filter((t) => t === 'Q' || t === 'A').length;
    expect(corners, `empty-arm path lacks rounded shoulders: ${d}`).toBeGreaterThanOrEqual(3);
  }

  // The +s, in screen coords (center). The button is translate(-50%,-50%).
  const cb = await conditionBottom(page);
  const armPluses = await page.getByTestId('campaign-edge-insert').evaluateAll((els, by) =>
    els
      .map((e) => (e as HTMLElement).getBoundingClientRect())
      .filter((r) => r.top + r.height / 2 > by)
      .map((r) => ({ cx: r.left + r.width / 2, cy: r.top + r.height / 2 })),
    cb,
  );
  expect(armPluses.length).toBe(2);
  const merge = await page.getByTestId('campaign-merge-insert').evaluate((el) => {
    const r = (el as HTMLElement).getBoundingClientRect();
    return { cx: r.left + r.width / 2, cy: r.top + r.height / 2 };
  });

  // Helper: does the connector stroke pass through the screen point (within tolerance)?
  const strokeAt = async (sx: number, sy: number): Promise<boolean> =>
    page.getByTestId('campaign-connectors').evaluate(
      (svg, ctx) => {
        const paths = Array.from(svg.querySelectorAll('path')) as SVGPathElement[];
        const ctm = (svg as SVGSVGElement).getScreenCTM();
        if (!ctm) return false;
        const inv = ctm.inverse();
        const sp = (svg as SVGSVGElement).createSVGPoint();
        sp.x = ctx.sx;
        sp.y = ctx.sy;
        const lp = sp.matrixTransform(inv);
        for (const [dx, dy] of [[0, 0], [2, 0], [-2, 0], [0, 2], [0, -2]]) {
          const q = (svg as SVGSVGElement).createSVGPoint();
          q.x = lp.x + dx;
          q.y = lp.y + dy;
          if (paths.some((p) => p.isPointInStroke(q))) return true;
        }
        return false;
      },
      { sx, sy },
    );

  const PLUS_DIAMETER = 28; // matches orthogonal-path PLUS_PAD/PLUS_DIAMETER at scale 1
  const PROBE = 24; // a couple px under the diameter for sub-pixel/scale rounding

  // (2) CENTERED arm +s — each empty-arm + has stroke ABOVE and BELOW it (≥ ~PLUS_DIAMETER),
  //     and the two are roughly symmetric on their lane (centered, not biased high).
  for (const p of armPluses) {
    expect(await strokeAt(p.cx, p.cy - PROBE), `arm + lacks line ABOVE at (${Math.round(p.cx)},${Math.round(p.cy)})`).toBe(true);
    expect(await strokeAt(p.cx, p.cy + PROBE), `arm + lacks line BELOW at (${Math.round(p.cx)},${Math.round(p.cy)})`).toBe(true);
  }
  // Both arm +s sit at (nearly) the same y — they are centered on equal-height lanes.
  expect(Math.abs(armPluses[0]!.cy - armPluses[1]!.cy)).toBeLessThan(4);

  // (3) PADDED merge + — stroke ABOVE it (a real central run, not the old no-pad rejoin)
  //     AND below it down to the join. The arm +s sit clearly ABOVE the merge +.
  expect(await strokeAt(merge.cx, merge.cy - PROBE), 'merge + lacks line ABOVE (padded central run)').toBe(true);
  expect(await strokeAt(merge.cx, merge.cy + PROBE), 'merge + lacks line BELOW (down to the join)').toBe(true);
  for (const p of armPluses) expect(p.cy).toBeLessThan(merge.cy - 12);

  await page.getByTestId('save-campaign').click();
  await expect(page.getByTestId('toast')).toBeVisible();
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
  // The send→join (+) is the edge insert sitting just below the Send card on its
  // column. Since v0.41.9 the closing-edge + anchors HIGH (right under the card), so
  // we match on the button's CENTER (it is translate(-50%,-50%)), not its rect top.
  const sendBottom = sendBox.y + sendBox.height;
  const belowSend = await page.getByTestId('campaign-edge-insert').evaluateAll(
    (els, ctx) =>
      els
        .map((e, i) => ({ r: (e as HTMLElement).getBoundingClientRect(), i }))
        .filter(
          ({ r }) =>
            r.top + r.height / 2 > ctx.y - 1 && Math.abs(r.left + r.width / 2 - ctx.x) <= 4,
        )
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
  // Re-measure the Send box NOW: inserting the 2nd node can auto-scroll the viewport
  // (the canvas pans freely with a full viewport of headroom on each side), so the
  // earlier sendCx was at a different scroll offset. Compare both at the SAME scroll —
  // they must share a column (a straight vertical, no per-node jog).
  const sendBoxNow = (await page.getByTestId('node-send').boundingBox())!;
  const sendCxNow = sendBoxNow.x + sendBoxNow.width / 2;
  expect(Math.abs(setCx - sendCxNow)).toBeLessThanOrEqual(2); // SAME column as the Send

  await page.getByTestId('save-campaign').click();
  await expect(page.getByTestId('toast')).toBeVisible();
});

test('UNEQUAL arms (Yes=1 / No=3): the short arm + sits right after its last node, far from the merge + (v0.41.9)', async ({ page }) => {
  await openCampaigns(page);
  await page.getByTestId('campaign-new').click();
  await page.getByTestId('campaign-name').fill('Unequal arms');

  // Insert an If → both arms initially point at the single exit.
  await page.getByTestId('campaign-edge-insert').first().click();
  await page.getByTestId('palette-if').click();
  await expect(page.getByTestId('node-condition')).toBeVisible();
  await expect(page.getByTestId('campaign-edge-insert')).toHaveCount(3);

  // Helper: the (+) controls below the condition card, with their CENTER x + y (the
  // button is translate(-50%,-50%), so its center is the true anchor point).
  const armPluses = async (): Promise<Array<{ i: number; cx: number; cy: number }>> => {
    const cb = await conditionBottom(page);
    return page.getByTestId('campaign-edge-insert').evaluateAll(
      (els, by) =>
        els
          .map((e, i) => ({ r: (e as HTMLElement).getBoundingClientRect(), i }))
          .filter(({ r }) => r.top + r.height / 2 > by)
          .map(({ r, i }) => ({ i, cx: Math.round(r.left + r.width / 2), cy: Math.round(r.top + r.height / 2) })),
      cb,
    );
  };

  // YES (left) arm: ONE Send email.
  let arms = await armInsertIndices(page, await conditionBottom(page));
  await page.getByTestId('campaign-edge-insert').nth(arms[0]!).click();
  await page.getByTestId('palette-send').click();
  await expect(page.getByTestId('node-send')).toBeVisible();

  // NO (right) arm: grow to THREE nodes (Wait → Webhook → Send). Each time, click the
  // LOWEST (deepest) + on the right column and insert the next node.
  for (const palette of ['palette-wait', 'palette-webhook', 'palette-send'] as const) {
    const ps = await armPluses();
    // The right column = the largest center-x; pick its LOWEST (deepest) +.
    const maxCx = Math.max(...ps.map((p) => p.cx));
    const rightCol = ps.filter((p) => Math.abs(p.cx - maxCx) <= 6).sort((a, b) => b.cy - a.cy);
    await page.getByTestId('campaign-edge-insert').nth(rightCol[0]!.i).click();
    await page.getByTestId('campaign-palette').waitFor();
    await page.getByTestId(palette).click();
    await expect(page.getByTestId('campaign-palette')).toHaveCount(0);
  }

  // The No arm now has Wait + Webhook + 2 Sends (Yes-send + No-send) on the canvas.
  await expect(page.getByTestId('node-wait')).toHaveCount(1);
  await expect(page.getByTestId('node-webhook')).toHaveCount(1);
  await expect(page.getByTestId('node-send')).toHaveCount(2);
  // Still ONE merge + (one branch, single rejoin).
  await expect(page.getByTestId('campaign-merge-insert')).toHaveCount(1);

  // The YES arm's Send card — the SHORT arm's last node. Its appended + (the
  // send→join edge) must sit RIGHT BELOW it, within a normal trunk gap — NOT drifted
  // down the empty tail toward the merge depth. (All measurements are SCREEN px and
  // the canvas may scale; we compare RATIOS, never raw layout constants.)
  // The Yes Send is the LEFT-column send (smaller x). Identify both sends by x.
  const sendBoxes = await page.getByTestId('node-send').evaluateAll((els) =>
    els.map((e) => {
      const r = (e as HTMLElement).getBoundingClientRect();
      return { cx: Math.round(r.left + r.width / 2), top: Math.round(r.top), bottom: Math.round(r.top + r.height) };
    }),
  );
  expect(sendBoxes.length).toBe(2);
  const yesSend = sendBoxes.sort((a, b) => a.cx - b.cx)[0]!; // left column = Yes arm

  // The + on the Yes arm's column, BELOW its Send card (compare CENTERS).
  const ps = await armPluses();
  const yesArmPluses = ps
    .filter((p) => Math.abs(p.cx - yesSend.cx) <= 6 && p.cy > yesSend.bottom - 1)
    .sort((a, b) => a.cy - b.cy);
  const yesArmPlus = yesArmPluses[0];
  expect(yesArmPlus, 'Yes arm append-+ not found below its Send card').toBeTruthy();

  // EXACTLY ONE + on the Yes arm's column below its Send (no second + drifting down).
  expect(yesArmPluses.length).toBe(1);

  // A scale reference: the No-arm Send sits one card below where its column +
  // appears; use the Yes Send card height as a small-distance yardstick.
  const cardH = yesSend.bottom - yesSend.top; // screen-space card height

  // It sits right after the Send — the gap to its + is SMALL (≲ half a card height),
  // NOT drifted down the long empty tail toward the far-below merge depth.
  const gapAfterCard = yesArmPlus!.cy - yesSend.bottom;
  expect(gapAfterCard).toBeGreaterThan(-cardH * 0.1); // at/just below the card bottom
  expect(gapAfterCard).toBeLessThan(cardH); // within ~a card height of the card

  // The merge + and the Yes arm + are clearly SEPARATED (never adjacent). The merge +
  // sits LOW (near the join); the Yes arm + sits HIGH (under its card). The vertical
  // gap between them is LARGE — many card-heights (the whole empty tail + close knee).
  const mergeY = await page.getByTestId('campaign-merge-insert').evaluate((el) => {
    const r = (el as HTMLElement).getBoundingClientRect();
    return Math.round(r.top + r.height / 2);
  });
  expect(yesArmPlus!.cy).toBeLessThan(mergeY); // arm + is ABOVE the merge +
  // Separated by far more than a card height — never the "two adjacent +" the user saw.
  expect(mergeY - yesArmPlus!.cy).toBeGreaterThan(cardH * 1.5);

  // Connectors stay axis-aligned + down-only + converge on the single join.
  const ds = await page.getByTestId('campaign-connectors').locator('path').evaluateAll((paths) =>
    paths.map((p) => p.getAttribute('d') ?? ''),
  );
  for (const d of ds) {
    expect(pathIsAxisAligned(d)).toBe(true);
    expect(pathEndPoint(d).y).toBeGreaterThan(pathStartPoint(d).y);
  }
  const counts = new Map<string, number>();
  for (const d of ds) counts.set(key(pathEndPoint(d)), (counts.get(key(pathEndPoint(d))) ?? 0) + 1);
  expect([...counts.values()].some((c) => c >= 2)).toBe(true);

  await page.getByTestId('save-campaign').click();
  await expect(page.getByTestId('toast')).toBeVisible();
});

test('RULES 1+2 (Yes=1 / No=3): arms close at the SAME y; every + has line above AND below it', async ({ page }) => {
  await openCampaigns(page);
  await page.getByTestId('campaign-new').click();
  await page.getByTestId('campaign-name').fill('Two rules');

  // Build the Yes=1 / No=3 graph: an If, ONE Send on the Yes (left) arm, and
  // Wait → Webhook → Send on the No (right) arm — both rejoin the single exit.
  await page.getByTestId('campaign-edge-insert').first().click();
  await page.getByTestId('palette-if').click();
  await expect(page.getByTestId('node-condition')).toBeVisible();

  const armPluses = async (): Promise<Array<{ i: number; cx: number; cy: number }>> => {
    const cb = await conditionBottom(page);
    return page.getByTestId('campaign-edge-insert').evaluateAll(
      (els, by) =>
        els
          .map((e, i) => ({ r: (e as HTMLElement).getBoundingClientRect(), i }))
          .filter(({ r }) => r.top + r.height / 2 > by)
          .map(({ r, i }) => ({ i, cx: Math.round(r.left + r.width / 2), cy: Math.round(r.top + r.height / 2) })),
      cb,
    );
  };

  let arms = await armInsertIndices(page, await conditionBottom(page));
  await page.getByTestId('campaign-edge-insert').nth(arms[0]!).click();
  await page.getByTestId('palette-send').click();
  await expect(page.getByTestId('node-send')).toBeVisible();
  for (const palette of ['palette-wait', 'palette-webhook', 'palette-send'] as const) {
    const ps = await armPluses();
    const maxCx = Math.max(...ps.map((p) => p.cx));
    const rightCol = ps.filter((p) => Math.abs(p.cx - maxCx) <= 6).sort((a, b) => b.cy - a.cy);
    await page.getByTestId('campaign-edge-insert').nth(rightCol[0]!.i).click();
    await page.getByTestId('campaign-palette').waitFor();
    await page.getByTestId(palette).click();
    await expect(page.getByTestId('campaign-palette')).toHaveCount(0);
  }
  await expect(page.getByTestId('node-send')).toHaveCount(2);
  await expect(page.getByTestId('campaign-merge-insert')).toHaveCount(1);

  // The two CLOSING arm paths (those that END at the join with a horizontal knee).
  // RULE 2: both knee back (turn horizontal) at the SAME y — the longer arm's end.
  const ds = await page.getByTestId('campaign-connectors').locator('path').evaluateAll((paths) =>
    paths.map((p) => p.getAttribute('d') ?? ''),
  );
  const endCounts = new Map<string, { x: number; y: number; n: number }>();
  for (const d of ds) {
    const e = pathEndPoint(d);
    const k = key(e);
    const cur = endCounts.get(k) ?? { x: e.x, y: e.y, n: 0 };
    cur.n += 1;
    endCounts.set(k, cur);
  }
  const join = [...endCounts.values()].find((p) => p.n >= 2)!;
  expect(join, 'no convergence join found').toBeTruthy();
  // The closure-corner y of a path that lands on the join column with a knee.
  const cornerY = (d: string): number | null => {
    const t = d.trim().split(/\s+/);
    let i = 0;
    let cy = 0;
    const n = (): number => Number(t[i++]);
    while (i < t.length) {
      const cmd = t[i++];
      if (cmd === 'M') { n(); cy = n(); }
      else if (cmd === 'V') { cy = n(); }
      else if (cmd === 'H') { return cy; }
      else if (cmd === 'Q') { n(); n(); n(); cy = n(); }
    }
    return null;
  };
  const closing = ds.filter((d) => key(pathEndPoint(d)) === key(join) && d.includes(' H '));
  expect(closing.length, 'expected two closing arm paths').toBe(2);
  const corners = closing.map(cornerY).filter((y): y is number => y !== null);
  expect(corners.length).toBe(2);
  // RULE 2: both arms close at the SAME y (within a couple px of layout rounding).
  expect(Math.abs(corners[0]! - corners[1]!)).toBeLessThan(2);

  // RULE 1: every + (edge-insert + merge-insert) has CONNECTOR PIXELS above AND below
  // it at its x — never a bare + or a corner +. We read each +'s center, then check the
  // SVG connector layer for path coverage just above and just below it on its column.
  // v0.42.2 USER RULE: the pad on each side of every + is ≥ the +-circle height
  // (PLUS_DIAMETER ≈ 28). Probe near the full circle height above AND below — a hit
  // there proves a real line ≥ ~circle-height on each side (a couple px under 28 for
  // sub-pixel/scale rounding so it stays meaningful without flaking).
  const PAD = 24; // screen px probed above/below (≈ PLUS_DIAMETER, ≤ PLUS_PAD at scale 1)
  const pluses = await page
    .getByTestId('campaign-edge-insert')
    .evaluateAll((els) =>
      els.map((e) => {
        const r = (e as HTMLElement).getBoundingClientRect();
        return { cx: r.left + r.width / 2, cy: r.top + r.height / 2 };
      }),
    );
  const merges = await page
    .getByTestId('campaign-merge-insert')
    .evaluateAll((els) =>
      els.map((e) => {
        const r = (e as HTMLElement).getBoundingClientRect();
        return { cx: r.left + r.width / 2, cy: r.top + r.height / 2 };
      }),
    );
  const all = [...pluses, ...merges];
  expect(all.length).toBeGreaterThan(0);
  // For each +, find a connector path whose vertical run at the +'s x spans both
  // [cy - PAD] and [cy + PAD] — i.e. a real line above AND below the +. We do this in
  // the page so SVG path geometry + the +'s screen coords share one frame (after the
  // canvas transform, both the path and the + are scaled identically).
  for (const p of all) {
    const ok = await page.getByTestId('campaign-connectors').evaluate(
      (svg, ctx) => {
        const paths = Array.from(svg.querySelectorAll('path')) as SVGPathElement[];
        // Convert the +'s screen point into the SVG's local coordinate via getScreenCTM.
        const ctm = (svg as SVGSVGElement).getScreenCTM();
        if (!ctm) return false;
        const inv = ctm.inverse();
        const toLocal = (sx: number, sy: number): { x: number; y: number } => {
          const pt = (svg as SVGSVGElement).createSVGPoint();
          pt.x = sx;
          pt.y = sy;
          const lp = pt.matrixTransform(inv);
          return { x: lp.x, y: lp.y };
        };
        const at = toLocal(ctx.cx, ctx.cy);
        const above = toLocal(ctx.cx, ctx.cy - ctx.pad);
        const below = toLocal(ctx.cx, ctx.cy + ctx.pad);
        // A path "covers" a probe point if the point is within 3 local px of the path
        // outline (the stroke). isPointInStroke needs a width; approximate via stroke.
        const covers = (path: SVGPathElement, q: { x: number; y: number }): boolean => {
          const pt = (svg as SVGSVGElement).createSVGPoint();
          pt.x = q.x;
          pt.y = q.y;
          // Widen tolerance: check a small cross of offsets.
          for (const [dx, dy] of [[0, 0], [2, 0], [-2, 0], [0, 2], [0, -2]]) {
            pt.x = q.x + dx;
            pt.y = q.y + dy;
            if (path.isPointInStroke(pt)) return true;
          }
          return false;
        };
        return paths.some((path) => covers(path, above) && covers(path, at) && covers(path, below));
      },
      { cx: p.cx, cy: p.cy, pad: PAD },
    );
    expect(ok, `+ at screen (${Math.round(p.cx)},${Math.round(p.cy)}) lacks a line above AND below`).toBe(true);
  }

  // v0.42.1: each ARM's CLOSING + (the append-+ right after the arm's last node) must have
  // a COMFORTABLE line above it — consistent with the centered trunk +s — not the bare
  // minimum. We probe the connector stroke well above the + center (cy − TOP_PROBE, where
  // TOP_PROBE ≈ PLUS_TOP_GAP·0.6 screen px): a hit there means a real vertical spacer runs
  // above the +. The two closing arm +s are the lowest edge-insert + in each arm column.
  const cb = await conditionBottom(page);
  const armColPluses = pluses.filter((p) => p.cy > cb); // the two arm columns' +s
  // Group by x-column, take the LOWEST + in each (the arm's closing-edge append-+).
  const byCol = new Map<number, { cx: number; cy: number }>();
  for (const p of armColPluses) {
    const colKey = Math.round(p.cx / 8) * 8;
    const cur = byCol.get(colKey);
    if (!cur || p.cy > cur.cy) byCol.set(colKey, p);
  }
  const closingPluses = [...byCol.values()];
  expect(closingPluses.length, 'expected two arm closing +s (one per arm column)').toBeGreaterThanOrEqual(2);
  const TOP_PROBE = Math.round(44 * 0.6); // ≈ PLUS_TOP_GAP·0.6 screen px above the + center
  for (const p of closingPluses) {
    const ok = await page.getByTestId('campaign-connectors').evaluate(
      (svg, ctx) => {
        const paths = Array.from(svg.querySelectorAll('path')) as SVGPathElement[];
        const ctm = (svg as SVGSVGElement).getScreenCTM();
        if (!ctm) return false;
        const inv = ctm.inverse();
        const pt = (svg as SVGSVGElement).createSVGPoint();
        const probe = (sx: number, sy: number): boolean => {
          pt.x = sx;
          pt.y = sy;
          const lp = pt.matrixTransform(inv);
          for (const [dx, dy] of [[0, 0], [2, 0], [-2, 0], [0, 2], [0, -2]]) {
            pt.x = lp.x + dx;
            pt.y = lp.y + dy;
            const local = (svg as SVGSVGElement).createSVGPoint();
            local.x = lp.x + dx;
            local.y = lp.y + dy;
            if (paths.some((path) => path.isPointInStroke(local))) return true;
          }
          return false;
        };
        // Stroke well ABOVE the + center → a comfortable top spacer (≥ ~PLUS_TOP_GAP·0.6).
        return probe(ctx.cx, ctx.cy - ctx.top);
      },
      { cx: p.cx, cy: p.cy, top: TOP_PROBE },
    );
    expect(ok, `arm closing + at (${Math.round(p.cx)},${Math.round(p.cy)}) lacks a COMFORTABLE line above (≥ ~PLUS_TOP_GAP)`).toBe(true);
  }

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

test('MOVE a single-out node onto an empty-If arm (the shared-merge bug): the + IS offered on the arm, the step relocates', async ({ page }) => {
  await openCampaigns(page);
  await page.getByTestId('campaign-new').click();
  await page.getByTestId('campaign-name').fill('Move onto arm');

  // Build trigger → If(empty arms: onTrue & onFalse BOTH → update) → update → exit:
  //  1) insert an Update profile on trigger→exit_1  ⇒ trigger→update→exit_1
  await page.getByTestId('campaign-edge-insert').first().click();
  await page.getByTestId('palette-update-profile').click();
  await expect(page.getByTestId('node-set_attribute')).toBeVisible();
  //  2) insert an If on trigger→update ⇒ trigger→cond(onTrue→update, onFalse→update)
  //     (the first (+), the trunk edge above the update, is trigger→update).
  await page.getByTestId('campaign-edge-insert').first().click();
  await page.getByTestId('palette-if').click();
  await expect(page.getByTestId('node-condition')).toBeVisible();

  // The condition's two empty arms both point AT the update (the shared merge). The
  // update card sits BELOW the condition.
  const condTop0 = (await page.getByTestId('node-condition').boundingBox())!.y;
  const updTop0 = (await page.getByTestId('node-set_attribute').boundingBox())!.y;
  expect(updTop0).toBeGreaterThan(condTop0);

  // Open the update's ⋮ → "Move to…" → placement mode. The BUG was: NO + appeared on
  // the arm edges. Now both arm edges are valid destinations.
  const updCard = page.getByTestId('node-set_attribute');
  await updCard.getByLabel('Step actions').click();
  await updCard.getByTestId('node-move').click();
  await expect(page.getByTestId('placement-banner')).toBeVisible();

  // A placement target (+) IS present on the If's arm edges (the fix). During
  // placement the (+) controls carry the `placement-target` testid; the two arm
  // edges (cond→update) anchor BELOW the condition card top (only the trunk
  // trigger→cond edge sits above it). Pick an arm target.
  const condTopForPick = (await page.getByTestId('node-condition').boundingBox())!.y;
  const targetTops = await page
    .getByTestId('placement-target')
    .evaluateAll((els) => els.map((e) => (e as HTMLElement).getBoundingClientRect().top));
  const armTargets = targetTops
    .map((top, i) => ({ top, i }))
    .filter((t) => t.top > condTopForPick)
    .map((t) => t.i);
  expect(armTargets.length).toBeGreaterThanOrEqual(1);
  await page.getByTestId('placement-target').nth(armTargets[0]!).click();
  await expect(page.getByTestId('placement-banner')).toHaveCount(0);
  await expect(page.getByTestId('toast')).toContainText(/moved/i);

  // The update now sits ON an arm (still below the condition, exactly one card).
  await expect(page.getByTestId('node-set_attribute')).toHaveCount(1);
  const condTop1 = (await page.getByTestId('node-condition').boundingBox())!.y;
  const updTop1 = (await page.getByTestId('node-set_attribute').boundingBox())!.y;
  expect(updTop1).toBeGreaterThan(condTop1);

  // Round-trips through the DSL: reopen and the graph reconstructs.
  await page.getByTestId('campaigns-back').click();
  await page.getByTestId('campaign-item').filter({ hasText: 'Move onto arm' }).getByTestId('campaign-open').click();
  await page.getByTestId('campaign-canvas').waitFor();
  await expect(page.getByTestId('node-condition')).toBeVisible();
  await expect(page.getByTestId('node-set_attribute')).toHaveCount(1);
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

test('DUPLICATE a branch AFTER itself via the merge (+) — the copy runs after the original', async ({ page }) => {
  await openCampaigns(page);
  await page.getByTestId('campaign-new').click();
  await page.getByTestId('campaign-name').fill('Dupe branch after');

  // A single branch on the trunk whose arms rejoin the only exit:
  //   trigger → cond(onTrue → wait → exit_1, onFalse → exit_1).
  await page.getByTestId('campaign-edge-insert').first().click();
  await page.getByTestId('palette-if').click();
  await expect(page.getByTestId('node-condition')).toHaveCount(1);
  const arms = await armInsertIndices(page, await conditionBottom(page));
  await page.getByTestId('campaign-edge-insert').nth(arms[0]!).click();
  await page.getByTestId('palette-wait').click();
  await expect(page.getByTestId('node-wait')).toHaveCount(1);

  // ⋮ on the If → "Duplicate…" → the merge (+) below the branch is now a drop target.
  const condCard = page.getByTestId('node-condition');
  await condCard.getByLabel('Step actions').click();
  await condCard.getByTestId('node-duplicate').click();
  await expect(page.getByTestId('placement-banner')).toContainText(/copy/i);
  await expect(page.getByTestId('placement-merge-target')).toBeVisible();
  await page.getByTestId('placement-merge-target').click();
  await expect(page.getByTestId('placement-banner')).toHaveCount(0);
  await expect(page.getByTestId('toast')).toContainText(/duplicated/i);

  // A SECOND condition (and a second wait) now exist — the copy runs after the original.
  await expect(page.getByTestId('node-condition')).toHaveCount(2);
  await expect(page.getByTestId('node-wait')).toHaveCount(2);

  await page.getByTestId('save-campaign').click();
  await expect(page.getByTestId('toast').first()).toBeVisible();
});

test('MOVE a node AFTER a branch via the merge (+) — relocates it past the convergence', async ({ page }) => {
  await openCampaigns(page);
  await page.getByTestId('campaign-new').click();
  await page.getByTestId('campaign-name').fill('Move after branch');

  // A single branch whose arms rejoin the only exit, with a wait on the Yes arm:
  //   trigger → cond(onTrue → wait → exit_1, onFalse → exit_1).
  await page.getByTestId('campaign-edge-insert').first().click();
  await page.getByTestId('palette-if').click();
  await expect(page.getByTestId('node-condition')).toHaveCount(1);
  const arms = await armInsertIndices(page, await conditionBottom(page));
  await page.getByTestId('campaign-edge-insert').nth(arms[0]!).click();
  await page.getByTestId('palette-wait').click();
  await expect(page.getByTestId('node-wait')).toHaveCount(1);

  // ⋮ on the wait → "Move…" → the merge (+) below the branch is now a drop target IN MOVE
  // MODE (the fix: it used to be offered only for Duplicate).
  const waitCard = page.getByTestId('node-wait');
  await waitCard.getByLabel('Step actions').click();
  await waitCard.getByTestId('node-move').click();
  await expect(page.getByTestId('placement-banner')).toContainText(/move/i);
  await expect(page.getByTestId('placement-merge-target')).toBeVisible();
  await page.getByTestId('placement-merge-target').click();
  await expect(page.getByTestId('placement-banner')).toHaveCount(0);
  await expect(page.getByTestId('toast')).toContainText(/moved/i);

  // Still ONE wait (relocated, not copied) and it now sits BELOW the condition's arms —
  // i.e. after the convergence, before the exit.
  await expect(page.getByTestId('node-wait')).toHaveCount(1);
  const condBottom = (await page.getByTestId('node-condition').boundingBox())!.y + (await page.getByTestId('node-condition').boundingBox())!.height;
  expect((await page.getByTestId('node-wait').boundingBox())!.y).toBeGreaterThan(condBottom);

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
