// Presentational campaign canvas (§9B phase 5): an auto-laid-out DOWNWARD tree of
// node cards over an SVG connector layer. Positions are COMPUTED every render
// (layoutDefinition) — there is NO drag and NO stored coordinate. Connectors are
// rounded ORTHOGONAL paths (orthogonalPath) — never diagonal, never upward. A (+)
// control on each edge opens the insert palette; each card has an ActionMenu with
// Delete. This component is pure UI: state (the CanvasModel) lives in the screen.
import type { JSX } from 'preact';
import { useState } from 'preact/hooks';
import { ActionMenu } from '../ui/kit.js';
import { layoutDefinition, LAYOUT, type LayoutEdge } from './layout.js';
import { orthogonalPath, edgeMidpoint } from './orthogonal-path.js';
import { buildDefinition, displayType, type CanvasModel, type CanvasEdge, type CanvasNode } from './model.js';
import { nodeSummary } from './mutate.js';

const ZOOM_MIN = 0.5;
const ZOOM_MAX = 1.5;
const ZOOM_STEP = 0.1;

const NODE_STYLE: Record<string, string> = {
  trigger: 'bg-brand-50 text-brand-700 ring-brand-200',
  wait: 'bg-amber-50 text-amber-700 ring-amber-200',
  wait_until: 'bg-amber-50 text-amber-700 ring-amber-200',
  hour_of_day_window: 'bg-amber-50 text-amber-700 ring-amber-200',
  condition: 'bg-violet-50 text-violet-700 ring-violet-200',
  send: 'bg-sky-50 text-sky-700 ring-sky-200',
  set_attribute: 'bg-teal-50 text-teal-700 ring-teal-200',
  webhook: 'bg-indigo-50 text-indigo-700 ring-indigo-200',
  action: 'bg-sky-50 text-sky-700 ring-sky-200',
  exit: 'bg-stone-100 text-stone-600 ring-stone-200',
};

const TYPE_LABEL: Record<string, string> = {
  trigger: 'Trigger',
  wait: 'Wait',
  wait_until: 'Wait until',
  hour_of_day_window: 'Hour window',
  condition: 'If / branch',
  send: 'Send email',
  set_attribute: 'Update profile',
  webhook: 'Webhook',
  action: 'Action',
  exit: 'Exit',
};

