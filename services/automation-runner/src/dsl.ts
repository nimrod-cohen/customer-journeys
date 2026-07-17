// Automation workflow node DSL (§9B). A automation's `definition` is a graph:
//   { startNode: <id>, nodes: { <id>: Node } }
// where a Node is one of: trigger | wait | condition | action | exit.
//
// This module owns the node TYPES and STRUCTURAL validation
// (validateAutomationDefinition) plus the small graph helpers resolveStartNode /
// findNode. It is pure and has no I/O — the runner (core/run) consumes these
// types. condition `ast` is the §8 AstNode reused verbatim (branch conditions
// compile through @cdp/segments).
import { validateAst, type AstNode } from '@cdp/segments';
import { isExpressionSpec, isLiteralSpec, isJsSpec, type ValueSpec } from '@cdp/shared';
import { isMedium, isTextMedium, type Medium } from '@cdp/channels';

// Re-export the sending medium so consumers importing from the runner's DSL get it.
export type { Medium } from '@cdp/channels';

// Re-export the value spec so consumers importing from the runner's DSL get it.
export type { ValueSpec } from '@cdp/shared';

/** Which profile mutation enrolls for a kind='profile' trigger. */
export type ProfileChange = 'created' | 'updated' | 'any';

/** A trigger node — how a profile enters the automation (§9B enrollment).
 *  Four kinds (re-enrollment policy is 'once' for all of them — see core.ts):
 *    - segment_entry: enrollment is driven by automations.trigger_segment_id (the
 *      segment lives on the AUTOMATION ROW, not the node) via enrollFromSegmentChange.
 *    - event: an INGESTED EVENT of `eventType` (optionally matching `filter`, a
 *      payload-only AstNode) enrolls the profile via enrollFromEvent. Both fields
 *      live HERE in the definition JSON (no migration).
 *    - profile: enrolls when a PROFILE is CREATED or UPDATED (enrollFromProfileChange,
 *      wired at createProfile / updateProfile / CSV import). `profileChange` narrows
 *      which mutation fires it (created | updated | any; default 'any'). The profile's
 *      own data is available downstream via the customer.* namespace — no event payload.
 *    - manual: no auto-source — enrolled by the API (POST /automations/:id/enroll).
 */
export interface TriggerNode {
  readonly type: 'trigger';
  /** segment_entry uses automations.trigger_segment_id; others live in definition. */
  readonly kind: 'segment_entry' | 'event' | 'profile' | 'manual';
  /** Optional human label for the trigger card (e.g. "New VIPs"), shown on the canvas.
   *  Purely cosmetic — like a condition's label, it NEVER affects routing or validation. */
  readonly label?: string;
  /** For kind='event' (REQUIRED): the event type that enrolls the profile. */
  readonly eventType?: string;
  /** For kind='event' (OPTIONAL): a payload-only filter (payload.* namespace),
   *  evaluated against the ingested event payload in-memory at enroll time. */
  readonly filter?: AstNode;
  /** For kind='profile' (OPTIONAL): which mutation enrolls (default 'any'). */
  readonly profileChange?: ProfileChange;
  /** The node id to advance to once enrolled. */
  readonly next: string;
}

/** A relative delay spec: a whole number of seconds. */
export interface WaitDelaySeconds {
  readonly seconds: number;
}

/** The duration unit for the rich wait-until offset / max-wait. */
export type WaitDurationUnit = 'minutes' | 'hours' | 'days';

/**
 * A RELATIVE time gate for a rich wait-until: `amount` `unit` from an `anchor`.
 * The anchor is either the literal `'now'` (offset from the moment the profile
 * reaches the node) or a `{{...}}` token EXPRESSION (customer.* / event.* /
 * journey.*) that resolves to a timestamp at tick time — e.g. "1 day from
 * {{event.appointment_at}}". The resolved anchor + offset is pinned ONCE on first
 * arrival (so a later sweep doesn't recompute against a moving "now").
 */
export interface WaitOffset {
  readonly amount: number;
  readonly unit: WaitDurationUnit;
  readonly anchor: 'now' | string;
  /** Offset direction: 'after' (default) adds the duration to the anchor; 'before'
   *  subtracts it — e.g. "1 day BEFORE {{event.appointment_at}}" (reminder pattern). */
  readonly direction?: 'before' | 'after';
}

