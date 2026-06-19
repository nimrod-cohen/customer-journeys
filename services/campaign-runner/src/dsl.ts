// Campaign workflow node DSL (§9B). A campaign's `definition` is a graph:
//   { startNode: <id>, nodes: { <id>: Node } }
// where a Node is one of: trigger | wait | condition | action | exit.
//
// This module owns the node TYPES and STRUCTURAL validation
// (validateCampaignDefinition) plus the small graph helpers resolveStartNode /
// findNode. It is pure and has no I/O — the runner (core/run) consumes these
// types. condition `ast` is the §8 AstNode reused verbatim (branch conditions
// compile through @cdp/segments).
import { validateAst, type AstNode } from '@cdp/segments';

/** A trigger node — how a profile enters the campaign (§9B enrollment).
 *  Three kinds (re-enrollment policy is 'once' for all of them — see core.ts):
 *    - segment_entry: enrollment is driven by campaigns.trigger_segment_id (the
 *      segment lives on the CAMPAIGN ROW, not the node) via enrollFromSegmentChange.
 *    - event: an INGESTED EVENT of `eventType` (optionally matching `filter`, a
 *      payload-only AstNode) enrolls the profile via enrollFromEvent. Both fields
 *      live HERE in the definition JSON (no migration).
 *    - manual: no auto-source — enrolled by the API (POST /campaigns/:id/enroll).
 */
export interface TriggerNode {
  readonly type: 'trigger';
  /** segment_entry uses campaigns.trigger_segment_id; others live in definition. */
  readonly kind: 'segment_entry' | 'event' | 'manual';
  /** For kind='event' (REQUIRED): the event type that enrolls the profile. */
  readonly eventType?: string;
  /** For kind='event' (OPTIONAL): a payload-only filter (payload.* namespace),
   *  evaluated against the ingested event payload in-memory at enroll time. */
  readonly filter?: AstNode;
  /** The node id to advance to once enrolled. */
  readonly next: string;
}

/** A relative delay spec: a whole number of seconds. */
export interface WaitDelaySeconds {
  readonly seconds: number;
}

/** A wait node — defers the journey via next_run_at (§9B "waits"). */
export interface WaitNode {
  readonly type: 'wait';
  /** Relative delay: either {seconds} or an ISO-8601 duration string. */
  readonly delay?: WaitDelaySeconds | string;
  /** Absolute wait: resume at this date (ISO-8601 string or Date). */
  readonly until?: string | Date;
  /** The node id to advance to once the wait elapses. */
  readonly next: string;
}

/** A condition (branch) node — routes via the §8 compiler (reuses AstNode). */
export interface ConditionNode {
  readonly type: 'condition';
  /** The §8 rule AST evaluated against the profile's features/attributes. */
  readonly ast: AstNode;
  /** Node id taken when the AST matches. */
  readonly onTrue: string;
  /** Node id taken when the AST does NOT match. */
  readonly onFalse: string;
}

/** HTTP methods a webhook action may use. */
export type WebhookMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/**
 * A webhook ACTION (action.kind='webhook') — fires an outbound HTTP request as a
 * journey side effect (§9B). TYPES + STRUCTURAL validation only this phase; the
 * runner does NOT execute it yet (phase 2: injected/mocked HTTP client, a
 * per-workspace host ALLOWLIST + SSRF guards, a timeout + BOUNDED retries, and an
 * isolated failure that never crashes the tick).
 */
export interface WebhookAction {
  readonly type: 'action';
  readonly kind: 'webhook';
  /** Target URL — http(s) ONLY (a model-layer SSRF pre-check; full IP/host
   *  allowlist enforcement is a phase-2 runtime concern). */
  readonly url: string;
  /** HTTP method. */
  readonly method: WebhookMethod;
  /** Request headers. An optional auth header MAY carry a secret; in phase 2 that
   *  secret is envelope-encrypted at rest (@cdp/db secret-crypto) and never
   *  returned in plaintext over the API. */
  readonly headers?: Readonly<Record<string, string>>;
  /** Merge-aware request body template ({{customer.*}} expanded at send, phase 2). */
  readonly bodyTemplate?: string;
  /** Per-attempt timeout in milliseconds (> 0). */
  readonly timeoutMs?: number;
  /** Maximum retry attempts on failure (>= 0). */
  readonly maxRetries?: number;
  /** The node id to advance to after the call. */
  readonly next: string;
}