export function CampaignCanvas({
  model,
  onInsert,
  onDelete,
  onOpen,
  publishErrors,
}: {
  model: CanvasModel;
  onInsert: (edge: CanvasEdge) => void;
  onDelete: (node: CanvasNode) => void | Promise<void>;
  /** Open a node's config editor (card click / "Edit step"). */
  onOpen: (node: CanvasNode) => void;
  /** Per-node publish-gate reasons (node id → message), surfaced on the card. */
  publishErrors?: Readonly<Record<string, string>>;
}): JSX.Element {
  const layout = layoutDefinition(buildDefinition(model));

  // View-only zoom (does NOT touch the model — connector `d` coords are unchanged;
  // we scale the whole content container). Clamped 50%–150% in 10% steps.
  const [scale, setScale] = useState(1);
  const clampZoom = (z: number): number => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(z * 100) / 100));

  return (
    <div class="relative">
      {/* Zoom toolbar — floats over the top-right, outside the scroll viewport. */}
      <div class="absolute right-2 top-2 z-20 flex items-center gap-0.5 rounded-lg border border-stone-200 bg-white/90 p-1 text-stone-600 shadow-sm backdrop-blur">
        <button
          type="button"
          data-testid="canvas-zoom-out"
          aria-label="Zoom out"
          disabled={scale <= ZOOM_MIN}
          onClick={() => setScale((s) => clampZoom(s - ZOOM_STEP))}
          class="flex h-7 w-7 items-center justify-center rounded-md text-base font-bold hover:bg-stone-100 disabled:opacity-30"
        >
          −
        </button>
        <button
          type="button"
          data-testid="canvas-zoom-reset"
          aria-label="Reset zoom"
          onClick={() => setScale(1)}
          class="min-w-[3rem] rounded-md px-1 text-xs font-semibold tabular-nums hover:bg-stone-100"
        >
          <span data-testid="canvas-zoom-level">{Math.round(scale * 100)}%</span>
        </button>
        <button
          type="button"
          data-testid="canvas-zoom-in"
          aria-label="Zoom in"
          disabled={scale >= ZOOM_MAX}
          onClick={() => setScale((s) => clampZoom(s + ZOOM_STEP))}
          class="flex h-7 w-7 items-center justify-center rounded-md text-base font-bold hover:bg-stone-100 disabled:opacity-30"
        >
          +
        </button>
      </div>

      <div
        data-testid="campaign-canvas"
        class="relative overflow-auto rounded-xl border border-stone-200 bg-stone-50/60"
        style={{ maxHeight: '60vh' }}
      >
        {/* Scaled-size spacer so the scrollable area tracks the zoom level. */}
        <div style={{ width: `${layout.width * scale}px`, height: `${layout.height * scale}px` }}>
          <div
            class="relative"
            style={{
              width: `${layout.width}px`,
              height: `${layout.height}px`,
              transform: `scale(${scale})`,
              transformOrigin: 'top left',
              // Light grid dots (stone-400 @ ~22% on a 22px grid) for spatial sense.
              backgroundImage:
                'radial-gradient(circle, rgb(168 162 158 / 0.22) 1px, transparent 1.5px)',
              backgroundSize: '22px 22px',
            }}
          >
            {/* Connector layer (behind the cards). */}
        <svg
          data-testid="campaign-connectors"
          class="pointer-events-none absolute inset-0"
          width={layout.width}
          height={layout.height}
        >
          {layout.edges.map((e) => (
            <Connector key={`${e.from}-${e.slot}-${e.to}`} edge={e} />
          ))}
        </svg>

        {/* Edge insertion (+) controls, anchored on each connector's vertical run. */}
        {layout.edges.map((e) => {
          const mid = edgeMidpoint(e.fromPoint, e.toPoint);
          const edge = model.edges.find((me) => me.from === e.from && me.slot === e.slot && me.to === e.to);
          if (!edge) return null;
          return (
            <button
              key={`ins-${e.from}-${e.slot}-${e.to}`}
              type="button"
              data-testid="campaign-edge-insert"
              aria-label="Insert a step on this edge"
              onClick={() => onInsert(edge)}
              // z-10 (same as cards, rendered BEFORE them) so a card's open
              // ActionMenu dropdown — which lives inside the card's z-10 stacking
              // context and can extend DOWN past the card — paints OVER these (+)
              // controls instead of being intercepted by them. The (+) sit in the
              // inter-row gap, so no card ever covers a (+) where it must be clicked.
              class="absolute z-10 flex h-6 w-6 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border border-stone-300 bg-white text-sm font-bold text-stone-500 shadow-sm transition-colors hover:border-brand-400 hover:text-brand-600"
              style={{ left: `${mid.x}px`, top: `${mid.y}px` }}
            >
              +
            </button>
          );
        })}

        {/* Node cards. */}
        {model.nodes.map((cn) => {
          const pos = layout.positions.get(cn.id)!;
          const dt = displayType(cn.node);
          const isTrigger = cn.node.type === 'trigger';
          const isExit = cn.node.type === 'exit';
          const publishErr = publishErrors?.[cn.id];
          return (
            <div
              key={cn.id}
              data-testid={`node-${dt}`}
              data-node-id={cn.id}
              class={`absolute z-10 rounded-xl border bg-white shadow-card ring-1 ring-inset ${
                publishErr ? 'ring-rose-300' : 'ring-stone-200'
              }`}
              style={{
                left: `${pos.x - LAYOUT.cardWidth / 2}px`,
                top: `${pos.y}px`,
                width: `${LAYOUT.cardWidth}px`,
              }}
            >
              <div class="flex items-start justify-between gap-2 p-3">
                <button
                  type="button"
                  // Exit has no config; every other node opens its editor on click.
                  data-testid={isExit ? undefined : `node-open-${cn.id}`}
                  onClick={isExit ? undefined : () => onOpen(cn)}
                  disabled={isExit}
                  class="min-w-0 flex-1 text-left disabled:cursor-default"
                >
                  <span
                    class={`inline-flex items-center rounded-md px-2 py-0.5 text-[11px] font-semibold ring-1 ring-inset ${
                      NODE_STYLE[dt] ?? NODE_STYLE.exit
                    }`}
                  >
                    {TYPE_LABEL[dt] ?? dt}
                  </span>
                  <p class="mt-1.5 truncate text-sm font-medium text-ink-900">{nodeSummary(cn)}</p>
                </button>
                {isTrigger ? null : (
                  <ActionMenu
                    data-testid={`node-actions-${cn.id}`}
                    label="Step actions"
                    items={[
                      ...(isExit
                        ? []
                        : [{ label: 'Edit step', 'data-testid': 'node-edit', onSelect: () => onOpen(cn) }]),
                      {
                        label: 'Delete step',
                        danger: true,
                        'data-testid': 'node-delete',
                        onSelect: () => onDelete(cn),
                      },
                    ]}
                  />
                )}
              </div>
              {publishErr ? (
                <p data-testid="node-publish-error" class="border-t border-rose-100 bg-rose-50 px-3 py-1.5 text-[11px] text-rose-700">
                  {publishErr}
                </p>
              ) : null}
            </div>
          );
        })}
          </div>
        </div>
      </div>
    </div>
  );
}

function Connector({ edge }: { edge: LayoutEdge }): JSX.Element {
  const d = orthogonalPath(edge.fromPoint, edge.toPoint);
  const labelPoint = edge.label ? { x: edge.toPoint.x, y: (edge.fromPoint.y + edge.toPoint.y) / 2 } : null;
  return (
    <g>
      <path d={d} fill="none" stroke="#cbd5e1" stroke-width={2} />
      {labelPoint ? (
        <text
          x={labelPoint.x}
          y={labelPoint.y}
          dy="-4"
          text-anchor="middle"
          class="fill-stone-400 text-[10px] font-semibold"
        >
          {edge.label}
        </text>
      ) : null}
    </g>
  );
}
