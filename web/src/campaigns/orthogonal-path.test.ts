// Unit: rounded orthogonal connector paths — diagonal-free by construction (§9B
// phase 5) + LANE routing (the converging-diamond rework). Tokenizes the emitted
// `d` and asserts every drawn run changes only x OR only y, and that the (+) anchor
// always lands ON a vertical run of the path. Pure.
import { describe, it, expect } from 'vitest';
import { orthogonalPath, verticalAnchor, edgeMidpoint, closeKneeLowerRun, CORNER_RADIUS, MIN_SEGMENT, type Point } from './orthogonal-path.js';

/** The tallest vertical run on which `p` (the (+) anchor) lies, if any. */
function anchorRunHeight(d: string, p: Point): number | null {
  const runs = verticalRuns(d).filter(
    (r) => Math.abs(r.x - p.x) < 1e-6 && p.y >= r.y0 - 1e-6 && p.y <= r.y1 + 1e-6,
  );
  if (runs.length === 0) return null;
  return Math.max(...runs.map((r) => r.y1 - r.y0));
}

/** A realistic laid-out drop between two adjacent cards (LAYOUT.rowHeight − cardHeight). */
const LAID_OUT_DROP = 112;

/** Tokenize a path's `d` into commands; assert each run moves on one axis only. */
function assertAxisAligned(d: string): void {
  const tokens = d.trim().split(/\s+/);
  let i = 0;
  let cx = 0;
  let cy = 0;
  const readNum = (): number => Number(tokens[i++]);
  while (i < tokens.length) {
    const cmd = tokens[i++];
    if (cmd === 'M') {
      cx = readNum();
      cy = readNum();
    } else if (cmd === 'V') {
      cy = readNum();
    } else if (cmd === 'H') {
      cx = readNum();
    } else if (cmd === 'Q') {
      const cpx = readNum();
      const cpy = readNum();
      const ex = readNum();
      const ey = readNum();
      const entryAligned = cpx === cx || cpy === cy;
      expect(entryAligned).toBe(true);
      cx = ex;
      cy = ey;
    } else {
      throw new Error(`unexpected command "${cmd}" in orthogonal path: ${d}`);
    }
  }
}

/** Collect the VERTICAL runs of a path as {x, y0, y1} (y0<y1), tracing the pen. */
function verticalRuns(d: string): Array<{ x: number; y0: number; y1: number }> {
  const tokens = d.trim().split(/\s+/);
  let i = 0;
  let cx = 0;
  let cy = 0;
  const n = (): number => Number(tokens[i++]);
  const runs: Array<{ x: number; y0: number; y1: number }> = [];
  while (i < tokens.length) {
    const cmd = tokens[i++];
    if (cmd === 'M') {
      cx = n();
      cy = n();
    } else if (cmd === 'V') {
      const ny = n();
      runs.push({ x: cx, y0: Math.min(cy, ny), y1: Math.max(cy, ny) });
      cy = ny;
    } else if (cmd === 'H') {
      cx = n();
    } else if (cmd === 'Q') {
      n();
      n();
      cx = n();
      cy = n();
    }
  }
  return runs;
}

/** Assert `p` sits ON some vertical run of `d` (its x equals that run's x, its y
 *  within [y0,y1]) — the (+) anchor contract. */
function assertOnVerticalRun(d: string, p: Point): void {
  const runs = verticalRuns(d);
  const hit = runs.some((r) => Math.abs(r.x - p.x) < 1e-6 && p.y >= r.y0 - 1e-6 && p.y <= r.y1 + 1e-6);
  expect(hit, `anchor ${JSON.stringify(p)} not on a vertical run of ${d}; runs=${JSON.stringify(runs)}`).toBe(true);
}