/** An action node — a send or a set_attribute side effect (§9B). For webhook
 *  actions use the {@link WebhookAction} shape (also part of the Node union). */
export interface ActionNode {
  readonly type: 'action';
  readonly kind: 'send' | 'set_attribute';
  /** For kind='send': the email template to enqueue through the Dispatcher.
   * The envelope (subject / From / To) lives ON that template, not here. */
  readonly template_id?: string;
  /** For kind='set_attribute': the profile attribute key to set. */
  readonly key?: string;
  /** For kind='set_attribute': the value to set. */
  readonly value?: unknown;
  /** The node id to advance to after the action. */
  readonly next: string;
}

/**
 * An hour-of-day window node (§9B) — gates the journey to an allowed time window.
 * The runner advances immediately when the profile is already inside the window,
 * else PARKS the enrollment until the next window opening (computed later in the
 * runner using the WORKSPACE timezone — DST-correct, never per-broadcast guesswork).
 *
 * `startHour`/`endHour` are integers 0–23. `startHour > endHour` is a VALID
 * OVERNIGHT (wrap-around) window, e.g. 22..6 means 22:00 through 06:59. Optional
 * `daysOfWeek` restricts to specific weekdays (0=Sun … 6=Sat); when omitted, all
 * days are allowed. TYPES + STRUCTURAL validation only this phase (no runner exec).
 */
export interface HourOfDayWindowNode {
  readonly type: 'hour_of_day_window';
  /** Window start hour, integer 0–23 (inclusive). */
  readonly startHour: number;
  /** Window end hour, integer 0–23 (inclusive). May be < startHour (overnight). */
  readonly endHour: number;
  /** Optional allowed weekdays (0=Sun … 6=Sat); unique, non-empty when present. */
  readonly daysOfWeek?: readonly number[];
  /** The node id to advance to once inside (or after parking until) the window. */
  readonly next: string;
}

/** An exit node — terminal; the enrollment completes here. */
export interface ExitNode {
  readonly type: 'exit';
}

/** Any campaign workflow node. */
export type Node =
  | TriggerNode
  | WaitNode
  | ConditionNode
  | ActionNode
  | WebhookAction
  | HourOfDayWindowNode
  | ExitNode;

/** A campaign definition: a start node id + a node graph keyed by id (§9B). */
export interface CampaignDefinition {
  readonly startNode: string;
  readonly nodes: Readonly<Record<string, Node>>;
}

const NODE_TYPES = new Set(['trigger', 'wait', 'condition', 'action', 'hour_of_day_window', 'exit']);

const WEBHOOK_METHODS = new Set<WebhookMethod>(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);

/** Type guard: a value is a plausible Node object (has a known `type`). */
function isNodeObject(v: unknown): v is Node {
  return (
    typeof v === 'object' &&
    v !== null &&
    typeof (v as { type?: unknown }).type === 'string' &&
    NODE_TYPES.has((v as { type: string }).type)
  );
}

/**
 * Structurally validate a campaign definition (§9B). THROWS on any malformed
 * graph so the runner never enrolls into garbage. Checks:
 *   - shape: object with a string startNode + a non-empty nodes map.
 *   - exactly ONE trigger node.
 *   - unique node ids (guaranteed by the map; the start id must resolve).
 *   - per-type required fields (trigger.kind/next, wait.next + delay|until,
 *     condition.ast/onTrue/onFalse, action.kind + send→template_id /
 *     set_attribute→key, webhook→url(http(s))/method/positive timeoutMs/non-neg
 *     maxRetries, hour_of_day_window.startHour/endHour 0–23 + optional daysOfWeek,
 *     and the node's next/onTrue/onFalse edges).
 *   - every edge target (next/onTrue/onFalse/startNode) resolves to a node.
 *   - at least one exit node is REACHABLE from the start (no infinite graph).
 *   - NO CYCLES / back-edges — the builder is a DOWN-ONLY auto-layout of the
 *     graph; a back-edge to an ancestor (or a self-loop) is rejected. A diamond /
 *     re-convergence (two paths into the same downstream node) is NOT a cycle and
 *     is allowed.
 *   - NO ORPHANS — every defined node must be reachable from startNode.
 */
