// The canvas editor model + DSL (de)serialization for the campaign builder
// (§9B phase 5). The DSL ({startNode, nodes}) is the SINGLE graph model — there
// are NO stored coordinates. This module is the thin, PURE bridge between that
// DSL and a normalized in-editor `CanvasModel` (a node list + an explicit edge
// list + the start id) that the canvas renders and mutates. parseDefinition and
// buildDefinition round-trip to identity, so a save→reload reconstructs the same
// graph. Everything here is pure (no I/O) and unit-tested first.
//
// NOTE: the node shapes mirror @cdp/service-campaign-runner's DSL exactly; the
// server re-validates every emitted graph with validateCampaignDefinition (the
// structural gate). This file never invents a second graph model.

/** The palette of node types a user can INSERT (the trigger is implicit/start). */
export type PaletteType =
  | 'wait'
  | 'wait_until'
  | 'hour_of_day_window'
  | 'condition'
  | 'send'
  | 'set_attribute'
  | 'webhook'
  | 'exit';

/** A DSL node, kept structurally loose (the runner owns the strict types). */
export type DslNode = Record<string, unknown> & { type: string };

/** A campaign definition — the single graph model (mirrors the runner's). */
export interface CampaignDefinition {
  startNode: string;
  nodes: Record<string, DslNode>;
}

/** A canvas edge derived from a node's next/onTrue/onFalse — NO coordinates. */
export interface CanvasEdge {
  /** Source node id. */
  readonly from: string;
  /** Target node id. */
  readonly to: string;
  /** Which outgoing slot of `from` this edge occupies. */
  readonly slot: 'next' | 'onTrue' | 'onFalse';
  /** Branch label shown on a condition's connector ('Yes'/'No'); undefined otherwise. */
  readonly label?: string;
}

/** A normalized editor node — id + its raw DSL node (no coordinates). */
export interface CanvasNode {
  readonly id: string;
  readonly node: DslNode;
}

/** The in-editor model: nodes + an explicit edge list + the start id. */
export interface CanvasModel {
  readonly start: string;
  readonly nodes: readonly CanvasNode[];
  readonly edges: readonly CanvasEdge[];
}

/** The display kind of a node — its DSL `type`, refined for actions by `kind`. */
export type DisplayType =
  | 'trigger'
  | 'wait'
  | 'wait_until'
  | 'hour_of_day_window'
  | 'condition'
  | 'send'
  | 'set_attribute'
  | 'webhook'
  | 'exit'
  | 'action';

/**
 * The outgoing edges of a DSL node (slot + target), in render order. A condition
 * fans onTrue (Yes) then onFalse (No); a single-out node has one `next`; an exit
 * has none. Mirrors the runner's edgesOf but carries the slot + branch label.
 */
export function outgoingEdges(id: string, node: DslNode): CanvasEdge[] {
  switch (node.type) {
    case 'trigger':
    case 'wait':
    case 'hour_of_day_window':
      return edgeIf(id, node.next, 'next');
    case 'action':
      return edgeIf(id, node.next, 'next');
    case 'condition':
      return [
        ...edgeIf(id, node.onTrue, 'onTrue', 'Yes'),
        ...edgeIf(id, node.onFalse, 'onFalse', 'No'),
      ];
    case 'exit':
    default:
      return [];
  }
}

function edgeIf(
  from: string,
  to: unknown,
  slot: CanvasEdge['slot'],
  label?: string,
): CanvasEdge[] {
  if (typeof to !== 'string' || to.length === 0) return [];
  // Omit `label` entirely when absent (exactOptionalPropertyTypes).
  return [label !== undefined ? { from, to, slot, label } : { from, to, slot }];
}

/** The display type of a DSL node (refines actions to send/set_attribute/webhook). */
export function displayType(node: DslNode): DisplayType {
  if (node.type === 'action') {
    const kind = (node as { kind?: unknown }).kind;
    if (kind === 'send' || kind === 'set_attribute' || kind === 'webhook') return kind;
    return 'action';
  }
  return node.type as DisplayType;
}

/**
 * parseDefinition(def) → CanvasModel. Derives an explicit edge list ONLY from
 * next/onTrue/onFalse (never from any stored coordinate — there are none) and
 * flags the single trigger as `start`. Nodes keep their raw DSL shape verbatim.
 */
