// Pure graph mutations for the campaign canvas (§9B phase 5). The DSL stays a
// DOWN-ONLY tree with NO loops / NO orphans by CONSTRUCTION here:
//   - insertOnEdge only ever rewrites A→B into A→NEW→B (NEW points downstream at
//     B), so a freshly-inserted node is always reachable and never back-edges to
//     an ancestor — a loop is unconstructable through the UI.
//   - deleteNode either splices a single-out node (parent re-links to node.next)
//     or removes a condition + its EXCLUSIVE descendants; it refuses to delete
//     the trigger or to remove the last reachable exit.
// Every result is re-checked by the server's validateCampaignDefinition before
// save (the structural gate). These functions are pure + unit-tested first.
import {
  buildDefinition,
  parseDefinition,
  defaultNodeConfig,
  freshNodeId,
  displayType,
  outgoingEdges,
  type CampaignDefinition,
  type CanvasModel,
  type CanvasEdge,
  type CanvasNode,
  type DslNode,
  type PaletteType,
} from './model.js';

/** A thrown mutation error the builder surfaces as a toast (never a native dialog). */
export class MutationError extends Error {}

/**
 * insertOnEdge(model, edge, type, now?) — insert a NEW node of `type` on the edge
 * `edge` (A→B), rewriting it to A→NEW→B. For a single-out NEW node, NEW.next = B.
 *
 * For a CONDITION NEW node we build a CONVERGING DIAMOND: BOTH arms (onTrue AND
 * onFalse) point at the original downstream B (the continuation). B thereby
 * becomes the JOIN — identified purely STRUCTURALLY as the node with 2+ incoming
 * edges (there is NO stored "join" flag). The trunk continues below the join; an
 * EMPTY arm simply passes straight through to it. To populate an arm, insert a
 * node on the If's onTrue/onFalse edge — that uses the SINGLE-OUT path above
 * (NEW.next = B), landing the node BETWEEN the If and the join. To TERMINATE an
 * arm, insert an 'exit' on that arm edge: re-pointing only that arm slot to a
 * fresh exit is SAFE because the join stays reachable via the other arm
 * (insertExitOnArm). The single-out exit guard still refuses an exit insert that
 * would ORPHAN B (a non-converging edge whose target is reachable only through it).
 *
 * The result is always a valid down-only graph (re-validated server-side).
 */
export function insertOnEdge(
  model: CanvasModel,
  edge: CanvasEdge,
  type: PaletteType,
  now: Date = new Date(),
): CanvasModel {
  const existing = new Set(model.nodes.map((n) => n.id));
  const newId = freshNodeId(type, existing);
  existing.add(newId);

  const def = buildDefinition(model);
  const nodes: Record<string, DslNode> = { ...def.nodes };

  // The fresh node, with its non-edge config from the stub factory.
  const fresh = defaultNodeConfig(type, now);

  if (type === 'condition') {
    // REJOIN: both arms lead to the original downstream B (the continuation). B is
    // now the join (2+ incoming edges). No fresh exit is minted.
    nodes[newId] = { ...fresh, onTrue: edge.to, onFalse: edge.to };
  } else if (type === 'exit') {
    // An exit is terminal — A now points at NEW, so B loses THIS incoming edge.
    // Re-pointing is only SAFE when B stays reachable WITHOUT this edge (a
    // converging arm — the diamond's other arm still reaches the join). Otherwise
    // the splice would ORPHAN B (its subtree, or B itself when B is a trailing
    // exit) → refuse (the single-out guard).
    if (!reachableWithoutEdge(def, edge)) {
      throw new MutationError(
        'Add an Exit on a branch arm (or where the journey already ends) — placing it here would strand the steps below.',
      );
    }
    nodes[newId] = { type: 'exit' };
  } else {
    nodes[newId] = { ...fresh, next: edge.to };
  }

  // Re-point A's slot (next/onTrue/onFalse) from B to NEW.
  nodes[edge.from] = repointSlot(nodes[edge.from]!, edge.slot, newId);

  return parseDefinition({ startNode: def.startNode, nodes });
}

/**
 * insertExitOnArm(model, armEdge, now?) — terminate a single converging arm by
 * re-pointing ONLY that arm slot to a fresh exit, leaving the join reachable via
 * the other arm. A thin convenience over insertOnEdge('exit', …); it asserts the
 * arm is converging (the join keeps another incoming edge) so the call can never
 * orphan the join.
 */
export function insertExitOnArm(
  model: CanvasModel,
  armEdge: CanvasEdge,
  now: Date = new Date(),
): CanvasModel {
  const def = buildDefinition(model);
  if (!reachableWithoutEdge(def, armEdge)) {
    throw new MutationError('That arm does not rejoin a shared trunk — an Exit here would strand the steps below.');
  }
  return insertOnEdge(model, armEdge, 'exit', now);
}

/**
 * Is `edge.to` still reachable from the start if we DROP just `edge`? True for a
 * converging arm (the join is reached via another incoming edge) — re-pointing
 * this slot to a terminal exit then cannot orphan the target.
 */
