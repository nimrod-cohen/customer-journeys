// A small square overview of the whole automation map, pinned to the canvas's
// bottom-right corner. It shows every step and connector, plus a rectangle for the
// part of the map currently on screen. Clicking or dragging on it moves the view.
import { useEffect, useRef, useState } from 'preact/hooks';
import type { JSX } from 'preact';
import { LAYOUT, type Layout } from './layout.js';
import { orthogonalPath } from './orthogonal-path.js';

/** Side of the square, in px. */
export const MINIMAP_SIZE = 168;
/** Inner margin so the map never touches the frame. */
const INSET = 10;

export interface MinimapFit {
  /** Minimap px per layout px. */
  readonly k: number;
  /** Offset that centres the map inside the square. */
  readonly ox: number;
  readonly oy: number;
}

/** Scale the whole layout into the square, keeping its proportions, centred. */
export function minimapFit(width: number, height: number, size = MINIMAP_SIZE): MinimapFit {
  const inner = size - 2 * INSET;
  const k = Math.min(inner / Math.max(width, 1), inner / Math.max(height, 1));
  return { k, ox: (size - width * k) / 2, oy: (size - height * k) / 2 };
}

/**
 * The visible part of the map, in layout px. The canvas offsets its content by one
 * viewport of padding (`pad`) and draws it at `scale * unit` screen px per layout px.
 */
export function visibleRect(
  scroll: { left: number; top: number; width: number; height: number },
  pad: { x: number; y: number },
  pxPerLayout: number,
): { x: number; y: number; w: number; h: number } {
  return {
    x: (scroll.left - pad.x) / pxPerLayout,
    y: (scroll.top - pad.y) / pxPerLayout,
    w: scroll.width / pxPerLayout,
    h: scroll.height / pxPerLayout,
  };
}

export function Minimap(props: {
  readonly layout: Layout;
  readonly viewportRef: { readonly current: HTMLDivElement | null };
  readonly pad: { x: number; y: number };
  /** Screen px per layout px (zoom × text-size unit). */
  readonly pxPerLayout: number;
  readonly selectedNodeId?: string | null | undefined;
}): JSX.Element | null {
  const { layout, viewportRef, pad, pxPerLayout } = props;
  const [, setTick] = useState(0);
  const dragging = useRef(false);

  // Redraw the "you are here" box whenever the canvas scrolls or resizes.
  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return undefined;
    const bump = (): void => setTick((t) => t + 1);
    el.addEventListener('scroll', bump, { passive: true });
    const ro = new ResizeObserver(bump);
    ro.observe(el);
    return () => {
      el.removeEventListener('scroll', bump);
      ro.disconnect();
    };
  }, [viewportRef]);

  const el = viewportRef.current;
  if (layout.positions.size === 0) return null;
  const fit = minimapFit(layout.width, layout.height);
  const view = el
    ? visibleRect({ left: el.scrollLeft, top: el.scrollTop, width: el.clientWidth, height: el.clientHeight }, pad, pxPerLayout)
    : null;

  // Move the canvas so the clicked point of the map is in the middle of the screen.
  const centerAt = (e: PointerEvent): void => {
    const vp = viewportRef.current;
    if (!vp) return;
    const box = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
    const lx = (e.clientX - box.left - fit.ox) / fit.k;
    const ly = (e.clientY - box.top - fit.oy) / fit.k;
    vp.scrollLeft = pad.x + lx * pxPerLayout - vp.clientWidth / 2;
    vp.scrollTop = pad.y + ly * pxPerLayout - vp.clientHeight / 2;
  };

  // Clamp the view box to the square so it stays readable when panned far off.
  const clampBox = (x: number, y: number, w: number, h: number) => {
    const x0 = Math.max(1, x);
    const y0 = Math.max(1, y);
    const x1 = Math.min(MINIMAP_SIZE - 1, x + w);
    const y1 = Math.min(MINIMAP_SIZE - 1, y + h);
    return x1 > x0 && y1 > y0 ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null;
  };
  const box = view ? clampBox(fit.ox + view.x * fit.k, fit.oy + view.y * fit.k, view.w * fit.k, view.h * fit.k) : null;

  return (
    <div
      data-testid="canvas-minimap"
      class="absolute bottom-3 right-3 z-20 overflow-hidden rounded-lg border border-stone-200 bg-surface/90 shadow-sm backdrop-blur"
      style={{ width: `${MINIMAP_SIZE}px`, height: `${MINIMAP_SIZE}px` }}
    >
      <svg
        width={MINIMAP_SIZE}
        height={MINIMAP_SIZE}
        class="block cursor-pointer touch-none"
        aria-label="Map overview — click to move there"
        onPointerDown={(e) => {
          dragging.current = true;
          (e.currentTarget as SVGSVGElement).setPointerCapture(e.pointerId);
          centerAt(e);
        }}
        onPointerMove={(e) => {
          if (dragging.current) centerAt(e);
        }}
        onPointerUp={() => {
          dragging.current = false;
        }}
        onPointerCancel={() => {
          dragging.current = false;
        }}
      >
        <g transform={`translate(${fit.ox} ${fit.oy}) scale(${fit.k})`}>
          {layout.edges.map((e) => (
            <path
              key={`mm-${e.from}-${e.slot}-${e.to}`}
              d={orthogonalPath(e.fromPoint, e.toPoint, e.laneX, undefined, e.kneeTop, e.closeKnee, e.crossY)}
              fill="none"
              class="stroke-slate-300"
              stroke-width={1.5}
              vector-effect="non-scaling-stroke"
            />
          ))}
          {[...layout.positions.entries()].map(([id, p]) => (
            <rect
              key={`mm-n-${id}`}
              data-testid="canvas-minimap-node"
              x={p.x - LAYOUT.cardWidth / 2}
              y={p.y}
              width={LAYOUT.cardWidth}
              height={LAYOUT.cardHeight}
              rx={12}
              class={id === props.selectedNodeId ? 'fill-brand-400' : 'fill-stone-300'}
            />
          ))}
        </g>
        {box ? (
          <rect
            data-testid="canvas-minimap-view"
            x={box.x}
            y={box.y}
            width={box.w}
            height={box.h}
            rx={3}
            class="fill-brand-500/10 stroke-brand-500"
            stroke-width={1.5}
          />
        ) : null}
      </svg>
    </div>
  );
}