/** A maximum-wait cap: proceed to `next` anyway once this much time has elapsed
 *  since the profile reached the node (even if the condition is never met). */
export interface WaitMax {
  readonly amount: number;
  readonly unit: WaitDurationUnit;
}

/**
 * A wait node — defers the journey via next_run_at (§9B "waits").
 *
 * A SIMPLE wait (the "Wait N" palette node) uses `delay` only. A rich WAIT-UNTIL
 * node combines, in ONE node, any of: a TIME gate (`until` absolute OR
 * `untilOffset` relative), a segment-style CONDITION gate (`waitCondition`, the
 * §8 AstNode reused verbatim), and a `maxWait` cap. Semantics: PROCEED to `next`
 * when (time gate reached, if any) AND (condition true, if any) — OR when the
 * `maxWait` cap elapses (proceed-on-timeout, single output edge). A pending
 * condition is re-checked every sweep until met or capped.
 */
export interface WaitNode {
  readonly type: 'wait';
  /** Relative delay: either {seconds} or an ISO-8601 duration string. */
  readonly delay?: WaitDelaySeconds | string;
  /** Absolute wait: resume at this date (ISO-8601 string or Date). */
  readonly until?: string | Date;
  /** Relative time gate: `amount unit` from `now` or a {{timestamp}} expression. */
  readonly untilOffset?: WaitOffset;
  /** Condition gate — proceed only once the profile MATCHES this AST (§8). */
  readonly waitCondition?: AstNode;
  /** How the TIME and CONDITION gates combine (default 'and'). 'and' = both must
   *  hold; 'or' = either. Only meaningful when BOTH gates are present. The maxWait
   *  cap is ALWAYS an OR (proceed-on-timeout) regardless of this. */
  readonly combine?: 'and' | 'or';
  /** Max-wait cap — proceed anyway once elapsed (proceed-on-timeout). */
  readonly maxWait?: WaitMax;
  /** The node id to advance to once the wait elapses. */
  readonly next: string;
}

/** A condition (branch) node — routes via the §8 compiler (reuses AstNode). */
export interface ConditionNode {
  readonly type: 'condition';
  /** Optional human label for the branch (e.g. "VIP?"), shown on the canvas card.
   *  Purely cosmetic — never affects routing or validation. */
  readonly label?: string;
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
  readonly kind: 'send' | 'set_attribute' | 'set_journey';
  /**
   * For kind='send': the sending MEDIUM (CLAUDE.md multi-channel). Default 'email'
   * when absent (every legacy send is email). 'email' uses the template_id email
   * copy (envelope on the template); 'sms'/'whatsapp' send the recipient PHONE the
   * plain `text_body` via a ChannelProvider (no template, no verified-domain gate).
   */
  readonly medium?: Medium;
  /**
   * For kind='send' with an sms/whatsapp medium: the plain-text body (merge-tag
   * enabled — {{customer.*}} / {{event.*}} rendered at dispatch). REQUIRED (non-
   * blank) for a text send; ignored for email (which uses template_id).
   */
  readonly text_body?: string;
  /**
   * For kind='send' with a WhatsApp medium: an approved Meta message TEMPLATE (required
   * for business-initiated sends). `params` are merge-tag expressions mapped in order to
   * the template's {{1}},{{2}},… body placeholders. Present → a template send (text_body
   * optional); absent → a plain text_body send (24h window).
   */
  readonly wa_template?: { readonly name: string; readonly language: string; readonly params?: readonly string[] };
  /** For kind='send' (email): the email template to enqueue through the Dispatcher.
   * The envelope (subject / From / To) lives ON that template, not here. */
  readonly template_id?: string;
  /** For kind='send': the per-node TOPIC the dispatcher gates the send on. A
   *  recipient unsubscribed from this topic is skipped. Absent/null = no gate.
   *  (Post-0045: topic moved off the automation row onto the send node.) */
  readonly topic_id?: string;
  /** For kind='set_attribute' (SINGLE assignment, back-compat): the attribute key. */
  readonly key?: string;
  /**
   * For kind='set_attribute' (SINGLE assignment, back-compat): the value to set.
   * EITHER an explicit value spec ({@link ValueSpec}: a `literal` written verbatim,
   * an `expression` of {{customer.*}}/{{event.*}} tokens resolved at runner
   * execution, or a sandboxed `js` snippet evaluated NODE-side) OR — for back-compat
   * — a LEGACY BARE SCALAR (the original static value), treated as an implicit
   * literal. Resolution is read-only string substitution (never SQL).
   */
  readonly value?: ValueSpec | unknown;
  /**
   * For kind='set_attribute' (MULTIPLE assignments): a LIST of key/value pairs set
   * in ONE parameterized UPDATE (nested jsonb_set). When present and non-empty this
   * supersedes the single `key`/`value`. Each value is a {@link ValueSpec} (literal
   * | expression | js) or a legacy bare scalar, resolved per-value at runner time.
   */
  readonly assignments?: ReadonlyArray<{ readonly key: string; readonly value: unknown }>;
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
  /** Window start hour, integer 0–23 (inclusive). LEGACY — used when `startMin` absent. */
  readonly startHour: number;
  /** Window end hour, integer 0–23 (legacy inclusive-through-:59). Used when `endMin` absent. */
  readonly endHour: number;
  /** CANONICAL open minute-of-day (0–1439, INCLUSIVE) — supports half-hours (20:30 = 1230). */
  readonly startMin?: number;
  /** CANONICAL close minute-of-day (1–1440, EXCLUSIVE; 1440 = midnight). open>=close = overnight. */
  readonly endMin?: number;
  /** Optional allowed weekdays (0=Sun … 6=Sat); unique, non-empty when present. */
  readonly daysOfWeek?: readonly number[];
  /** The node id to advance to once inside (or after parking until) the window. */
  readonly next: string;
}