describe('orthogonalPath', () => {
  it('a straight-down child is a single vertical segment', () => {
    const d = orthogonalPath({ x: 100, y: 50 }, { x: 100, y: 200 });
    expect(d).toBe('M 100 50 V 200');
    assertAxisAligned(d);
  });

  it('an x-offset target jogs with rounded (Q) corners, never a diagonal L', () => {
    const d = orthogonalPath({ x: 100, y: 50 }, { x: 340, y: 200 });
    expect(d).toContain('Q');
    expect(d).not.toMatch(/\bL\b/);
    assertAxisAligned(d);
  });

  it('clamps the corner radius to half the shorter leg (no overshoot)', () => {
    const d = orthogonalPath({ x: 0, y: 0 }, { x: 1000, y: 8 }, undefined, CORNER_RADIUS);
    assertAxisAligned(d);
    expect(d).toMatch(/^M /);
  });

  it('throws when the target is not below the source (no up/back connector)', () => {
    expect(() => orthogonalPath({ x: 0, y: 100 }, { x: 0, y: 50 })).toThrow(/below/);
    expect(() => orthogonalPath({ x: 0, y: 100 }, { x: 0, y: 100 })).toThrow(/below/);
  });

  it('two arms (left + right of the join) CONVERGE onto one join top-center point', () => {
    const join = { x: 300, y: 400 };
    const left = orthogonalPath({ x: 120, y: 200 }, join);
    const right = orthogonalPath({ x: 480, y: 200 }, join);
    expect(left).not.toMatch(/\bL\b/);
    expect(right).not.toMatch(/\bL\b/);
    assertAxisAligned(left);
    assertAxisAligned(right);
    const endOf = (d: string): { x: number; y: number } => {
      const t = d.trim().split(/\s+/);
      let x = 0;
      let y = 0;
      let i = 0;
      const num = (): number => Number(t[i++]);
      while (i < t.length) {
        const cmd = t[i++];
        if (cmd === 'M') { x = num(); y = num(); }
        else if (cmd === 'V') { y = num(); }
        else if (cmd === 'H') { x = num(); }
        else if (cmd === 'Q') { num(); num(); x = num(); y = num(); }
      }
      return { x, y };
    };
    expect(endOf(left)).toEqual(join);
    expect(endOf(right)).toEqual(join);
  });

  it('LANE route (laneX distinct from both x): a clean rectangle with a real lane V', () => {
    // Source above, join straight below at the SAME x — but route DOWN a left lane.
    const from = { x: 300, y: 100 };
    const to = { x: 300, y: 400 };
    const laneX = 272; // a distinct left lane
    const d = orthogonalPath(from, to, laneX);
    assertAxisAligned(d);
    expect(d).not.toMatch(/\bL\b/);
    // The path must contain a vertical run AT the lane x (the middle-third lane).
    const runs = verticalRuns(d);
    expect(runs.some((r) => Math.abs(r.x - laneX) < 1e-6 && r.y1 > r.y0)).toBe(true);
    // It still lands exactly on the join.
    const last = runs[runs.length - 1]!;
    expect(last.y1).toBe(400);
  });

  it('lane route collapses to the classic jog when laneX === to.x', () => {
    const from = { x: 300, y: 100 };
    const to = { x: 120, y: 400 };
    const withLane = orthogonalPath(from, to, 120);
    const plain = orthogonalPath(from, to);
    expect(withLane).toBe(plain);
  });

  it('every routing mode keeps the (+) anchor on a vertical run ≥ MIN_SEGMENT for a laid-out drop', () => {
    const y0 = 100;
    const y1 = y0 + LAID_OUT_DROP;
    // 1) straight-down trunk (single V).
    {
      const from = { x: 300, y: y0 };
      const to = { x: 300, y: y1 };
      const a = verticalAnchor(from, to);
      const h = anchorRunHeight(orthogonalPath(from, to), a);
      expect(h).not.toBeNull();
      expect(h!).toBeGreaterThanOrEqual(MIN_SEGMENT);
    }
    // 2) a jog (fanned arm — distinct target column): the UPPER V leg (at from.x) is
    //    the anchor run, straight below the source before the turn.
    {
      const from = { x: 300, y: y0 };
      const to = { x: 120, y: y1 };
      const a = verticalAnchor(from, to);
      expect(a.x).toBe(from.x); // straight below the SOURCE, not on the lower leg
      const h = anchorRunHeight(orthogonalPath(from, to), a);
      expect(h).not.toBeNull();
      expect(h!).toBeGreaterThanOrEqual(MIN_SEGMENT);
    }
    // 3) a full lane route (empty arm — side lane to a directly-below join).
    {
      const from = { x: 300, y: y0 };
      const to = { x: 300, y: y1 };
      const laneX = 272;
      const a = verticalAnchor(from, to, laneX);
      const h = anchorRunHeight(orthogonalPath(from, to, laneX), a);
      expect(h).not.toBeNull();
      expect(h!).toBeGreaterThanOrEqual(MIN_SEGMENT);
    }
  });
});

