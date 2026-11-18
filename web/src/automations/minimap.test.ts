import { describe, it, expect } from 'vitest';
import { minimapFit, visibleRect, MINIMAP_SIZE } from './Minimap.js';

describe('minimap geometry', () => {
  it('fits a tall map by its height and centres it sideways', () => {
    const f = minimapFit(400, 1600);
    expect(1600 * f.k).toBeCloseTo(MINIMAP_SIZE - 20);
    expect(f.ox).toBeCloseTo((MINIMAP_SIZE - 400 * f.k) / 2);
    expect(f.oy).toBeCloseTo(10);
  });

  it('turns the scroll position into the visible part of the map', () => {
    // Content starts one viewport (pad) in, drawn at 2 screen px per layout px.
    const r = visibleRect({ left: 1000 + 200, top: 600 + 100, width: 1000, height: 600 }, { x: 1000, y: 600 }, 2);
    expect(r).toEqual({ x: 100, y: 50, w: 500, h: 300 });
  });
});

describe('pan limits', () => {
  it('lets the map scroll until its outermost step reaches the opposite edge, with a margin', async () => {
    const { panPadding, PAN_EDGE_MARGIN } = await import('./AutomationCanvas.js');
    const { LAYOUT } = await import('./layout.js');
    const p = panPadding({ w: 1000, h: 600 }, 1.25);
    expect(p.x).toBe(Math.round(1000 - PAN_EDGE_MARGIN - (LAYOUT.padX + LAYOUT.cardWidth) * 1.25));
    expect(p.y).toBe(Math.round(600 - PAN_EDGE_MARGIN - (LAYOUT.padY + LAYOUT.cardHeight) * 1.25));
    expect(panPadding({ w: 100, h: 100 }, 2)).toEqual({ x: 0, y: 0 });
  });
});