/** An exit node — terminal; the enrollment completes here. */
export interface ExitNode {
  readonly type: 'exit';
}

/** Any automation workflow node. */
export type Node =
  | TriggerNode
  | WaitNode
  | ConditionNode
  | ActionNode
  | WebhookAction
  | HourOfDayWindowNode
  | ExitNode;

/** A automation definition: a start node id + a node graph keyed by id (§9B). */
export interface AutomationDefinition {
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
 * Structurally validate a automation definition (§9B). THROWS on any malformed
 * graph so the runner never enrolls into garbage. Checks:
 *   - shape: object with a string startNode + a non-empty nodes map.
 *   - exactly ONE trigger node.
 *   - unique node ids (guaranteed by the map; the start id must resolve).
 *   - per-type required fields (trigger.kind/next, wait.next + delay|until,
 *     condition.ast/onTrue/onFalse, action.kind + send→(optional template_id; an
 *     unattached send is a valid DRAFT, the publish gate blocks activation) /
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
export function validateAutomationDefinition(def: unknown): asserts def is AutomationDefinition {
  if (typeof def !== 'object' || def === null) {
    throw new Error('validateAutomationDefinition: definition must be an object');
  }
  const d = def as { startNode?: unknown; nodes?: unknown };
  if (typeof d.startNode !== 'string' || d.startNode.length === 0) {
    throw new Error('validateAutomationDefinition: startNode must be a non-empty string');
  }
  if (typeof d.nodes !== 'object' || d.nodes === null) {
    throw new Error('validateAutomationDefinition: nodes must be an object map');
  }
  const nodes = d.nodes as Record<string, unknown>;
  const ids = Object.keys(nodes);
  if (ids.length === 0) {
    throw new Error('validateAutomationDefinition: nodes map must be non-empty');
  }

  // Validate each node shape + collect triggers.
  let triggerCount = 0;
  for (const id of ids) {
    const node = nodes[id];
    if (!isNodeObject(node)) {
      throw new Error(`validateAutomationDefinition: node "${id}" has an unknown/invalid type`);
    }
    if (node.type === 'trigger') triggerCount += 1;
    validateNodeFields(id, node, nodes);
  }
  if (triggerCount !== 1) {
    throw new Error(
      `validateAutomationDefinition: exactly one trigger node required (found ${triggerCount})`,
    );
  }

  // startNode must resolve.
  if (!Object.prototype.hasOwnProperty.call(nodes, d.startNode)) {
    throw new Error(`validateAutomationDefinition: startNode "${d.startNode}" is not a defined node`);
  }

  // No cycles / back-edges (the builder is a down-only auto-layout). A diamond /
  // re-convergence is fine — only a back-edge to a node on the current DFS stack
  // (or a self-loop) is a cycle. Run this BEFORE the reachable-exit check so a
  // looping graph is reported as a cycle (the precise diagnosis) rather than as a
  // generic "no exit".
  detectCycle(d.startNode, nodes as Record<string, Node>);

  // A reachable exit must exist (BFS from start).
  if (!hasReachableExit(d.startNode, nodes as Record<string, Node>)) {
    throw new Error('validateAutomationDefinition: no exit node is reachable from startNode');
  }

  // No orphans — every defined node must be reachable from startNode.
  const orphans = findOrphans(d.startNode, nodes as Record<string, Node>);
  if (orphans.length > 0) {
    throw new Error(
      `validateAutomationDefinition: node(s) not reachable from startNode (orphan): ${orphans.join(', ')}`,
    );
  }
}

/** Validate one node's required fields + that its edges resolve. */
function validateNodeFields(id: string, node: Node, nodes: Record<string, unknown>): void {
  const requireEdge = (target: unknown, label: string): void => {
    if (typeof target !== 'string' || target.length === 0) {
      throw new Error(`validateAutomationDefinition: node "${id}" ${label} must be a node id`);
    }
    if (!Object.prototype.hasOwnProperty.call(nodes, target)) {
      throw new Error(
        `validateAutomationDefinition: node "${id}" ${label} -> "${target}" is unresolvable`,
      );
    }
  };

  switch (node.type) {
    case 'trigger':
      if (
        node.kind !== 'segment_entry' &&
        node.kind !== 'event' &&
        node.kind !== 'profile' &&
        node.kind !== 'manual'
      ) {
        throw new Error(`validateAutomationDefinition: trigger "${id}" has an invalid kind`);
      }
      if (node.kind === 'profile') {
        // profileChange is OPTIONAL (defaults to 'any' at enroll time). When present
        // it MUST be one of created|updated|any.
        if (
          node.profileChange !== undefined &&
          node.profileChange !== 'created' &&
          node.profileChange !== 'updated' &&
          node.profileChange !== 'any'
        ) {
          throw new Error(
            `validateAutomationDefinition: profile trigger "${id}" profileChange must be created|updated|any`,
          );
        }
      }
      if (node.kind === 'event') {
        // An event trigger MUST name the event type; the optional payload filter is
        // a payload-only AstNode (structurally validated; the field whitelist is
        // enforced at enroll time by evaluateEventPayloadFilter).
        if (typeof node.eventType !== 'string' || node.eventType.length === 0) {
          throw new Error(`validateAutomationDefinition: event trigger "${id}" needs an eventType`);
        }
        if (node.filter !== undefined) {
          if (typeof node.filter !== 'object' || node.filter === null || Array.isArray(node.filter)) {
            throw new Error(`validateAutomationDefinition: event trigger "${id}" filter must be an AstNode object`);
          }
          validateAst(node.filter); // THROWS on a malformed AstNode shape
        }
      }
      requireEdge(node.next, 'next');
      return;
    case 'wait': {
      const hasDelay = node.delay !== undefined;
      const hasUntil = node.until !== undefined;
      const hasOffset = node.untilOffset !== undefined;
      const hasCondition = node.waitCondition !== undefined;
      const hasMax = node.maxWait !== undefined;
      if (!hasDelay && !hasUntil && !hasOffset && !hasCondition && !hasMax) {
        throw new Error(`validateAutomationDefinition: wait "${id}" needs a delay, until, untilOffset, waitCondition or maxWait`);
      }
      if (hasOffset) {
        validateWaitDuration(id, 'untilOffset', node.untilOffset!, true);
        const dir = node.untilOffset!.direction;
        if (dir !== undefined && dir !== 'before' && dir !== 'after') {
          throw new Error(`validateAutomationDefinition: wait "${id}" untilOffset.direction must be 'before' or 'after'`);
        }
      }
      if (hasMax) validateWaitDuration(id, 'maxWait', node.maxWait!, false);
      if (hasCondition && (typeof node.waitCondition !== 'object' || node.waitCondition === null)) {
        throw new Error(`validateAutomationDefinition: wait "${id}" waitCondition must be an AST object`);
      }
      if (node.combine !== undefined && node.combine !== 'and' && node.combine !== 'or') {
        throw new Error(`validateAutomationDefinition: wait "${id}" combine must be 'and' or 'or'`);
      }
      requireEdge(node.next, 'next');
      return;
    }
    case 'condition':
      if (typeof node.ast !== 'object' || node.ast === null) {
        throw new Error(`validateAutomationDefinition: condition "${id}" needs an ast`);
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
      if (kind !== 'send' && kind !== 'set_attribute' && kind !== 'set_journey') {
        throw new Error(`validateAutomationDefinition: action "${id}" has an invalid kind`);
      }
      const act = node as ActionNode;
      if (kind === 'send') {
        validateSendNode(id, act);
      }
      // set_journey shares set_attribute's keyed-assignments + value-spec shape;
      // the only difference is the WRITE TARGET (enrollment.state.journey).
      if (kind === 'set_attribute' || kind === 'set_journey') {
        validateSetAttributeNode(id, act);
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

/**
 * Validate a SEND action node (pure, §9B multi-channel). The `medium` is OPTIONAL
 * (defaults to 'email'); when present it MUST be a recognised medium. Per medium:
 *   - email: an UNATTACHED send (no template_id) is a valid DRAFT — the PUBLISH
 *     gate (collectSendNodeEnvelopeGaps) blocks activation until an envelope-
 *     complete email is attached. A present template_id must be a non-empty string.
 *   - sms/whatsapp: `text_body` is REQUIRED and must be a non-blank string (the
 *     plain message body; merge tags render at dispatch). template_id is ignored.
 */
function validateSendNode(id: string, act: ActionNode): void {
  if (act.medium !== undefined && !isMedium(act.medium)) {
    throw new Error(`validateAutomationDefinition: send action "${id}" has an invalid medium`);
  }
  const medium: Medium = act.medium ?? 'email';
  if (isTextMedium(medium)) {
    // WhatsApp may send an approved TEMPLATE (name + language) INSTEAD of a text body.
    if (medium === 'whatsapp' && act.wa_template !== undefined) {
      const t = act.wa_template;
      if (typeof t !== 'object' || t === null || typeof t.name !== 'string' || !t.name.trim() || typeof t.language !== 'string' || !t.language.trim()) {
        throw new Error(`validateAutomationDefinition: whatsapp send action "${id}" wa_template needs a name and language`);
      }
      return;
    }
    if (typeof act.text_body !== 'string' || act.text_body.trim().length === 0) {
      throw new Error(`validateAutomationDefinition: ${medium} send action "${id}" needs a non-blank text_body`);
    }
    return;
  }
  // email
  if (act.template_id !== undefined && (typeof act.template_id !== 'string' || !act.template_id)) {
    throw new Error(`validateAutomationDefinition: send action "${id}" template_id must be a non-empty string`);
  }
}

/**
 * Validate a set_attribute action's keyed assignments (pure, §9B update-profile). A
 * set_attribute is valid when it has EITHER a non-empty single `key` OR an
 * `assignments` array with ≥1 entry having a non-empty `key` (reject when neither).
 * Each present assignment's value spec is structurally validated. The list
 * supersedes the single key/value at runner time but the single form is still valid
 * (back-compat).
 */
function validateSetAttributeNode(id: string, act: ActionNode): void {
  const hasSingleKey = typeof act.key === 'string' && act.key.length > 0;
  const list = act.assignments;
  let hasListKey = false;
  if (list !== undefined) {
    if (!Array.isArray(list)) {
      throw new Error(`validateAutomationDefinition: set_attribute action "${id}" assignments must be an array`);
    }
    for (const a of list) {
      if (typeof a !== 'object' || a === null) {
        throw new Error(`validateAutomationDefinition: set_attribute action "${id}" assignment must be an object`);
      }
      const entry = a as { key?: unknown; value?: unknown };
      if (typeof entry.key === 'string' && entry.key.length > 0) {
        hasListKey = true;
        validateSetAttributeValue(id, entry.value);
      }
      // an entry with a blank key is dropped at runner time (and contributes no key)
    }
  }
  if (!hasSingleKey && !hasListKey) {
    throw new Error(`validateAutomationDefinition: set_attribute action "${id}" needs a key`);
  }
  if (hasSingleKey) validateSetAttributeValue(id, act.value);
}

/**
 * Validate a set_attribute action's VALUE spec (pure, §9B update-profile). The
 * value is OPTIONAL (absent → an implicit null literal). It may be:
 *   - a LEGACY BARE SCALAR (string/number/boolean/null) — the original static value,
 *     accepted as an implicit literal (back-compat);
 *   - an explicit { kind:'literal', value } — the `value` field MUST be present
 *     (distinguishes from a bare scalar that merely happens to be an object);
 *   - an explicit { kind:'expression', expression } — `expression` MUST be a
 *     non-empty string;
 *   - an explicit { kind:'js', code } — `code` MUST be a string (NO eval at
 *     validate time; the runner evaluates it NODE-side in a sandbox).
 * Any other spec-object shape (an unknown `kind`, or an object without a `kind`)
 * is rejected. Resolution itself is read-only string substitution at runner time
 * (never SQL); this only checks the STRUCTURE.
 */
function validateSetAttributeValue(id: string, value: unknown): void {
  if (value === undefined) return; // absent → implicit null literal
  // An explicit spec object carries a `kind`.
  if (typeof value === 'object' && value !== null && !Array.isArray(value) && 'kind' in value) {
    if (isExpressionSpec(value)) {
      if (typeof value.expression !== 'string' || value.expression.length === 0) {
        throw new Error(
          `validateAutomationDefinition: set_attribute "${id}" expression value needs a non-empty expression`,
        );
      }
      return;
    }
    if (isLiteralSpec(value)) {
      if (!('value' in value)) {
        throw new Error(
          `validateAutomationDefinition: set_attribute "${id}" literal value spec needs a value field`,
        );
      }
      return;
    }
    if ((value as { kind?: unknown }).kind === 'js') {
      // A js spec is valid IFF code is a string (no eval at validate time; the
      // runner evaluates it NODE-side in a sandbox that can never reach the host).
      if (!isJsSpec(value)) {
        throw new Error(
          `validateAutomationDefinition: set_attribute "${id}" js value spec needs a string code`,
        );
      }
      return;
    }
    throw new Error(
      `validateAutomationDefinition: set_attribute "${id}" value has an unknown spec kind "${String((value as { kind?: unknown }).kind)}"`,
    );
  }
  // A bare scalar (or an array/object WITHOUT a kind) — accepted as a legacy literal.
}

/** Validate a webhook action's fields (model-layer; runner exec is phase 2). */
function validateWebhookFields(id: string, node: WebhookAction): void {
  // url — http(s) ONLY (SSRF pre-check; full allowlist enforcement is phase 2).
  if (typeof node.url !== 'string' || node.url.length === 0) {
    throw new Error(`validateAutomationDefinition: webhook "${id}" needs a url`);
  }
  let parsed: URL;
  try {
    parsed = new URL(node.url);
  } catch {
    throw new Error(`validateAutomationDefinition: webhook "${id}" url is not a valid url`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`validateAutomationDefinition: webhook "${id}" url must use the http(s) scheme`);
  }
  if (typeof node.method !== 'string' || !WEBHOOK_METHODS.has(node.method as WebhookMethod)) {
    throw new Error(
      `validateAutomationDefinition: webhook "${id}" method must be one of ${[...WEBHOOK_METHODS].join('/')}`,
    );
  }
  if (node.headers !== undefined && (typeof node.headers !== 'object' || node.headers === null || Array.isArray(node.headers))) {
    throw new Error(`validateAutomationDefinition: webhook "${id}" headers must be an object`);
  }
  if (node.bodyTemplate !== undefined && typeof node.bodyTemplate !== 'string') {
    throw new Error(`validateAutomationDefinition: webhook "${id}" bodyTemplate must be a string`);
  }
  if (node.timeoutMs !== undefined && (typeof node.timeoutMs !== 'number' || !(node.timeoutMs > 0))) {
    throw new Error(`validateAutomationDefinition: webhook "${id}" timeoutMs must be a positive number`);
  }
  if (
    node.maxRetries !== undefined &&
    (typeof node.maxRetries !== 'number' || !Number.isInteger(node.maxRetries) || node.maxRetries < 0)
  ) {
    throw new Error(`validateAutomationDefinition: webhook "${id}" maxRetries must be a non-negative integer`);
  }
}

/** Validate an hour_of_day_window node's fields (runner interprets later). */
function validateHourWindowFields(id: string, node: HourOfDayWindowNode): void {
  const isHour = (h: unknown): boolean => typeof h === 'number' && Number.isInteger(h) && h >= 0 && h <= 23;
  if (node.startHour === undefined || node.endHour === undefined) {
    throw new Error(`validateAutomationDefinition: hour window "${id}" needs startHour and endHour`);
  }
  if (!isHour(node.startHour) || !isHour(node.endHour)) {
    throw new Error(`validateAutomationDefinition: hour window "${id}" hours must be integers 0–23`);
  }
  // startHour > endHour is a VALID overnight wrap-around (semantics resolved in the runner).
  // CANONICAL minute-of-day fields (optional, support half-hours): open 0–1439 inclusive,
  // close 1–1440 exclusive (1440 = midnight). open>=close is a valid overnight/24h window.
  const n = node as { startMin?: unknown; endMin?: unknown };
  if (n.startMin !== undefined) {
    if (typeof n.startMin !== 'number' || !Number.isInteger(n.startMin) || n.startMin < 0 || n.startMin > 1439) {
      throw new Error(`validateAutomationDefinition: hour window "${id}" startMin must be an integer 0–1439`);
    }
  }
  if (n.endMin !== undefined) {
    if (typeof n.endMin !== 'number' || !Number.isInteger(n.endMin) || n.endMin < 1 || n.endMin > 1440) {
      throw new Error(`validateAutomationDefinition: hour window "${id}" endMin must be an integer 1–1440`);
    }
  }
  if (node.daysOfWeek !== undefined) {
    const d = node.daysOfWeek;
    if (!Array.isArray(d) || d.length === 0) {
      throw new Error(`validateAutomationDefinition: hour window "${id}" daysOfWeek must be a non-empty array`);
    }
    const seen = new Set<number>();
    for (const day of d) {
      if (typeof day !== 'number' || !Number.isInteger(day) || day < 0 || day > 6) {
        throw new Error(`validateAutomationDefinition: hour window "${id}" daysOfWeek values must be integers 0–6`);
      }
      if (seen.has(day)) {
        throw new Error(`validateAutomationDefinition: hour window "${id}" daysOfWeek has a duplicate day`);
      }
      seen.add(day);
    }
  }
}

/** Outgoing edge targets of a node (for reachability). */
/** Whitelisted wait duration units (also used to build SQL-free interval math). */
export const WAIT_DURATION_UNITS = new Set<WaitDurationUnit>(['minutes', 'hours', 'days']);

/** Validate a {amount, unit, anchor?} duration on a wait node. */
function validateWaitDuration(
  id: string,
  field: 'untilOffset' | 'maxWait',
  d: { amount?: unknown; unit?: unknown; anchor?: unknown },
  requireAnchor: boolean,
): void {
  if (typeof d.amount !== 'number' || !Number.isFinite(d.amount) || d.amount <= 0) {
    throw new Error(`validateAutomationDefinition: wait "${id}" ${field}.amount must be a positive number`);
  }
  if (typeof d.unit !== 'string' || !WAIT_DURATION_UNITS.has(d.unit as WaitDurationUnit)) {
    throw new Error(`validateAutomationDefinition: wait "${id}" ${field}.unit must be minutes|hours|days`);
  }
  if (requireAnchor && (typeof d.anchor !== 'string' || d.anchor.length === 0)) {
    throw new Error(`validateAutomationDefinition: wait "${id}" ${field}.anchor must be 'now' or a {{timestamp}} expression`);
  }
}

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
            `validateAutomationDefinition: cycle detected (back-edge "${id}" -> "${t}"); the graph must be acyclic`,
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

/** The envelope columns of a send node's email copy (the publish-gate input). */
export interface SendNodeEnvelope {
  readonly sender_id: string | null;
  readonly to_address: string | null;
  readonly subject: string | null;
}

/** A per-send-node publish gap: which field is missing (first only). For an EMAIL
 *  send it is one of sender/to/subject (sendBroadcast order); for a TEXT send
 *  (sms/whatsapp) it is 'body' (a blank text_body). */
export interface SendNodeEnvelopeGap {
  readonly nodeId: string;
  /** The single highest-priority missing field. */
  readonly missing: 'sender' | 'to' | 'subject' | 'body';
}

/**
 * Walk a automation definition's SEND nodes and yield, per node, its FIRST missing
 * envelope field in sendBroadcast's ORDERED priority (sender_id → to_address →
 * subject). `envelopes` maps a send node's template_id (its email copy id) to the
 * copy's envelope columns; a send node with no copy (or a missing entry) reports
 * 'sender' (nothing is configured yet). Pure — the publish gate runs the DB read
 * and feeds this; the gate uses the FIRST gap (front of the list) for its message.
 * Nodes are visited in the definition's reachable order (BFS from startNode) so the
 * "which node" reported is stable.
 */
export function collectSendNodeEnvelopeGaps(
  def: AutomationDefinition,
  envelopes: Readonly<Record<string, SendNodeEnvelope | undefined>>,
): SendNodeEnvelopeGap[] {
  const gaps: SendNodeEnvelopeGap[] = [];
  const seen = new Set<string>();
  const queue: string[] = [def.startNode];
  while (queue.length > 0) {
    const id = queue.shift() as string;
    if (seen.has(id)) continue;
    seen.add(id);
    const node = def.nodes[id];
    if (!node) continue;
    if (node.type === 'action' && (node as ActionNode).kind === 'send') {
      const act = node as ActionNode;
      const medium: Medium = act.medium ?? 'email';
      if (isTextMedium(medium)) {
        // A TEXT send (sms/whatsapp) is gated ONLY on a non-blank body — the email
        // envelope (From/To/Subject) + verified-domain gate are email-only. A WhatsApp
        // send with an approved TEMPLATE (name+language) satisfies the gate WITHOUT a body.
        const hasWaTemplate =
          medium === 'whatsapp' &&
          typeof act.wa_template === 'object' &&
          act.wa_template !== null &&
          typeof act.wa_template.name === 'string' &&
          act.wa_template.name.trim().length > 0;
        if (!hasWaTemplate && (typeof act.text_body !== 'string' || act.text_body.trim().length === 0)) {
          gaps.push({ nodeId: id, missing: 'body' });
        }
      } else {
        const env = act.template_id ? envelopes[act.template_id] : undefined;
        const missing = firstEnvelopeGap(env);
        if (missing) gaps.push({ nodeId: id, missing });
      }
    }
    for (const t of edgesOf(node)) queue.push(t);
  }
  return gaps;
}

/** The first missing envelope field, in sendBroadcast order (or null when complete). */
function firstEnvelopeGap(env: SendNodeEnvelope | undefined): SendNodeEnvelopeGap['missing'] | null {
  if (!env || !env.sender_id) return 'sender';
  if (!env.to_address || !env.to_address.trim()) return 'to';
  if (!env.subject || !env.subject.trim()) return 'subject';
  return null;
}

/** Resolve the start node from a (validated) definition. THROWS if missing. */
export function resolveStartNode(def: AutomationDefinition): Node {
  const node = def.nodes[def.startNode];
  if (!node) {
    throw new Error(`resolveStartNode: startNode "${def.startNode}" not found`);
  }
  return node;
}

/** Find a node by id. THROWS if the id is not defined (an unresolvable edge). */
export function findNode(def: AutomationDefinition, id: string): Node {
  const node = def.nodes[id];
  if (!node) {
    throw new Error(`findNode: node "${id}" not found`);
  }
  return node;
}
