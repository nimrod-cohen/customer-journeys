// Unit: rounded orthogonal connector paths — diagonal-free by construction (§9B
// phase 5) + LANE routing (the converging-diamond rework). Tokenizes the emitted
// `d` and asserts every drawn run changes only x OR only y, and that the (+) anchor
// always lands ON a vertical run of the path. Pure.
import { describe, it, expect } from 'vitest';
import { orthogonalPath, verticalAnchor, edgeMidpoint, CORNER_RADIUS, MIN_SEGMENT, type Point } from './orthogonal-path.js';

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
    // 2) a jog (fanned arm — distinct target column): the LOWER V leg is the anchor run.
    {
      const from = { x: 300, y: y0 };
      const to = { x: 120, y: y1 };
      const a = verticalAnchor(from, to);
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

  it('a jog edge: the anchor sits on the LOWER vertical leg (at to.x), on the path', () => {
    const from = { x: 100, y: 50 };
    const to = { x: 340, y: 250 };
    const a = verticalAnchor(from, to);
    expect(a.x).toBe(to.x);
    assertOnVerticalRun(orthogonalPath(from, to), a);
  });

  it('a full LANE route: the anchor sits on the lane vertical (at laneX), on the path', () => {
    const from = { x: 300, y: 100 };
    const to = { x: 300, y: 400 };
    const laneX = 272;
    const a = verticalAnchor(from, to, laneX);
    expect(a.x).toBe(laneX);
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

  it('two converging FANNED arms (distinct target x) also get distinct anchors', () => {
    const source = { x: 300, y: 100 };
    const yesMid = verticalAnchor(source, { x: 120, y: 300 });
    const noMid = verticalAnchor(source, { x: 480, y: 300 });
    expect(yesMid.x).not.toBe(noMid.x);
  });
});

describe('edgeMidpoint (legacy alias → verticalAnchor)', () => {
  it('stays directly below the source for a straight-down edge (same x)', () => {
    expect(edgeMidpoint({ x: 100, y: 50 }, { x: 100, y: 250 })).toEqual({ x: 100, y: 150 });
  });
});