describe('verticalAnchor', () => {
  it('straight-down edge: the vertical midpoint', () => {
    expect(verticalAnchor({ x: 100, y: 50 }, { x: 100, y: 250 })).toEqual({ x: 100, y: 150 });
  });

  it('a jog edge: the anchor sits on the UPPER source-side leg (at from.x), straight below the source, on the path', () => {
    const from = { x: 100, y: 50 };
    const to = { x: 340, y: 250 };
    const a = verticalAnchor(from, to);
    expect(a.x).toBe(from.x); // the column straight below the SOURCE, before the turn
    // UPPER portion: closer to the source than the target.
    expect(a.y).toBeLessThan((from.y + to.y) / 2);
    assertOnVerticalRun(orthogonalPath(from, to), a);
  });

  it('a full LANE route: the anchor sits HIGH on the lane vertical (at laneX), on the path', () => {
    const from = { x: 300, y: 100 };
    const to = { x: 300, y: 400 };
    const laneX = 272;
    const a = verticalAnchor(from, to, laneX);
    expect(a.x).toBe(laneX);
    // UPPER portion of the lane run — closer to the source than the target.
    expect(a.y).toBeLessThan((from.y + to.y) / 2);
    assertOnVerticalRun(orthogonalPath(from, to, laneX), a);
  });

  it('two converging EMPTY arms get DISTINCT lane anchors (no stacking) — each on its lane V', () => {
    // A condition at x=300 with a join straight below at x=300; the two empty arms
    // route down a LEFT lane and a RIGHT lane. Their (+) anchors must differ in x.
    const source = { x: 300, y: 100 };
    const join = { x: 300, y: 400 };
    const leftLane = 272;
    const rightLane = 328;
    const yes = verticalAnchor(source, join, leftLane);
    const no = verticalAnchor(source, join, rightLane);
    expect(yes.x).not.toBe(no.x);
    assertOnVerticalRun(orthogonalPath(source, join, leftLane), yes);
    assertOnVerticalRun(orthogonalPath(source, join, rightLane), no);
  });

  it('two POPULATED arms (top knee) anchor on their CHILD columns — distinct x, ABOVE the child', () => {
    // A populated arm routes down its child's column (laneX === to.x) with kneeTop:
    // a short stub down from the If center, ONE knee across, then the long vertical
    // DOWN the child column — so the (+) anchors on that column, directly above the
    // child, at a DISTINCT x per arm (the two children sit in distinct columns).
    const source = { x: 300, y: 100 };
    const yesMid = verticalAnchor(source, { x: 120, y: 300 }, 120, true);
    const noMid = verticalAnchor(source, { x: 480, y: 300 }, 480, true);
    expect(yesMid.x).not.toBe(noMid.x);
    expect(yesMid.x).toBe(120); // on the LEFT child column (not the source center)
    expect(noMid.x).toBe(480); // on the RIGHT child column
  });
});

describe('orthogonalPath (top-knee populated arm)', () => {
  it('a top-knee arm has its single knee near the TOP and the long V on the child column', () => {
    const from = { x: 300, y: 100 };
    const to = { x: 120, y: 100 + LAID_OUT_DROP };
    const d = orthogonalPath(from, to, 120, undefined, true);
    assertAxisAligned(d);
    expect(d).not.toMatch(/\bL\b/);
    // Exactly one horizontal run (one knee).
    expect(d.trim().split(/\s+/).filter((t) => t === 'H').length).toBe(1);
    // The (+) anchor sits on the long lower leg at the CHILD x (to.x).
    const a = verticalAnchor(from, to, 120, true);
    expect(a.x).toBe(to.x);
    assertOnVerticalRun(d, a);
    const h = anchorRunHeight(d, a);
    expect(h).not.toBeNull();
    expect(h!).toBeGreaterThanOrEqual(MIN_SEGMENT);
    // The long leg (anchor run) is LONGER than the short upper stub.
    const runs = verticalRuns(d);
    const childRun = runs.find((r) => Math.abs(r.x - to.x) < 1e-6)!;
    const stub = runs.find((r) => Math.abs(r.x - from.x) < 1e-6)!;
    expect(childRun.y1 - childRun.y0).toBeGreaterThan(stub.y1 - stub.y0);
  });
});

