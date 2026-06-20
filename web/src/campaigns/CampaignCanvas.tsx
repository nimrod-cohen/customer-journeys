// Presentational campaign canvas (§9B phase 5): an auto-laid-out DOWNWARD tree of
// node cards over an SVG connector layer. Positions are COMPUTED every render
// (layoutDefinition) — there is NO drag and NO stored coordinate. Connectors are
// rounded ORTHOGONAL paths (orthogonalPath) — never diagonal, never upward. A (+)
// control on each edge opens the insert palette; each card has an ActionMenu with
// Delete. This component is pure UI: state (the CanvasModel) lives in the screen.
import type { JSX } from 'preact';
import { useState, useEffect, useRef } from 'preact/hooks';
import { ActionMenu } from '../ui/kit.js';
import { layoutDefinition, LAYOUT, type LayoutEdge } from './layout.js';
import { orthogonalPath, verticalAnchor } from './orthogonal-path.js';
import { buildDefinition, displayType, type CanvasModel, type CanvasEdge, type CanvasNode } from './model.js';
import { nodeSummary, subtreeNodeIds, branchContinuation } from './mutate.js';

/** An in-progress placement (Move / Duplicate): pick a destination + to splice at. */
export interface Placement {
  readonly op: 'move' | 'duplicate';
  readonly rootId: string;
}

const ZOOM_MIN = 0.4;
const ZOOM_MAX = 2.0;
const ZOOM_STEP = 0.1;

