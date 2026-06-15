// Campaign workflow node DSL (§9B). A campaign's `definition` is a graph:
//   { startNode: <id>, nodes: { <id>: Node } }
// where a Node is one of: trigger | wait | condition | action | exit.
//
// This module owns the node TYPES and STRUCTURAL validation
// (validateCampaignDefinition) plus the small graph helpers resolveStartNode /
// findNode. It is pure and has no I/O — the runner (core/run) consumes these
// types. condition `ast` is the §8 AstNode reused verbatim (branch conditions
// compile through @cdp/segments).
import type { AstNode } from '@cdp/segments';

/** A trigger node — how a profile enters the campaign (§9B enrollment). */
export interface TriggerNode {
  readonly type: 'trigger';
  /** segment_entry uses campaigns.trigger_segment_id; others live in definition. */
  readonly kind: 'segment_entry' | 'event' | 'manual';
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

/** An action node — a send or a set_attribute side effect (§9B). */
export interface ActionNode {
  readonly type: 'action';
  readonly kind: 'send' | 'set_attribute';
  /** For kind='send': the email template to enqueue through the Dispatcher. */
  readonly template_id?: string;
  /** For kind='send': the email subject line (merge tags allowed). */
  readonly subject?: string;
  /** For kind='send': optional named sender (a domain_senders id) for the From. */
  readonly sender_id?: string;
  /** For kind='set_attribute': the profile attribute key to set. */
  readonly key?: string;
  /** For kind='set_attribute': the value to set. */
  readonly value?: unknown;
  /** The node id to advance to after the action. */
  readonly next: string;
}

/** An exit node — terminal; the enrollment completes here. */
export interface ExitNode {
  readonly type: 'exit';
}

/** Any campaign workflow node. */
export type Node = TriggerNode | WaitNode | ConditionNode | ActionNode | ExitNode;

/** A campaign definition: a start node id + a node graph keyed by id (§9B). */
export interface CampaignDefinition {
  readonly startNode: string;
  readonly nodes: Readonly<Record<string, Node>>;
}

const NODE_TYPES = new Set(['trigger', 'wait', 'condition', 'action', 'exit']);

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
 *     set_attribute→key, action.next).
 *   - every edge target (next/onTrue/onFalse/startNode) resolves to a node.
 *   - at least one exit node is REACHABLE from the start (no infinite graph).
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

  // A reachable exit must exist (BFS from start).
  if (!hasReachableExit(d.startNode, nodes as Record<string, Node>)) {
    throw new Error('validateCampaignDefinition: no exit node is reachable from startNode');
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
    case 'action':
      if (node.kind !== 'send' && node.kind !== 'set_attribute') {
        throw new Error(`validateCampaignDefinition: action "${id}" has an invalid kind`);
      }
      if (node.kind === 'send' && (typeof node.template_id !== 'string' || !node.template_id)) {
        throw new Error(`validateCampaignDefinition: send action "${id}" needs a template_id`);
      }
      if (node.kind === 'set_attribute' && (typeof node.key !== 'string' || !node.key)) {
        throw new Error(`validateCampaignDefinition: set_attribute action "${id}" needs a key`);
      }
      requireEdge(node.next, 'next');
      return;
    case 'exit':
      return;
  }
}

/** Outgoing edge targets of a node (for reachability). */
function edgesOf(node: Node): string[] {
  switch (node.type) {
    case 'trigger':
    case 'action':
      return [node.next];
    case 'wait':
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