export function parseDefinition(def: CampaignDefinition): CanvasModel {
  const nodes: CanvasNode[] = Object.keys(def.nodes).map((id) => ({ id, node: def.nodes[id]! }));
  const edges: CanvasEdge[] = [];
  for (const { id, node } of nodes) edges.push(...outgoingEdges(id, node));
  return { start: def.startNode, nodes, edges };
}

/**
 * buildDefinition(model) → {startNode, nodes}. Serializes the canvas model back
 * to the DSL: startNode is the model's start id, and each node is emitted in its
 * exact DSL shape. The edge list is authoritative — every node's outgoing slots
 * are written from `model.edges` so an insert/delete that rewired edges is
 * reflected. Round-trips to identity with parseDefinition.
 */
export function buildDefinition(model: CanvasModel): CampaignDefinition {
  const bySlot = new Map<string, Record<string, string>>();
  for (const e of model.edges) {
    const slots = bySlot.get(e.from) ?? {};
    slots[e.slot] = e.to;
    bySlot.set(e.from, slots);
  }
  const nodes: Record<string, DslNode> = {};
  for (const { id, node } of model.nodes) {
    nodes[id] = applyEdges(node, bySlot.get(id) ?? {});
  }
  return { startNode: model.start, nodes };
}

/** Re-write a node's outgoing slot targets from the (authoritative) edge map. */
function applyEdges(node: DslNode, slots: Record<string, string>): DslNode {
  switch (node.type) {
    case 'trigger':
    case 'wait':
    case 'hour_of_day_window':
    case 'action':
      return slots.next !== undefined ? { ...node, next: slots.next } : { ...node };
    case 'condition':
      return {
        ...node,
        ...(slots.onTrue !== undefined ? { onTrue: slots.onTrue } : {}),
        ...(slots.onFalse !== undefined ? { onFalse: slots.onFalse } : {}),
      };
    case 'exit':
    default:
      return { ...node };
  }
}

/** Monotonic-ish id factory for freshly-inserted nodes (collision-checked by caller). */
export function freshNodeId(type: PaletteType, existing: ReadonlySet<string>): string {
  let n = 1;
  let id = `${type}_${n}`;
  while (existing.has(id)) {
    n += 1;
    id = `${type}_${n}`;
  }
  return id;
}

/** A future ISO timestamp for a wait_until stub (1 day out from `now`). */
export function defaultWaitUntilIso(now: Date = new Date()): string {
  return new Date(now.getTime() + 86_400_000).toISOString();
}

/**
 * defaultNodeConfig(type) — a sensible-default STUB config per palette type that
 * keeps the graph structurally valid once wired (per-node editors are phase 6).
 * The `next` (or onTrue/onFalse) edges are filled in by insertOnEdge; here we set
 * the non-edge config. A send stub uses a placeholder template_id so the graph
 * validates structurally (the real clone-into-copy attach is phase 6).
 */
export function defaultNodeConfig(type: PaletteType, now: Date = new Date()): DslNode {
  switch (type) {
    case 'wait':
      return { type: 'wait', delay: { seconds: 86_400 }, next: '' };
    case 'wait_until':
      return { type: 'wait', until: defaultWaitUntilIso(now), next: '' };
    case 'hour_of_day_window':
      return { type: 'hour_of_day_window', startHour: 9, endHour: 17, next: '' };
    case 'condition':
      return {
        type: 'condition',
        ast: { field: 'attributes.tier', operator: '=', value: '' },
        onTrue: '',
        onFalse: '',
      };
    case 'send':
      return { type: 'action', kind: 'send', template_id: 'placeholder', next: '' };
    case 'set_attribute':
      return { type: 'action', kind: 'set_attribute', key: 'stage', value: '', next: '' };
    case 'webhook':
      return { type: 'action', kind: 'webhook', url: 'https://example.com', method: 'POST', next: '' };
    case 'exit':
      return { type: 'exit' };
  }
}

/** A minimal valid starter model: trigger → exit (the (+) lives on that edge). */
export function starterModel(): CanvasModel {
  return parseDefinition({
    startNode: 'trigger',
    nodes: {
      trigger: { type: 'trigger', kind: 'segment_entry', next: 'exit_1' },
      exit_1: { type: 'exit' },
    },
  });
}
