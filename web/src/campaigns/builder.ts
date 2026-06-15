// Pure helpers for the visual campaign/workflow builder UI (§12 CampaignBuilder,
// §9B). The UI edits a list of nodes (trigger / wait / condition / action / exit)
// and this module assembles them into the `CampaignDefinition` graph the backend
// validates with validateCampaignDefinition. Keeping the assembly pure makes the
// builder unit-testable and guarantees the emitted graph is structurally sound.

export type NodeType = 'trigger' | 'wait' | 'condition' | 'action' | 'exit';

/** A node as edited in the builder canvas. */
export interface BuilderNode {
  readonly id: string;
  readonly type: NodeType;
  /** trigger.kind / action.kind. */
  readonly kind?: string;
  /** wait delay in seconds. */
  readonly delaySeconds?: number;
  /** action send template id. */
  readonly templateId?: string;
  /** action send subject line. */
  readonly subject?: string;
  /** action send named sender (domain_senders id) for the From. */
  readonly senderId?: string;
  /** condition rule AST. */
  readonly ast?: unknown;
  /** primary next edge (trigger/wait/action). */
  readonly next?: string;
  /** condition branch edges. */
  readonly onTrue?: string;
  readonly onFalse?: string;
}

/** The assembled definition (matches @cdp/service-campaign-runner CampaignDefinition). */
export interface CampaignDefinition {
  startNode: string;
  nodes: Record<string, unknown>;
}

/** Compile one builder node to its definition node shape. */
export function nodeToDef(node: BuilderNode): Record<string, unknown> {
  switch (node.type) {
    case 'trigger':
      return { type: 'trigger', kind: node.kind ?? 'segment_entry', next: node.next };
    case 'wait':
      return { type: 'wait', delay: { seconds: node.delaySeconds ?? 0 }, next: node.next };
    case 'condition':
      return { type: 'condition', ast: node.ast, onTrue: node.onTrue, onFalse: node.onFalse };
    case 'action':
      return node.kind === 'set_attribute'
        ? { type: 'action', kind: 'set_attribute', key: node.templateId ?? '', next: node.next }
        : {
            type: 'action',
            kind: 'send',
            template_id: node.templateId,
            ...(node.subject ? { subject: node.subject } : {}),
            ...(node.senderId ? { sender_id: node.senderId } : {}),
            next: node.next,
          };
    case 'exit':
      return { type: 'exit' };
  }
}

/**
 * Assemble a CampaignDefinition from builder nodes. The startNode is the single
 * trigger node's id. THROWS if there isn't exactly one trigger — the builder must
 * present a valid graph before save (the backend re-validates regardless).
 */
export function buildDefinition(nodes: readonly BuilderNode[]): CampaignDefinition {
  const triggers = nodes.filter((n) => n.type === 'trigger');
  if (triggers.length !== 1) {
    throw new Error(`campaign builder: exactly one trigger node required (found ${triggers.length})`);
  }
  const nodeMap: Record<string, unknown> = {};
  for (const n of nodes) nodeMap[n.id] = nodeToDef(n);
  return { startNode: triggers[0]!.id, nodes: nodeMap };
}

/** A minimal valid starter graph: trigger → send → exit. */
export function starterNodes(templateId: string): BuilderNode[] {
  return [
    { id: 'trigger', type: 'trigger', kind: 'segment_entry', next: 'send' },
    { id: 'send', type: 'action', kind: 'send', templateId, next: 'done' },
    { id: 'done', type: 'exit' },
  ];
}
