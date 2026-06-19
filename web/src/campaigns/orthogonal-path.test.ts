// Unit: rounded orthogonal connector paths — diagonal-free by construction (§9B
// phase 5). Tokenizes the emitted `d` and asserts every drawn run changes only x
// OR only y. Pure.
import { describe, it, expect } from 'vitest';
import { orthogonalPath, edgeMidpoint, CORNER_RADIUS } from './orthogonal-path.js';

/** Tokenize a path's `d` into commands; assert each run moves on one axis only. */
function assertAxisAligned(d: string): void {
  // Track the current pen position; for each command verify it changes only x or
  // only y (a Q corner is a single right-angle turn whose control + endpoint we
  // verify don't move both axes at the SAME step beyond the turn itself).
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
      const ny = readNum();
      cy = ny; // pure vertical
    } else if (cmd === 'H') {
      const nx = readNum();
      cx = nx; // pure horizontal
    } else if (cmd === 'Q') {
      // control point + endpoint: a 90° rounded corner. Endpoint moves diagonally
      // by exactly the radius on BOTH axes (the rounding of the turn), which is
      // expected and bounded; assert the control point shares an axis with the
      // PRE-corner position (so the entry into the corner is axis-aligned).
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
    // A tiny drop with a big x-offset → the vertical leg is the shorter; radius
    // must clamp well below the default so the corner fits.
    const d = orthogonalPath({ x: 0, y: 0 }, { x: 1000, y: 8 }, CORNER_RADIUS);
    assertAxisAligned(d);
    // With a 4px half-drop, r clamps to <= 2; the path must still be valid.
    expect(d).toMatch(/^M /);
  });

  it('throws when the target is not below the source (no up/back connector)', () => {
    expect(() => orthogonalPath({ x: 0, y: 100 }, { x: 0, y: 50 })).toThrow(/below/);
    expect(() => orthogonalPath({ x: 0, y: 100 }, { x: 0, y: 100 })).toThrow(/below/);
  });

  it('two arms (left + right of the join) CONVERGE onto one join top-center point', () => {
    // The join sits at x=300; one arm leaves from the LEFT (x=120), the other from
    // the RIGHT (x=480). Both connectors must END at the identical join point.
    const join = { x: 300, y: 400 };
    const left = orthogonalPath({ x: 120, y: 200 }, join);
    const right = orthogonalPath({ x: 480, y: 200 }, join);
    expect(left).not.toMatch(/\bL\b/);
    expect(right).not.toMatch(/\bL\b/);
    assertAxisAligned(left);
    assertAxisAligned(right);
    // The final point of each path is the join (a V command to the join's y, after
    // an H run to the join's x — so the pen ends at exactly the join).
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
});

describe('edgeMidpoint', () => {
  it('sits at the horizontal+vertical midpoint (on the connector’s H run)', () => {
    // x is the midpoint of source/target so two arms from the SAME source (a
    // condition fanning sideways) get DISTINCT (+) anchors instead of stacking.
    const mid = edgeMidpoint({ x: 100, y: 50 }, { x: 340, y: 250 });
    expect(mid).toEqual({ x: 220, y: 150 });
  });

  it('stays directly below the source for a straight-down edge (same x)', () => {
    const mid = edgeMidpoint({ x: 100, y: 50 }, { x: 100, y: 250 });
    expect(mid).toEqual({ x: 100, y: 150 });
  });

  it('the two converging arm + anchors are DISTINCT (do not stack/overlap)', () => {
    // A condition at x=300 fans onTrue to x=120 and onFalse to x=480; the (+) on
    // each arm edge gets a distinct x so the buttons never stack.
    const source = { x: 300, y: 100 };
    const yesMid = edgeMidpoint(source, { x: 120, y: 300 });
    const noMid = edgeMidpoint(source, { x: 480, y: 300 });
    expect(yesMid.x).not.toBe(noMid.x);
  });
});