// Elements that must keep their own click/drag behavior — a pointerdown on (or
// inside) any of these must NOT start a background pan. The board background is
// "anything that doesn't match this selector".
const INTERACTIVE_SELECTOR =
  '[data-node-id], button, a, input, select, textarea, [role="menu"], [data-testid="placement-banner"], [data-testid="campaign-edge-insert"], [data-testid="campaign-merge-insert"]';

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
  onInsertAfterBranch,
  onDelete,
  onOpen,
  publishErrors,
  placement,
  onStartPlacement,
  onPickTarget,
  onCancelPlacement,
}: {
  model: CanvasModel;
  onInsert: (edge: CanvasEdge) => void;
  /** Insert a step AFTER a condition's branch (the merge (+) below the join). */
  onInsertAfterBranch?: (conditionId: string) => void;
  onDelete: (node: CanvasNode) => void | Promise<void>;
  /** Open a node's config editor (card click / "Edit step"). */
  onOpen: (node: CanvasNode) => void;
  /** Per-node publish-gate reasons (node id → message), surfaced on the card. */
  publishErrors?: Readonly<Record<string, string>>;
  /** When set, the canvas is in placement mode: the (+) controls pick a destination. */
  placement?: Placement | null;
  /** Start a Move / Duplicate placement for a node (from its ActionMenu). */
  onStartPlacement?: (op: 'move' | 'duplicate', node: CanvasNode) => void;
  /** A (+) was clicked while placing — splice the moved/duplicated branch here. */
  onPickTarget?: (edge: CanvasEdge) => void;
  /** Cancel the in-progress placement (banner button / Escape). */
  onCancelPlacement?: () => void;
}): JSX.Element {
  const layout = layoutDefinition(buildDefinition(model));

  // While moving a branch, the (+) controls INSIDE the moving subtree are invalid
  // destinations (would self-insert / cycle) — compute the member set to skip them.
  const movingIds =
    placement?.op === 'move' ? subtreeNodeIds(model, placement.rootId) : null;
  const isInvalidTarget = (edge: CanvasEdge): boolean =>
    movingIds !== null && (movingIds.has(edge.from) || movingIds.has(edge.to));

  // Escape cancels an in-progress placement (parity with closing the palette).
  // Registered in the CAPTURE phase on `document` so it fires regardless of which
  // element holds focus (the just-closed ActionMenu, a (+), the body, …).
  // A single, lifetime-stable capture-phase Escape listener that reads the LATEST
  // placing flag + cancel callback from refs. Registering once (empty deps) avoids
  // the dep-churn fragility where a toggled `placing`/recreated `onCancelPlacement`
  // could leave the listener un-re-registered after a prior cancel (the regression
  // that made Escape stop dismissing the placement banner the second time).
  const placing = placement != null;
  const placingRef = useRef(placing);
  placingRef.current = placing;
  const cancelRef = useRef(onCancelPlacement);
  cancelRef.current = onCancelPlacement;
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && placingRef.current) cancelRef.current?.();
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, []);

  // The node whose ActionMenu is currently open — its card is raised above sibling
  // cards (each card is its own z-10 stacking context, so a later sibling would
  // otherwise paint over the open dropdown and intercept its clicks).
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);

  // View-only zoom (does NOT touch the model — connector `d` coords are unchanged;
  // we scale the whole content container). Clamped ZOOM_MIN..ZOOM_MAX; the toolbar
  // steps in 10% increments, a trackpad pinch (ctrl+wheel) scales continuously.
  const [scale, setScale] = useState(1);
  const clampZoom = (z: number): number => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(z * 100) / 100));

  // The scroll viewport (the `campaign-canvas` overflow-auto box). We drive its
  // scrollLeft/scrollTop directly for drag-to-pan, and attach a NON-PASSIVE wheel
  // listener to it for pinch-zoom (Preact's onWheel is passive → can't preventDefault).
  const viewportRef = useRef<HTMLDivElement | null>(null);

  // Drag-to-pan state. A pan begins ONLY when the pointerdown lands on the board
  // BACKGROUND (not a card / + / menu / banner — see INTERACTIVE_SELECTOR), so node
  // cards, the (+) controls, the ⋮ menu, the zoom toolbar and the banner all keep
  // working as ordinary clicks. We stash the start client coords + the container's
  // scroll offset, then translate cursor delta into a scroll offset on pointermove.
  const panRef = useRef<{
    active: boolean;
    startX: number;
    startY: number;
    startScrollLeft: number;
    startScrollTop: number;
    pointerId: number;
  } | null>(null);
  const [panning, setPanning] = useState(false);

  const onPointerDown = (e: JSX.TargetedPointerEvent<HTMLDivElement>): void => {
    // Only the primary (left) button / a touch contact pans.
    if (e.button !== 0) return;
    const target = e.target as HTMLElement;
    // Background only — a press inside an interactive element is left alone.
    if (target.closest(INTERACTIVE_SELECTOR)) return;
    const container = viewportRef.current;
    if (!container) return;
    panRef.current = {
      active: true,
      startX: e.clientX,
      startY: e.clientY,
      startScrollLeft: container.scrollLeft,
      startScrollTop: container.scrollTop,
      pointerId: e.pointerId,
    };
    setPanning(true);
    container.setPointerCapture?.(e.pointerId);
  };

  const onPointerMove = (e: JSX.TargetedPointerEvent<HTMLDivElement>): void => {
    const pan = panRef.current;
    const container = viewportRef.current;
    if (!pan?.active || !container) return;
    container.scrollLeft = pan.startScrollLeft - (e.clientX - pan.startX);
    container.scrollTop = pan.startScrollTop - (e.clientY - pan.startY);
  };

  const endPan = (e: JSX.TargetedPointerEvent<HTMLDivElement>): void => {
    const pan = panRef.current;
    if (!pan?.active) return;
    panRef.current = null;
    setPanning(false);
    viewportRef.current?.releasePointerCapture?.(e.pointerId);
  };

  // Pinch-to-zoom (trackpad): a pinch arrives as `wheel` with ctrlKey === true.
  // We MUST preventDefault to stop the browser's own page zoom, but Preact/React
  // attach onWheel passively (preventDefault is a no-op there) — so register a
  // native NON-PASSIVE listener on the viewport. A plain (non-ctrl) wheel is left
  // untouched so native two-finger scroll/pan still works. We keep the point under
  // the cursor stable by adjusting scrollLeft/Top around the new scale.
  useEffect(() => {
    const container = viewportRef.current;
    if (!container) return undefined;
    const onWheel = (e: WheelEvent): void => {
      if (!e.ctrlKey) return; // ordinary scroll/pan — don't intercept
      e.preventDefault();
      setScale((prev) => {
        const next = clampZoom(prev * (1 - e.deltaY * 0.01));
        if (next === prev) return prev;
        // Anchor the cursor point: the content offset under the cursor should map
        // to the same content coordinate after the scale change.
        const rect = container.getBoundingClientRect();
        const cx = e.clientX - rect.left + container.scrollLeft;
        const cy = e.clientY - rect.top + container.scrollTop;
        const ratio = next / prev;
        // Defer scroll fixup to after the re-render applies the new spacer size.
        requestAnimationFrame(() => {
          container.scrollLeft = cx * ratio - (e.clientX - rect.left);
          container.scrollTop = cy * ratio - (e.clientY - rect.top);
        });
        return next;
      });
    };
    container.addEventListener('wheel', onWheel, { passive: false });
    return () => container.removeEventListener('wheel', onWheel);
  }, []);

  return (
    <div class="relative">
      {/* Placement banner — sticky guidance while picking a destination (+). */}
      {placement ? (
        <div
          data-testid="placement-banner"
          class="sticky top-0 z-30 mb-2 flex items-center justify-between gap-3 rounded-lg border border-brand-200 bg-brand-50 px-3 py-2 text-sm text-brand-800 shadow-sm"
        >
          <span>
            {placement.op === 'move'
              ? 'Select where to move the branch — pick a ＋.'
              : 'Select where to place the copy — pick a ＋.'}
          </span>
          <button
            type="button"
            data-testid="placement-cancel"
            onClick={() => onCancelPlacement?.()}
            class="btn-ghost btn-sm shrink-0"
          >
            Cancel
          </button>
        </div>
      ) : null}

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
        ref={viewportRef}
        data-testid="campaign-canvas"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endPan}
        onPointerCancel={endPan}
        onPointerLeave={endPan}
        class={`relative overflow-auto rounded-xl border border-stone-200 bg-stone-50/60 ${
          panning ? 'cursor-grabbing select-none' : 'cursor-grab'
        }`}
        style={{
          maxHeight: '60vh',
          // Light grid dots blanket the WHOLE canvas (constant density, independent
          // of zoom). `local` attachment tiles across the full scrollable area and
          // scrolls with the content rather than sticking to the viewport box.
          backgroundImage: 'radial-gradient(circle, rgb(168 162 158 / 0.22) 1px, transparent 1.5px)',
          backgroundSize: '22px 22px',
          backgroundAttachment: 'local',
        }}
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
          const mid = verticalAnchor(e.fromPoint, e.toPoint, e.laneX, e.kneeTop);
          const edge = model.edges.find((me) => me.from === e.from && me.slot === e.slot && me.to === e.to);
          if (!edge) return null;
          // While placing a MOVE, hide the (+) controls inside the moving subtree
          // (invalid destinations — would self-insert / cycle).
          if (placement && isInvalidTarget(edge)) return null;
          return (
            <button
              key={`ins-${e.from}-${e.slot}-${e.to}`}
              type="button"
              data-testid={placing ? 'placement-target' : 'campaign-edge-insert'}
              aria-label={placing ? 'Place the branch here' : 'Insert a step on this edge'}
              onClick={() => (placing ? onPickTarget?.(edge) : onInsert(edge))}
              // z-10 (same as cards, rendered BEFORE them) so a card's open
              // ActionMenu dropdown — which lives inside the card's z-10 stacking
              // context and can extend DOWN past the card — paints OVER these (+)
              // controls instead of being intercepted by them. The (+) sit in the
              // inter-row gap, so no card ever covers a (+) where it must be clicked.
              class={`absolute z-10 flex h-6 w-6 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border text-sm font-bold shadow-sm transition-colors ${
                placing
                  ? 'animate-pulse border-brand-500 bg-brand-500 text-white ring-2 ring-brand-200 hover:bg-brand-600'
                  : 'border-stone-300 bg-white text-stone-500 hover:border-brand-400 hover:text-brand-600'
              }`}
              style={{ left: `${mid.x}px`, top: `${mid.y}px` }}
            >
              +
            </button>
          );
        })}

        {/* Merge (+) controls — one per condition that has a single rejoin (C).
            Anchored on the MERGED VERTICAL TRUNK just above the continuation card,
            it inserts a step AFTER the branch (both arms flow through it before C).
            Hidden during placement (a different interaction). */}
        {!placing
          ? model.nodes
              .filter((cn) => cn.node.type === 'condition')
              .map((cn) => {
                const contId = branchContinuation(model, cn.id);
                if (!contId) return null; // no single continuation → no merge (+)
                const contPos = layout.positions.get(contId);
                if (!contPos) return null;
                // On the vertical trunk feeding C, in the gap just above its card top.
                const x = contPos.x;
                const y = contPos.y - 14;
                return (
                  <button
                    key={`merge-${cn.id}`}
                    type="button"
                    data-testid="campaign-merge-insert"
                    aria-label="Insert a step after the branch"
                    onClick={() => onInsertAfterBranch?.(cn.id)}
                    class="absolute z-10 flex h-6 w-6 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border border-violet-300 bg-white text-sm font-bold text-violet-500 shadow-sm transition-colors hover:border-violet-500 hover:text-violet-700"
                    style={{ left: `${x}px`, top: `${y}px` }}
                  >
                    +
                  </button>
                );
              })
          : null}

        {/* Node cards. */}
        {model.nodes.map((cn) => {
          const pos = layout.positions.get(cn.id)!;
          const dt = displayType(cn.node);
          const isTrigger = cn.node.type === 'trigger';
          const isExit = cn.node.type === 'exit';
          const publishErr = publishErrors?.[cn.id];
          // Raise the card whose menu is open ABOVE sibling cards so its dropdown
          // (which can extend down past the card) paints over — and stays clickable
          // over — the next card, instead of being intercepted by it.
          const raised = openMenuId === cn.id;
          return (
            <div
              key={cn.id}
              data-testid={`node-${dt}`}
              data-node-id={cn.id}
              class={`absolute rounded-xl border bg-white shadow-card ring-1 ring-inset ${
                raised ? 'z-20' : 'z-10'
              } ${publishErr ? 'ring-rose-300' : 'ring-stone-200'}`}
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
                    onOpenChange={(o) => setOpenMenuId(o ? cn.id : (prev) => (prev === cn.id ? null : prev))}
                    items={[
                      ...(isExit
                        ? []
                        : [{ label: 'Edit step', 'data-testid': 'node-edit', onSelect: () => onOpen(cn) }]),
                      // Move / Duplicate the node + its branch — non-trigger, non-exit
                      // only (an exit is a leaf; the trigger has no menu at all).
                      ...(isExit
                        ? []
                        : [
                            {
                              label: 'Move to…',
                              'data-testid': 'node-move',
                              onSelect: () => onStartPlacement?.('move', cn),
                            },
                            {
                              label: 'Duplicate…',
                              'data-testid': 'node-duplicate',
                              onSelect: () => onStartPlacement?.('duplicate', cn),
                            },
                          ]),
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
  const d = orthogonalPath(edge.fromPoint, edge.toPoint, edge.laneX, undefined, edge.kneeTop);
  const labelPoint = edge.label ? { x: edge.laneX, y: edge.fromPoint.y + 16 } : null;
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