export function validateCampaignDefinition(def: unknown): asserts def is CampaignDefinition {
  if (typeof def !== 'object' || def === null) {
    throw new Error('validateCampaignDefinition: definition must be an object');
  }
  const d = def as { startNode?: unknown; nodes?: unknown };
  if (typeof d.startNode !== 'string' || d.startNode.length === 0) {
    throw new Error('validateCampaignDefinition: startNode must be a non-empty string');
  }
  if (typeof d.nodes !== 'object' || d.nodes === null) {
    throw new Error('validateCampaignDefinition: nodes must be an object map');
  }
  const nodes = d.nodes as Record<string, unknown>;
  const ids = Object.keys(nodes);
  if (ids.length === 0) {
    throw new Error('validateCampaignDefinition: nodes map must be non-empty');
  }

  // Validate each node shape + collect triggers.
  let triggerCount = 0;
  for (const id of ids) {
    const node = nodes[id];
    if (!isNodeObject(node)) {
      throw new Error(`validateCampaignDefinition: node "${id}" has an unknown/invalid type`);
    }
    if (node.type === 'trigger') triggerCount += 1;
    validateNodeFields(id, node, nodes);
  }
  if (triggerCount !== 1) {
    throw new Error(
      `validateCampaignDefinition: exactly one trigger node required (found ${triggerCount})`,
    );
  }

  // startNode must resolve.
  if (!Object.prototype.hasOwnProperty.call(nodes, d.startNode)) {
    throw new Error(`validateCampaignDefinition: startNode "${d.startNode}" is not a defined node`);
  }

  // No cycles / back-edges (the builder is a down-only auto-layout). A diamond /
  // re-convergence is fine — only a back-edge to a node on the current DFS stack
  // (or a self-loop) is a cycle. Run this BEFORE the reachable-exit check so a
  // looping graph is reported as a cycle (the precise diagnosis) rather than as a
  // generic "no exit".
  detectCycle(d.startNode, nodes as Record<string, Node>);

  // A reachable exit must exist (BFS from start).
  if (!hasReachableExit(d.startNode, nodes as Record<string, Node>)) {
    throw new Error('validateCampaignDefinition: no exit node is reachable from startNode');
  }

  // No orphans — every defined node must be reachable from startNode.
  const orphans = findOrphans(d.startNode, nodes as Record<string, Node>);
  if (orphans.length > 0) {
    throw new Error(
      `validateCampaignDefinition: node(s) not reachable from startNode (orphan): ${orphans.join(', ')}`,
    );
  }
}

