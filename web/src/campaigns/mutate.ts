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
  isWaitUntil,
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

/** How many edges in the whole graph point AT `id` (its in-degree). */
function countIncoming(def: CampaignDefinition, id: string): number {
  let n = 0;
  for (const [nid, node] of Object.entries(def.nodes)) {
    for (const e of outgoingEdges(nid, node)) if (e.to === id) n += 1;
  }
  return n;
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

// --- MOVE / DUPLICATE a node + its branch (the EXCLUSIVE SUBTREE) ------------
//
// The EXCLUSIVE SUBTREE of a root R is R plus every node reachable ONLY through
// R: `S = fromR \ reachableWithoutR` (always includes R). The subtree's
// CONTINUATION C is the boundary target — the node(s) that are edge-targets of
// some node in S but are NOT themselves in S. For a well-formed branch C is a
// SINGLE node (the rejoin/join) or EMPTY (a terminal branch that ends only in
// exits). 2+ distinct external boundary targets ⇒ the branch is not cleanly
// movable as a unit (throws). Both ops are PURE + re-checked by the server's
// validateCampaignDefinition on save; locally we re-run hasReachableExit, the
// dangling-edge guard, AND a hasCycle DFS (down-only must hold) before returning.

/** The exclusive-subtree result for a root: the member set `S` and its boundary. */
interface Subtree {
  /** R + every node reachable only through R (always includes R). */
  ids: Set<string>;
  /** The single boundary continuation, or undefined for a terminal branch. */
  continuation: string | undefined;
}

/** BFS the set of nodes reachable from `start`, optionally treating `skip` as absent. */
function reachableFrom(def: CampaignDefinition, start: string, skip?: string): Set<string> {
  const seen = new Set<string>();
  const queue = [start];
  while (queue.length) {
    const cur = queue.shift()!;
    if (cur === skip || seen.has(cur)) continue;
    seen.add(cur);
    const node = def.nodes[cur];
    if (node) for (const e of outgoingEdges(cur, node)) queue.push(e.to);
  }
  return seen;
}

/**
 * The exclusive subtree S of `rootId` + its single boundary continuation C.
 * `S = fromR \ reachableWithoutR` (BFS from root) and is intersected against
 * `fromR` so it never includes a node reached from start that merely sits below.
 * The boundary is every distinct edge-target of a node in S that is NOT in S; a
 * well-formed branch has 0 (terminal) or 1 (rejoin) — 2+ throws (not movable).
 */
function exclusiveSubtree(def: CampaignDefinition, rootId: string): Subtree {
  const fromR = reachableFrom(def, rootId);
  const withoutR = reachableFrom(def, def.startNode, rootId);
  const ids = new Set<string>();
  for (const id of fromR) if (!withoutR.has(id)) ids.add(id);
  ids.add(rootId); // R is always in its own subtree

  const boundary = new Set<string>();
  for (const id of ids) {
    const node = def.nodes[id];
    if (!node) continue;
    for (const e of outgoingEdges(id, node)) if (!ids.has(e.to)) boundary.add(e.to);
  }
  if (boundary.size > 1) {
    throw new MutationError("This branch can't be moved as a unit.");
  }
  return { ids, continuation: [...boundary][0] };
}

/** The set of node ids in the exclusive subtree of `rootId` (UI: hide invalid +s). */
export function subtreeNodeIds(model: CanvasModel, rootId: string): Set<string> {
  return movePlan(model, rootId).ids;
}

/**
 * movePlan(model, rootId) — what a Move/Duplicate on `rootId` operates on.
 *   - a CONDITION (branch root) → 'branch': its EXCLUSIVE SUBTREE relocates as a
 *     unit (S + the single boundary continuation C). (unchanged behavior).
 *   - a NON-condition node with EXACTLY ONE outgoing edge (`next`) → 'single': JUST
 *     that node moves (ids = {rootId}, continuation = rootId.next). This makes
 *     "move this step" intuitive AND lets a single step be dropped onto a sibling
 *     arm — including an arm currently pointing at it (relocating it from a shared
 *     merge onto one arm).
 *   - anything else (a node with 0 or 2+ out-edges that isn't a condition — e.g. an
 *     exit) falls back to the exclusive-subtree shape (the UI never offers Move/
 *     Duplicate on an exit/trigger, so this is defensive).
 */
export function movePlan(
  model: CanvasModel,
  rootId: string,
): { mode: 'single' | 'branch'; ids: Set<string>; continuation: string | undefined } {
  const def = buildDefinition(model);
  const node = def.nodes[rootId];
  if (!node) return { mode: 'single', ids: new Set([rootId]), continuation: undefined };
  if (node.type === 'condition') {
    // The branch unit is the ARMS rejoining their merge (conditionMerge): S = the
    // strictly-in-branch nodes (incl. the condition), C = the shared rejoin. This
    // AGREES with exclusiveSubtree whenever the rejoin is shared with a sibling/
    // ancestor arm, but ALSO handles the sole-trunk case where the arms rejoin a
    // node only reachable via this branch (e.g. the only Exit): exclusiveSubtree
    // would swallow that node with NO continuation, leaving the copy/move unplaceable
    // (and orphan-prone); conditionMerge correctly yields it as C. Only when the arms
    // share NO descendant (terminal arms → each its own exit) does C come back
    // undefined — then fall back to the exclusive subtree (the whole branch + its exits).
    const cm = conditionMerge(def, rootId);
    if (cm.C !== undefined) return { mode: 'branch', ids: cm.S, continuation: cm.C };
    const { ids, continuation } = exclusiveSubtree(def, rootId);
    return { mode: 'branch', ids, continuation };
  }
  const out = outgoingEdges(rootId, node);
  if (out.length === 1) {
    return { mode: 'single', ids: new Set([rootId]), continuation: out[0]!.to };
  }
  // Defensive fallback (exits / unexpected shapes): treat as an exclusive subtree.
  const { ids, continuation } = exclusiveSubtree(def, rootId);
  return { mode: 'branch', ids, continuation };
}

/**
 * canDropOnEdge(model, rootId, destEdge) — is `destEdge` a VALID destination for a
 * Move/Duplicate of `rootId`? The canvas uses this to decide which (+) controls to
 * offer in placement mode.
 *   - 'single' mode: valid UNLESS destEdge is the node's OWN out-edge
 *     (destEdge.from === rootId — degenerate self-insert). A PARENT edge
 *     (destEdge.to === rootId) IS valid — that's the whole point (e.g. dropping the
 *     shared-merge continuation onto one arm currently pointing at it). The empty-If
 *     case (two arm edges both targeting rootId) is therefore offered on both arms.
 *   - 'branch' mode: valid UNLESS destEdge.from ∈ ids OR destEdge.to ∈ ids (inside
 *     the moving subtree → self-insert / cycle). (unchanged behavior).
 */
export function canDropOnEdge(model: CanvasModel, rootId: string, destEdge: CanvasEdge): boolean {
  const plan = movePlan(model, rootId);
  if (plan.mode === 'single') {
    return destEdge.from !== rootId;
  }
  // The branch root's OWN incoming edge (to === rootId) is a valid target — it places
  // the copy/branch immediately BEFORE the original (duplicate) / is a no-op (move).
  // Otherwise the destination must be OUTSIDE the moving subtree (no self-insert/cycle).
  if (destEdge.to === rootId) return true;
  return !(plan.ids.has(destEdge.from) || plan.ids.has(destEdge.to));
}

/**
 * conditionMerge(def, conditionId) — the single MERGE/continuation C a condition's
 * arms rejoin, plus the in-branch member set S whose boundary edges feed C. C is the
 * shallowest node reachable from EVERY arm (the nearest common descendant — the
 * structural join); S = nodes reachable from the condition that cannot be reached
 * without passing the condition's branch, i.e. `reachableFrom(cond) \ reachableFrom(C)`
 * (so C itself is excluded). Returns undefined C when the arms share no common
 * descendant (terminal arms / no single rejoin). The boundary edges to re-point are
 * exactly the edges from a node in S that target C.
 */
function conditionMerge(
  def: CampaignDefinition,
  conditionId: string,
): { S: Set<string>; C: string | undefined } {
  const cond = def.nodes[conditionId] as { onTrue?: string; onFalse?: string };
  const arms = [cond.onTrue, cond.onFalse].filter((a): a is string => typeof a === 'string' && a.length > 0);
  if (arms.length < 2) return { S: new Set([conditionId]), C: undefined };

  // Common descendants of ALL arms (inclusive of each arm target).
  const reachSets = arms.map((a) => reachableFrom(def, a));
  let common = new Set(reachSets[0]);
  for (const r of reachSets.slice(1)) common = new Set([...common].filter((id) => r.has(id)));
  if (common.size === 0) return { S: new Set([conditionId]), C: undefined };

  // C = the shallowest common node (nearest the condition) by longest-path depth.
  const depth = computeDepthsLocal(def);
  let C: string | undefined;
  let best = Infinity;
  for (const id of common) {
    const d = depth.get(id) ?? Infinity;
    if (d < best) {
      best = d;
      C = id;
    }
  }
  if (!C) return { S: new Set([conditionId]), C: undefined };

  // S = everything reachable from the condition that is NOT reachable from C and is
  // not C itself (the strictly-in-branch nodes whose boundary edges feed C).
  const fromCond = reachableFrom(def, conditionId);
  const belowC = reachableFrom(def, C);
  const S = new Set<string>();
  for (const id of fromCond) if (!belowC.has(id)) S.add(id);
  S.add(conditionId);
  return { S, C };
}

/** Longest-path depth (local copy — layout.ts owns the canvas one). */
function computeDepthsLocal(def: CampaignDefinition): Map<string, number> {
  const depth = new Map<string, number>();
  depth.set(def.startNode, 0);
  const ids = Object.keys(def.nodes);
  let changed = true;
  let guard = ids.length + 1;
  while (changed && guard-- > 0) {
    changed = false;
    for (const id of ids) {
      const d = depth.get(id);
      if (d === undefined) continue;
      const node = def.nodes[id];
      if (!node) continue;
      for (const e of outgoingEdges(id, node)) {
        if ((depth.get(e.to) ?? -1) < d + 1) {
          depth.set(e.to, d + 1);
          changed = true;
        }
      }
    }
  }
  return depth;
}

/**
 * The single CONTINUATION C below a condition's branch (the node both arms rejoin),
 * or undefined when the branch is terminal / has no single shared continuation. Pure;
 * the canvas uses it to decide whether to offer the after-the-branch merge (+).
 */
export function branchContinuation(model: CanvasModel, conditionId: string): string | undefined {
  const def = buildDefinition(model);
  const node = def.nodes[conditionId];
  if (!node || node.type !== 'condition') return undefined;
  return conditionMerge(def, conditionId).C;
}

/**
 * insertAfterBranch(model, conditionId, type, now?) — insert a NEW node N AFTER a
 * condition's branch, BEFORE its continuation C: every boundary edge feeding C from
 * inside the condition's exclusive subtree S re-points to N, and N → C. Both arms
 * thereby flow THROUGH N before reaching C (N becomes the new merge point).
 *
 * Reuses the exclusive-subtree boundary (S + the single continuation C) computed for
 * move/duplicate. When the arms don't share a SINGLE continuation (terminal branch,
 * or 2+ distinct boundary targets) the merge can't be expressed as one N → C splice,
 * so it THROWS a MutationError (the canvas omits the merge (+) for that condition —
 * it never reaches this). A condition N is rejected (it would create a nested
 * branch, not a linear merge step). The result is a valid down-only graph
 * (re-validated locally + server-side).
 */
export function insertAfterBranch(
  model: CanvasModel,
  conditionId: string,
  type: PaletteType,
  now: Date = new Date(),
): CanvasModel {
  const def = buildDefinition(model);
  const cond = def.nodes[conditionId];
  if (!cond || cond.type !== 'condition') {
    throw new MutationError('Add a step after a branch only on an If.');
  }
  const { S, C } = conditionMerge(def, conditionId);
  if (!C) {
    throw new MutationError('This branch has no single rejoin point to add a step after.');
  }

  const existing = new Set(model.nodes.map((n) => n.id));
  const newId = freshNodeId(type, existing);
  const fresh = defaultNodeConfig(type, now);

  const nodes: Record<string, DslNode> = {};
  for (const [nid, node] of Object.entries(def.nodes)) {
    // Re-point every BOUNDARY edge (a node IN S whose slot targets C) to N.
    nodes[nid] = S.has(nid) ? repointParents(node, C, newId) : { ...node };
  }
  // N sits between the branch and C. A condition can't be a linear merge step.
  if (type === 'condition') {
    throw new MutationError('Add the If on an arm — a branch step after the merge must be a single step.');
  } else if (type === 'exit') {
    // An exit after the merge would orphan C (nothing reaches it) → refuse.
    throw new MutationError('An Exit here would strand the steps below the branch.');
  } else {
    nodes[newId] = { ...fresh, next: C };
  }

  const nextDef = { startNode: def.startNode, nodes };
  assertWellFormed(nextDef, 'That step would break the journey.');
  return parseDefinition(nextDef);
}

/**
 * Is the merge (+) BELOW `condId` a valid place to DROP the duplicated `rootId`?
 * Valid when the target branch has a single rejoin C and the target is either the
 * moving branch ITSELF (place a copy to run right after this branch) or a condition
 * OUTSIDE the moving subtree (placing a copy after some other branch). A condition
 * strictly INSIDE the subtree being copied (other than the root) would self-nest.
 */
export function canPlaceAfterBranch(model: CanvasModel, rootId: string, condId: string): boolean {
  const def = buildDefinition(model);
  const cond = def.nodes[condId];
  if (!cond || cond.type !== 'condition') return false;
  if (branchContinuation(model, condId) === undefined) return false;
  if (condId === rootId) return true;
  return !movePlan(model, rootId).ids.has(condId);
}

/**
 * duplicateAfterBranch(model, rootId, condId) — DUPLICATE `rootId`'s subtree and
 * splice the copy AFTER the branch of `condId`, BEFORE that branch's continuation C:
 * every boundary edge of `condId` (an in-branch node → C) re-points to the clone root,
 * and the clone's own boundary (→ its continuation) re-points to C. So the original
 * branch flows THROUGH the copy before reaching C ("run the branch, then a copy").
 * When `condId === rootId` this places a copy to run right after the original branch.
 * Fresh ids → no cycle; re-validated locally + server-side.
 */
export function duplicateAfterBranch(model: CanvasModel, rootId: string, condId: string): CanvasModel {
  if (rootId === model.start) throw new MutationError("The trigger can't be duplicated.");
  const def = buildDefinition(model);
  const target = conditionMerge(def, condId);
  const Ct = target.C;
  const St = target.S;
  if (!Ct) throw new MutationError('This branch has no single rejoin point to add a copy after.');

  const plan = movePlan(model, rootId);
  const Sr = plan.ids;
  const Cr = plan.continuation;

  // Clone the subtree with fresh ids: internal edges → their clones; the clone's
  // BOUNDARY edges (→ its own continuation Cr) → the target continuation Ct.
  const existing = new Set<string>(Object.keys(def.nodes));
  const idMap = new Map<string, string>();
  for (const oldId of Sr) {
    const fresh = freshNodeId(paletteTypeOf(def.nodes[oldId]!), existing);
    existing.add(fresh);
    idMap.set(oldId, fresh);
  }
  const nodes: Record<string, DslNode> = { ...def.nodes };
  for (const oldId of Sr) {
    let clone: DslNode = { ...def.nodes[oldId]! };
    for (const slot of ['next', 'onTrue', 'onFalse'] as const) {
      const t = (clone as Record<string, unknown>)[slot];
      if (typeof t !== 'string' || t.length === 0) continue;
      if (Sr.has(t)) clone = repointSlot(clone, slot, idMap.get(t)!);
      else if (t === Cr) clone = repointSlot(clone, slot, Ct);
    }
    nodes[idMap.get(oldId)!] = clone;
  }
  // Re-point the TARGET branch's boundary edges (in-branch node → Ct) to the clone root.
  const cloneRoot = idMap.get(rootId)!;
  for (const nid of St) nodes[nid] = repointParents(nodes[nid]!, Ct, cloneRoot);

  const nextDef = { startNode: def.startNode, nodes };
  assertWellFormed(nextDef, 'That copy would break the journey.');
  return parseDefinition(nextDef);
}

/** Does the definition contain a cycle? (down-only must hold — a DFS back-edge fails.) */
function hasCycle(def: CampaignDefinition): boolean {
  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map<string, number>();
  const visit = (id: string): boolean => {
    color.set(id, GRAY);
    const node = def.nodes[id];
    if (node) {
      for (const e of outgoingEdges(id, node)) {
        const c = color.get(e.to) ?? WHITE;
        if (c === GRAY) return true; // back-edge
        if (c === WHITE && def.nodes[e.to] && visit(e.to)) return true;
      }
    }
    color.set(id, BLACK);
    return false;
  };
  for (const id of Object.keys(def.nodes)) {
    if ((color.get(id) ?? WHITE) === WHITE && visit(id)) return true;
  }
  return false;
}

/** Local structural guards (mirror deleteNode + add no-cycle); throw on failure. */
function assertWellFormed(def: CampaignDefinition, message: string): void {
  if (!hasReachableExit(def)) throw new MutationError(message);
  for (const [, node] of Object.entries(def.nodes)) {
    for (const e of outgoingEdges('_', node)) {
      if (!Object.prototype.hasOwnProperty.call(def.nodes, e.to)) throw new MutationError(message);
    }
  }
  if (hasCycle(def)) throw new MutationError(message);
}

/**
 * moveSubtree(model, rootId, destEdge) — relocate the node `rootId` together with
 * its EXCLUSIVE SUBTREE S to the destination edge A→B, splicing it in as
 * A→rootId→…→B and closing the gap it left (R's parents re-link to the
 * continuation C). Pure; re-validated locally + server-side.
 */
export function moveSubtree(model: CanvasModel, rootId: string, destEdge: CanvasEdge): CanvasModel {
  if (rootId === model.start) throw new MutationError("The trigger can't be moved.");
  const def = buildDefinition(model);
  const plan = movePlan(model, rootId);

  // SINGLE-NODE move: splice the node out (its parents re-link to rootId.next), then
  // insert it on the (post-splice) destination edge. A→B becomes A→rootId→B'. This
  // operates on JUST rootId — the tail below it stays where it is.
  if (plan.mode === 'single') {
    // Degenerate: dropping a node onto its OWN out-edge is meaningless.
    if (destEdge.from === rootId) {
      throw new MutationError("Choose a spot outside the step you're moving.");
    }
    // No-op: dropping onto an edge that ALREADY targets rootId AND is its SOLE
    // incoming edge leaves the graph identical. (When rootId has 2+ parents — e.g.
    // the empty-If shared continuation — a drop onto one arm DOES relocate it, so we
    // only short-circuit the single-parent case.)
    const incoming = countIncoming(def, rootId);
    if (destEdge.to === rootId && incoming === 1) return model;
    const successor = plan.continuation; // rootId.next
    const nodes: Record<string, DslNode> = {};
    // 1) SPLICE OUT rootId: every parent edge pointing at it re-links to its next.
    //    We carry rootId itself through unchanged (re-pointed below).
    for (const [nid, node] of Object.entries(def.nodes)) {
      if (nid === rootId) continue;
      nodes[nid] = repointParents(node, rootId, successor);
    }
    // 2) Resolve the destination's CURRENT target AFTER the splice (A's slot may have
    //    just been re-pointed to `successor` if A was a parent of rootId).
    const destFrom = nodes[destEdge.from];
    if (!destFrom) throw new MutationError('That move would break the journey.');
    const destTarget = (destFrom as Record<string, unknown>)[destEdge.slot];
    if (typeof destTarget !== 'string' || destTarget.length === 0) {
      throw new MutationError('That move would break the journey.');
    }
    // 3) INSERT rootId on the destination edge: A[slot] = rootId, rootId.next = the
    //    destination's now-current target. (rootId keeps its own non-edge config.)
    nodes[destEdge.from] = repointSlot(destFrom, destEdge.slot, rootId);
    nodes[rootId] = repointSlot(def.nodes[rootId]!, 'next', destTarget);

    const nextDef = { startNode: def.startNode, nodes };
    assertWellFormed(nextDef, 'That move would break the journey.');
    return parseDefinition(nextDef);
  }

  // BRANCH move (a condition root): relocate the EXCLUSIVE SUBTREE as a unit.
  const { ids: S, continuation: C } = plan;

  // No-op: already sitting on this destination.
  if (destEdge.to === rootId) return model;
  // The destination must be OUTSIDE the moving branch (else a cycle / self-insert).
  if (S.has(destEdge.from) || S.has(destEdge.to)) {
    throw new MutationError("Choose a spot outside the branch you're moving.");
  }

  const nodes: Record<string, DslNode> = {};
  for (const [nid, node] of Object.entries(def.nodes)) {
    if (S.has(nid)) {
      // Members of S keep their internal edges; only BOUNDARY edges (→ C) get
      // re-pointed to B (the new continuation below the moved branch).
      nodes[nid] = repointParents(node, C ?? '\0none', destEdge.to);
    } else {
      // DETACH: R's old parents re-link to C (drop if C undefined → validate catches
      // an orphan). REATTACH: A's slot that targeted B now targets rootId.
      let next = repointParents(node, rootId, C);
      if (nid === destEdge.from) next = repointSlot(next, destEdge.slot, rootId);
      nodes[nid] = next;
    }
  }

  const nextDef = { startNode: def.startNode, nodes };
  assertWellFormed(nextDef, 'That move would break the journey.');
  return parseDefinition(nextDef);
}

/**
 * duplicateSubtree(model, rootId, destEdge) — CLONE the node `rootId` and its
 * exclusive subtree S with FRESH ids and splice the copy onto the destination
 * edge A→B (A→cloneRoot→…→B). The originals are untouched; fresh ids can't cycle
 * with originals. Pure; re-validated locally + server-side.
 */
export function duplicateSubtree(model: CanvasModel, rootId: string, destEdge: CanvasEdge): CanvasModel {
  if (rootId === model.start) throw new MutationError("The trigger can't be duplicated.");
  const def = buildDefinition(model);
  const plan = movePlan(model, rootId);

  // SINGLE-NODE duplicate: clone JUST rootId with a fresh id and splice the copy on
  // the destination edge (A→clone→B). The originals are untouched.
  if (plan.mode === 'single') {
    if (destEdge.from === rootId) {
      throw new MutationError("Choose a spot outside the step you're copying.");
    }
    const existing = new Set<string>(Object.keys(def.nodes));
    const cloneId = freshNodeId(paletteTypeOf(def.nodes[rootId]!), existing);
    const nodes: Record<string, DslNode> = { ...def.nodes };
    // The clone copies rootId's config, but its `next` is the destination's target B.
    nodes[cloneId] = repointSlot({ ...def.nodes[rootId]! }, 'next', destEdge.to);
    // Splice: A's slot that targeted B now targets the clone. Originals untouched.
    nodes[destEdge.from] = repointSlot(nodes[destEdge.from]!, destEdge.slot, cloneId);

    const nextDef = { startNode: def.startNode, nodes };
    assertWellFormed(nextDef, 'That copy would break the journey.');
    return parseDefinition(nextDef);
  }

  // BRANCH duplicate (a condition root): clone the EXCLUSIVE SUBTREE as a unit.
  const { ids: S, continuation: C } = plan;

  // Build an old→new id map, minting a fresh id per cloned node (collision-checked
  // against the originals AND the ids already minted).
  const existing = new Set<string>(Object.keys(def.nodes));
  const idMap = new Map<string, string>();
  for (const oldId of S) {
    const node = def.nodes[oldId]!;
    const type = paletteTypeOf(node);
    const fresh = freshNodeId(type, existing);
    existing.add(fresh);
    idMap.set(oldId, fresh);
  }

  const nodes: Record<string, DslNode> = { ...def.nodes };
  for (const oldId of S) {
    const cloneId = idMap.get(oldId)!;
    const node = def.nodes[oldId]!;
    // Copy the node; remap INTERNAL edges (target in S → its clone), and clone
    // BOUNDARY edges (→ C) to point at B (the destination continuation).
    let clone: DslNode = { ...node };
    for (const slot of ['next', 'onTrue', 'onFalse'] as const) {
      const target = (node as Record<string, unknown>)[slot];
      if (typeof target !== 'string' || target.length === 0) continue;
      if (S.has(target)) clone = { ...clone, [slot]: idMap.get(target)! };
      else if (target === C) clone = { ...clone, [slot]: destEdge.to };
    }
    nodes[cloneId] = clone;
  }

  // Splice: A's slot that targeted B now targets the clone-root. Originals untouched.
  nodes[destEdge.from] = repointSlot(nodes[destEdge.from]!, destEdge.slot, idMap.get(rootId)!);

  const nextDef = { startNode: def.startNode, nodes };
  assertWellFormed(nextDef, 'That copy would break the journey.');
  return parseDefinition(nextDef);
}

/** Map a DSL node back to the PaletteType freshNodeId expects (for clone ids). */
function paletteTypeOf(node: DslNode): PaletteType {
  switch (node.type) {
    case 'wait':
      return isWaitUntil(node) ? 'wait_until' : 'wait';
    case 'hour_of_day_window':
      return 'hour_of_day_window';
    case 'condition':
      return 'condition';
    case 'action': {
      const kind = (node as { kind?: unknown }).kind;
      if (kind === 'send' || kind === 'set_attribute' || kind === 'set_journey' || kind === 'webhook') return kind;
      return 'send';
    }
    case 'exit':
    default:
      return 'exit';
  }
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
      if (kind === 'profile') {
        const pc = String((node as { profileChange?: unknown }).profileChange ?? 'any');
        if (pc === 'created') return 'On profile created';
        if (pc === 'updated') return 'On profile updated';
        return 'On profile created or updated';
      }
      const map: Record<string, string> = {
        segment_entry: 'On segment entry',
        event: 'On event',
        manual: 'Manual enrollment',
      };
      return map[kind] ?? 'Trigger';
    }
    case 'wait': {
      const n = node as {
        until?: unknown;
        untilOffset?: { amount?: number; unit?: string; anchor?: string };
        waitCondition?: unknown;
        maxWait?: { amount?: number; unit?: string };
        delay?: { seconds?: number };
      };
      if (isWaitUntil(node)) {
        const nn = node as typeof n & { combine?: string };
        const parts: string[] = [];
        if (typeof n.until === 'string') parts.push('a date');
        else if (n.untilOffset) {
          const a = n.untilOffset.amount ?? 1;
          const u = n.untilOffset.unit ?? 'days';
          const dir = (n.untilOffset as { direction?: string }).direction === 'before' ? 'before' : 'after';
          const anchorLabel = n.untilOffset.anchor && n.untilOffset.anchor !== 'now' ? 'a timestamp' : 'now';
          parts.push(`${a} ${u} ${dir} ${anchorLabel}`);
        }
        if (n.waitCondition) parts.push('a condition');
        const joiner = parts.length === 2 ? (nn.combine === 'or' ? ' OR ' : ' AND ') : ' + ';
        const base = parts.length ? `Wait until ${parts.join(joiner)}` : 'Wait until';
        return n.maxWait ? `${base} (max ${n.maxWait.amount ?? 1} ${n.maxWait.unit ?? 'days'})` : base;
      }
      const secs = typeof n.delay?.seconds === 'number' ? n.delay.seconds : 0;
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
      if (kind === 'send') {
        const medium = String((node as { medium?: unknown }).medium ?? 'email');
        if (medium === 'sms') return 'Send SMS';
        if (medium === 'whatsapp') return 'Send WhatsApp';
        return 'Send email';
      }
      if (kind === 'set_attribute' || kind === 'set_journey') {
        const isJourney = kind === 'set_journey';
        const noun = isJourney ? 'journey vars' : 'attributes';
        const fallback = isJourney ? 'Update journey' : 'Update profile';
        const list = (node as { assignments?: ReadonlyArray<{ key?: unknown }> }).assignments;
        if (Array.isArray(list)) {
          const keyed = list.filter((a) => typeof a?.key === 'string' && (a.key as string).trim().length > 0);
          if (keyed.length === 1) return `Set ${(keyed[0]!.key as string).trim()}`;
          if (keyed.length > 1) return `Set ${keyed.length} ${noun}`;
        }
        const key = String((node as { key?: unknown }).key ?? '');
        return key ? `Set ${key}` : fallback;
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