function reachableWithoutEdge(def: CampaignDefinition, edge: CanvasEdge): boolean {
  const seen = new Set<string>();
  const queue = [def.startNode];
  while (queue.length) {
    const cur = queue.shift()!;
    if (seen.has(cur)) continue;
    seen.add(cur);
    const node = def.nodes[cur];
    if (!node) continue;
    for (const e of outgoingEdges(cur, node)) {
      // Skip the one edge under test (same from + slot + to).
      if (e.from === edge.from && e.slot === edge.slot && e.to === edge.to) continue;
      queue.push(e.to);
    }
  }
  return seen.has(edge.to);
}

/** Re-point a node's outgoing slot to a new target id (immutably). */
function repointSlot(node: DslNode, slot: CanvasEdge['slot'], to: string): DslNode {
  return { ...node, [slot]: to };
}

/**
 * deleteNode(model, id) — remove node `id`, re-linking the graph so it stays a
 * valid down-only tree with no orphan. Rules:
 *   - the trigger (start) cannot be deleted (THROWS MutationError).
 *   - a single-out node (wait / hour_window / action) is SPLICED: every parent
 *     edge pointing at it is re-pointed to its `next`.
 *   - a condition is removed together with its EXCLUSIVE descendants (nodes
 *     reachable only through it); the condition's parent edge is re-linked to the
 *     condition's "join" target if both arms re-converge, else to a surviving
 *     exit reachable from the rest of the graph.
 *   - deleting must not remove the LAST reachable exit (THROWS MutationError).
 */
export function deleteNode(model: CanvasModel, id: string): CanvasModel {
  if (id === model.start) {
    throw new MutationError('The trigger cannot be deleted.');
  }
  const def = buildDefinition(model);
  const target = def.nodes[id];
  if (!target) throw new MutationError(`Node "${id}" does not exist.`);

  const out = outgoingEdges(id, target);
  const isCondition = target.type === 'condition';

  let nextDef: CampaignDefinition;
  if (!isCondition) {
    // Single-out (or exit) node — splice: re-point every parent edge to its next.
    const successor = out[0]?.to; // undefined for an exit
    const nodes: Record<string, DslNode> = {};
    for (const [nid, node] of Object.entries(def.nodes)) {
      if (nid === id) continue; // drop the deleted node
      nodes[nid] = repointParents(node, id, successor);
    }
    nextDef = { startNode: def.startNode, nodes };
  } else {
    // Condition — splice it out by KEEPING its onTrue (Yes) arm: the parent
    // re-links to the onTrue target, and the onFalse arm's EXCLUSIVE descendants
    // (nodes reachable only through the condition's onFalse, and not via onTrue
    // nor any other path) are removed. If the two arms re-converge (a diamond),
    // the join survives because it stays reachable via onTrue. This always yields
    // a valid down-only tree (re-validated below + server-side).
    const survivor = (target as { onTrue?: string }).onTrue; // the Yes arm continuation
    const exclusive = falseArmExclusive(def, id);
    const remove = new Set<string>([id, ...exclusive]);
    const nodes: Record<string, DslNode> = {};
    for (const [nid, node] of Object.entries(def.nodes)) {
      if (remove.has(nid)) continue;
      nodes[nid] = repointParents(node, id, survivor);
    }
    nextDef = { startNode: def.startNode, nodes };
  }

  // Guard: a reachable exit must remain (else refuse — never produce an invalid def).
  if (!hasReachableExit(nextDef)) {
    throw new MutationError('Deleting this node would leave the journey with no exit.');
  }
  // Guard: no parent may now point at a removed/undefined node (would orphan/dangle).
  for (const [, node] of Object.entries(nextDef.nodes)) {
    for (const e of outgoingEdges('_', node)) {
      if (!Object.prototype.hasOwnProperty.call(nextDef.nodes, e.to)) {
        throw new MutationError('Deleting this node would break the journey graph.');
      }
    }
  }
  return parseDefinition(nextDef);
}

/** Re-point any of a node's outgoing slots that target `from` to `to` (drop if undefined). */
function repointParents(node: DslNode, from: string, to: string | undefined): DslNode {
  const slots: Array<'next' | 'onTrue' | 'onFalse'> = ['next', 'onTrue', 'onFalse'];
  let out = node;
  for (const slot of slots) {
    if ((out as Record<string, unknown>)[slot] === from) {
      if (to !== undefined) out = { ...out, [slot]: to };
      // If `to` is undefined the parent's slot is left pointing at `from`; the
      // caller's reachable-exit + dangling guards catch any resulting invalidity.
    }
  }
  return out;
}

/**
 * The onFalse arm's EXCLUSIVE descendants — nodes reachable from the condition's
 * onFalse target that are NOT reachable in the post-delete graph (where the
 * condition's parents point at its onTrue target instead). We model the survivor
 * graph: start, with the condition removed and its parents re-pointed to onTrue,
 * then anything still under onFalse that is now unreachable is the exclusive set
 * to remove. A diamond join (reachable via onTrue) survives.
 */