/** Validate one node's required fields + that its edges resolve. */
function validateNodeFields(id: string, node: Node, nodes: Record<string, unknown>): void {
  const requireEdge = (target: unknown, label: string): void => {
    if (typeof target !== 'string' || target.length === 0) {
      throw new Error(`validateCampaignDefinition: node "${id}" ${label} must be a node id`);
    }
    if (!Object.prototype.hasOwnProperty.call(nodes, target)) {
      throw new Error(
        `validateCampaignDefinition: node "${id}" ${label} -> "${target}" is unresolvable`,
      );
    }
  };

  switch (node.type) {
    case 'trigger':
      if (node.kind !== 'segment_entry' && node.kind !== 'event' && node.kind !== 'manual') {
        throw new Error(`validateCampaignDefinition: trigger "${id}" has an invalid kind`);
      }
      if (node.kind === 'event') {
        // An event trigger MUST name the event type; the optional payload filter is
        // a payload-only AstNode (structurally validated; the field whitelist is
        // enforced at enroll time by evaluateEventPayloadFilter).
        if (typeof node.eventType !== 'string' || node.eventType.length === 0) {
          throw new Error(`validateCampaignDefinition: event trigger "${id}" needs an eventType`);
        }
        if (node.filter !== undefined) {
          if (typeof node.filter !== 'object' || node.filter === null || Array.isArray(node.filter)) {
            throw new Error(`validateCampaignDefinition: event trigger "${id}" filter must be an AstNode object`);
          }
          validateAst(node.filter); // THROWS on a malformed AstNode shape
        }
      }
      requireEdge(node.next, 'next');
      return;
    case 'wait': {
      const hasDelay = node.delay !== undefined;
      const hasUntil = node.until !== undefined;
      if (!hasDelay && !hasUntil) {
        throw new Error(`validateCampaignDefinition: wait "${id}" needs a delay or until`);
      }
      requireEdge(node.next, 'next');
      return;
    }
    case 'condition':
      if (typeof node.ast !== 'object' || node.ast === null) {
        throw new Error(`validateCampaignDefinition: condition "${id}" needs an ast`);
      }
      requireEdge(node.onTrue, 'onTrue');
      requireEdge(node.onFalse, 'onFalse');
      return;
    case 'action': {
      const kind = (node as { kind?: unknown }).kind;
      if (kind === 'webhook') {
        const hook = node as WebhookAction;
        validateWebhookFields(id, hook);
        requireEdge(hook.next, 'next');
        return;
      }
      if (kind !== 'send' && kind !== 'set_attribute') {
        throw new Error(`validateCampaignDefinition: action "${id}" has an invalid kind`);
      }
      const act = node as ActionNode;
      if (kind === 'send' && (typeof act.template_id !== 'string' || !act.template_id)) {
        throw new Error(`validateCampaignDefinition: send action "${id}" needs a template_id`);
      }
      if (kind === 'set_attribute' && (typeof act.key !== 'string' || !act.key)) {
        throw new Error(`validateCampaignDefinition: set_attribute action "${id}" needs a key`);
      }
      requireEdge(act.next, 'next');
      return;
    }
    case 'hour_of_day_window':
      validateHourWindowFields(id, node);
      requireEdge(node.next, 'next');
      return;
    case 'exit':
      return;
  }
}

/** Validate a webhook action's fields (model-layer; runner exec is phase 2). */
function validateWebhookFields(id: string, node: WebhookAction): void {
  // url — http(s) ONLY (SSRF pre-check; full allowlist enforcement is phase 2).
  if (typeof node.url !== 'string' || node.url.length === 0) {
    throw new Error(`validateCampaignDefinition: webhook "${id}" needs a url`);
  }
  let parsed: URL;
  try {
    parsed = new URL(node.url);
  } catch {
    throw new Error(`validateCampaignDefinition: webhook "${id}" url is not a valid url`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`validateCampaignDefinition: webhook "${id}" url must use the http(s) scheme`);
  }
  if (typeof node.method !== 'string' || !WEBHOOK_METHODS.has(node.method as WebhookMethod)) {
    throw new Error(
      `validateCampaignDefinition: webhook "${id}" method must be one of ${[...WEBHOOK_METHODS].join('/')}`,
    );
  }
  if (node.headers !== undefined && (typeof node.headers !== 'object' || node.headers === null || Array.isArray(node.headers))) {
    throw new Error(`validateCampaignDefinition: webhook "${id}" headers must be an object`);
  }
  if (node.bodyTemplate !== undefined && typeof node.bodyTemplate !== 'string') {
    throw new Error(`validateCampaignDefinition: webhook "${id}" bodyTemplate must be a string`);
  }
  if (node.timeoutMs !== undefined && (typeof node.timeoutMs !== 'number' || !(node.timeoutMs > 0))) {
    throw new Error(`validateCampaignDefinition: webhook "${id}" timeoutMs must be a positive number`);
  }
  if (
    node.maxRetries !== undefined &&
    (typeof node.maxRetries !== 'number' || !Number.isInteger(node.maxRetries) || node.maxRetries < 0)
  ) {
    throw new Error(`validateCampaignDefinition: webhook "${id}" maxRetries must be a non-negative integer`);
  }
}