describe('close-knee jog into a merge join — the central run the merge + anchors on', () => {
  it('the LOWER leg at join.x is the LONG central run; the arm + sits HIGH on the short upper leg (v0.41.9)', () => {
    // A closing jog (leaf → join): from a populated arm leaf, offset, into the join.
    const from = { x: 300, y: 100 };
    const to = { x: 200, y: 100 + LAID_OUT_DROP + 56 }; // + JOIN_MERGE_DROP room
    const d = orthogonalPath(from, to, to.x, undefined, false, true);
    assertAxisAligned(d);
    expect(d).not.toMatch(/\bL\b/);
    expect(d.trim().split(/\s+/).filter((t) => t === 'H').length).toBe(1); // one knee

    const run = closeKneeLowerRun(from, to);
    expect(run.y1).toBe(to.y); // ends at the join card top
    expect(run.y0).toBeGreaterThan(from.y); // starts below the source
    expect(run.y0).toBeLessThan(run.y1);
    // The lower leg is the LONG central run — it is the TALLER of the two legs (the
    // crossing is now near the TOP, a fixed inset below source). The merge (+) anchors
    // on it with a visible line above and below.
    const lowerRun = verticalRuns(d).find((r) => Math.abs(r.x - to.x) < 1e-6)!;
    const upperRun = verticalRuns(d).find((r) => Math.abs(r.x - from.x) < 1e-6)!;
    expect(lowerRun.y1 - lowerRun.y0).toBeGreaterThan(upperRun.y1 - upperRun.y0);
    expect(lowerRun.y1 - lowerRun.y0).toBeGreaterThanOrEqual(MIN_SEGMENT);

    // The ARM edge (+) on the SAME closing jog sits on the SHORT UPPER leg at from.x —
    // straight below its source, HIGH — NOT on the central merge run, NOT drifted down.
    const armPlus = verticalAnchor(from, to, to.x, false, true);
    expect(armPlus.x).toBe(from.x);
    expect(armPlus.y).toBeGreaterThan(upperRun.y0);
    expect(armPlus.y).toBeLessThan(upperRun.y1);
    // It sits HIGH — within the normal trunk gap below the source, not down the tail.
    expect(armPlus.y - from.y).toBeLessThan(LAID_OUT_DROP);
  });

  it('a LONG closing edge (short arm spanning the empty tail) STILL anchors the arm + right below the source', () => {
    // Short Yes arm: its last node sits HIGH but the join (set by the long arm) is far
    // below — a long closing edge. The arm + must stay just below the source node.
    const from = { x: 300, y: 100 };
    const longTail = { x: 200, y: 100 + LAID_OUT_DROP * 4 }; // join 4 rows down
    const armPlus = verticalAnchor(from, longTail, longTail.x, false, true);
    expect(armPlus.x).toBe(from.x);
    // High — within one normal trunk gap of the source, NOT near the far-below join.
    expect(armPlus.y - from.y).toBeLessThan(LAID_OUT_DROP);
    // The merge run (lower leg) for THIS long edge is correspondingly very tall.
    const run = closeKneeLowerRun(from, longTail);
    expect(run.y1 - run.y0).toBeGreaterThan(LAID_OUT_DROP * 3);
    // The arm + is far above the bottom of that run (well separated from the merge +).
    expect(run.y1 - armPlus.y).toBeGreaterThan(MIN_SEGMENT);
  });
});

describe('edgeMidpoint (legacy alias → verticalAnchor)', () => {
  it('stays directly below the source for a straight-down edge (same x)', () => {
    expect(edgeMidpoint({ x: 100, y: 50 }, { x: 100, y: 250 })).toEqual({ x: 100, y: 150 });
  });
});