function falseArmExclusive(def: CampaignDefinition, conditionId: string): string[] {
  const cond = def.nodes[conditionId] as { onTrue?: string; onFalse?: string };
  const survivor = cond.onTrue;
  const onFalse = cond.onFalse;
  if (!onFalse) return [];

  // Reachable in the SURVIVOR graph: BFS from start, but treat the condition's id
  // as if it routes straight to `survivor` (its onTrue), and never traverse the
  // condition's onFalse arm THROUGH the condition.
  const reachable = new Set<string>();
  const queue: string[] = [def.startNode];
  while (queue.length) {
    const cur = queue.shift()!;
    if (reachable.has(cur)) continue;
    reachable.add(cur);
    if (cur === conditionId) {
      if (survivor) queue.push(survivor);
      continue; // do NOT follow onFalse via the condition
    }
    const node = def.nodes[cur];
    if (node) for (const e of outgoingEdges(cur, node)) queue.push(e.to);
  }

  // Everything reachable from onFalse that is NOT in the survivor reachable set
  // is exclusive to the onFalse arm → remove it.
  const fromFalse = new Set<string>();
  collect(def, onFalse, fromFalse);
  return [...fromFalse].filter((nid) => !reachable.has(nid));
}

/** Collect all nodes reachable from `start` into `into`. */
function collect(def: CampaignDefinition, start: string, into: Set<string>): void {
  const queue = [start];
  while (queue.length) {
    const cur = queue.shift()!;
    if (into.has(cur)) continue;
    into.add(cur);
    const node = def.nodes[cur];
    if (node) for (const e of outgoingEdges(cur, node)) queue.push(e.to);
  }
}

/** Is any exit node reachable from start? (mirrors the runner's gate, locally). */
function hasReachableExit(def: CampaignDefinition): boolean {
  const seen = new Set<string>();
  const queue = [def.startNode];
  while (queue.length) {
    const cur = queue.shift()!;
    if (seen.has(cur)) continue;
    seen.add(cur);
    const node = def.nodes[cur];
    if (!node) continue;
    if (node.type === 'exit') return true;
    for (const e of outgoingEdges(cur, node)) queue.push(e.to);
  }
  return false;
}

/** A short human label for a node card (the canvas summary line). */
export function nodeSummary(canvasNode: CanvasNode): string {
  const node = canvasNode.node;
  switch (node.type) {
    case 'trigger': {
      // A non-blank cosmetic label wins (like a condition's label, Feature A).
      const label = String((node as { label?: unknown }).label ?? '').trim();
      if (label) return label;
      const kind = String((node as { kind?: unknown }).kind ?? 'segment_entry');
      const map: Record<string, string> = {
        segment_entry: 'On segment entry',
        event: 'On event',
        manual: 'Manual enrollment',
      };
      return map[kind] ?? 'Trigger';
    }
    case 'wait': {
      const until = (node as { until?: unknown }).until;
      if (typeof until === 'string') return 'Wait until a date';
      const delay = (node as { delay?: { seconds?: number } }).delay;
      const secs = typeof delay?.seconds === 'number' ? delay.seconds : 0;
      return `Wait ${formatDuration(secs)}`;
    }
    case 'hour_of_day_window': {
      const s = (node as { startHour?: number }).startHour ?? 0;
      const e = (node as { endHour?: number }).endHour ?? 0;
      return `Only ${pad(s)}:00–${pad(e)}:00`;
    }
    case 'condition': {
      const label = String((node as { label?: unknown }).label ?? '').trim();
      return label || 'If / branch';
    }
    case 'action': {
      const kind = String((node as { kind?: unknown }).kind ?? '');
      if (kind === 'send') return 'Send email';
      if (kind === 'set_attribute') {
        // Prefer the assignments LIST (Feature B): 1 → "Set <key>", N → "Set N attributes".
        const list = (node as { assignments?: ReadonlyArray<{ key?: unknown }> }).assignments;
        if (Array.isArray(list)) {
          const keyed = list.filter((a) => typeof a?.key === 'string' && (a.key as string).trim().length > 0);
          if (keyed.length === 1) return `Set ${(keyed[0]!.key as string).trim()}`;
          if (keyed.length > 1) return `Set ${keyed.length} attributes`;
        }
        const key = String((node as { key?: unknown }).key ?? '');
        return key ? `Set ${key}` : 'Update profile';
      }
      if (kind === 'webhook') {
        const method = String((node as { method?: unknown }).method ?? 'POST');
        return `Webhook ${method}`;
      }
      return 'Action';
    }
    case 'exit':
      return 'Exit';
    default:
      return node.type;
  }
}

/** A coarse human duration ("2 days", "3 hours", "45 minutes", "30 seconds"). */
function formatDuration(seconds: number): string {
  if (seconds % 86_400 === 0 && seconds >= 86_400) return plural(seconds / 86_400, 'day');
  if (seconds % 3_600 === 0 && seconds >= 3_600) return plural(seconds / 3_600, 'hour');
  if (seconds % 60 === 0 && seconds >= 60) return plural(seconds / 60, 'minute');
  return plural(seconds, 'second');
}

function plural(n: number, unit: string): string {
  return `${n} ${unit}${n === 1 ? '' : 's'}`;
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/** The display type re-export (cards key their icon/colour off it). */
export { displayType };