/** Validate an hour_of_day_window node's fields (runner interprets later). */
function validateHourWindowFields(id: string, node: HourOfDayWindowNode): void {
  const isHour = (h: unknown): boolean => typeof h === 'number' && Number.isInteger(h) && h >= 0 && h <= 23;
  if (node.startHour === undefined || node.endHour === undefined) {
    throw new Error(`validateCampaignDefinition: hour window "${id}" needs startHour and endHour`);
  }
  if (!isHour(node.startHour) || !isHour(node.endHour)) {
    throw new Error(`validateCampaignDefinition: hour window "${id}" hours must be integers 0–23`);
  }
  // startHour > endHour is a VALID overnight wrap-around (semantics resolved in the runner).
  if (node.daysOfWeek !== undefined) {
    const d = node.daysOfWeek;
    if (!Array.isArray(d) || d.length === 0) {
      throw new Error(`validateCampaignDefinition: hour window "${id}" daysOfWeek must be a non-empty array`);
    }
    const seen = new Set<number>();
    for (const day of d) {
      if (typeof day !== 'number' || !Number.isInteger(day) || day < 0 || day > 6) {
        throw new Error(`validateCampaignDefinition: hour window "${id}" daysOfWeek values must be integers 0–6`);
      }
      if (seen.has(day)) {
        throw new Error(`validateCampaignDefinition: hour window "${id}" daysOfWeek has a duplicate day`);
      }
      seen.add(day);
    }
  }
}

/** Outgoing edge targets of a node (for reachability). */
function edgesOf(node: Node): string[] {
  switch (node.type) {
    case 'trigger':
    case 'action': // covers both ActionNode and WebhookAction (both carry `next`)
    case 'wait':
    case 'hour_of_day_window':
      return [node.next];
    case 'condition':
      return [node.onTrue, node.onFalse];
    case 'exit':
      return [];
  }
}

/** BFS: is any exit node reachable from `start`? */
function hasReachableExit(start: string, nodes: Record<string, Node>): boolean {
  const seen = new Set<string>();
  const queue: string[] = [start];
  while (queue.length > 0) {
    const id = queue.shift() as string;
    if (seen.has(id)) continue;
    seen.add(id);
    const node = nodes[id];
    if (!node) continue;
    if (node.type === 'exit') return true;
    for (const t of edgesOf(node)) queue.push(t);
  }
  return false;
}

/**
 * DFS cycle detection with a recursion (GREY) stack. THROWS on a back-edge to a
 * node currently on the DFS stack — i.e. a true cycle (including a self-loop). A
 * diamond / re-convergence (a node reached via two paths but NOT on the current
 * stack) is NOT a cycle and is allowed. Edges to undefined nodes are ignored here
 * (validateNodeFields already rejected unresolvable edges).
 */
function detectCycle(start: string, nodes: Record<string, Node>): void {
  const WHITE = 0;
  const GREY = 1; // on the current recursion stack
  const BLACK = 2; // fully explored
  const color = new Map<string, number>();

  const visit = (id: string): void => {
    color.set(id, GREY);
    const node = nodes[id];
    if (node) {
      for (const t of edgesOf(node)) {
        const c = color.get(t) ?? WHITE;
        if (c === GREY) {
          throw new Error(
            `validateCampaignDefinition: cycle detected (back-edge "${id}" -> "${t}"); the graph must be acyclic`,
          );
        }
        if (c === WHITE && nodes[t]) visit(t);
      }
    }
    color.set(id, BLACK);
  };

  visit(start);
}

/** Reachable-set BFS from startNode; any defined node not reached is an orphan. */
function findOrphans(start: string, nodes: Record<string, Node>): string[] {
  const reachable = new Set<string>();
  const queue: string[] = [start];
  while (queue.length > 0) {
    const id = queue.shift() as string;
    if (reachable.has(id)) continue;
    reachable.add(id);
    const node = nodes[id];
    if (!node) continue;
    for (const t of edgesOf(node)) queue.push(t);
  }
  return Object.keys(nodes).filter((id) => !reachable.has(id));
}

/** Resolve the start node from a (validated) definition. THROWS if missing. */
export function resolveStartNode(def: CampaignDefinition): Node {
  const node = def.nodes[def.startNode];
  if (!node) {
    throw new Error(`resolveStartNode: startNode "${def.startNode}" not found`);
  }
  return node;
}

/** Find a node by id. THROWS if the id is not defined (an unresolvable edge). */
export function findNode(def: CampaignDefinition, id: string): Node {
  const node = def.nodes[id];
  if (!node) {
    throw new Error(`findNode: node "${id}" not found`);
  }
  return node;
}
