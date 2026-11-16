// Automation EXIT RULES — the runtime half: pure decisions, SQL builders, and the
// orchestrator that applies them to a person's ACTIVE enrollments.
//
// Where rules are evaluated (every path funnels through applyExitRules):
//   - an ingested event        → enrollFromEvent      (event rules + profile_match)
//   - a segment enter / leave  → enrollFromSegmentChange (segment rules)
//   - a profile create/update  → enrollFromProfileChange (profile_match)
//   - every runner tick        → run.ts               (profile_match, so time-based
//                                                       features are caught too)
//
// Semantics (decided once, here):
//   - Rules use the LIVE definition: a rule edited in a draft does nothing until
//     it is published.
//   - Rules apply to enrollments of ACTIVE and PAUSED automations (leaving or
//     restarting is safe while paused — a restarted enrollment stays parked at the
//     start until resume). Archived/draft automations are left alone.
//   - EXIT beats RESTART when both fire on the same signal.
//   - Rules run BEFORE enrollment in the same call, so the event that ENROLLS a
//     person never immediately exits/restarts that fresh enrollment.
//   - profile_match + exit is LEVEL-triggered (already matching → exits on the first
//     check). profile_match + restart is EDGE-triggered (a latch per rule on
//     state.exit_latch): it fires only on an observed false→true change, otherwise a
//     still-true condition would restart the journey on every tick forever.
//   - Exit/restart cancels the enrollment's still-PENDING outbox rows (a deferred
//     "you forgot your cart" mail must not go out after they bought). A row already
//     being sent ('sending') is left to finish.
//   - Restart: back to the start node, journey vars + wait pins cleared, the
//     triggering event (if any) becomes the new {{event.*}}, `restarts` + 1 (which
//     makes every send/webhook dedupe key new — see buildAutomationDedupeKey).
//     Capped at MAX_RESTARTS so a chatty producer cannot spam someone forever.
import { buildBranchMatchQuery, rewriteTriggerEventLeaves, rewriteJourneyLeaves } from './core.js';
import { evaluateEventPayloadFilter, type SqlStatement } from './core.js';
import { describeExitRule, eventTypesOf, exitRulesOf, UNSUBSCRIBED_EXIT_RULE, type ExitRule } from './exit-rules-dsl.js';
import type { AstNode } from '@cdp/segments';

/** Most restarts one enrollment may take (runaway guard). */
export const MAX_RESTARTS = 100;

/** What happened that rules may react to. */
export type ExitSignal =
  | {
      readonly kind: 'event';
      readonly type: string;
      readonly payload: Record<string, unknown>;
      readonly eventId: string;
    }
  | { readonly kind: 'segment'; readonly segmentId: string; readonly action: 'entered' | 'exited' }
  | { readonly kind: 'profile' }
  | { readonly kind: 'tick' };

/** Per-rule latch for edge-triggered profile_match restarts. */
export type ExitLatches = Readonly<Record<string, boolean>>;

/** The decision for one enrollment. */
export interface ExitDecision {
  readonly action: 'exit' | 'restart' | null;
  readonly rule: ExitRule | null;
  /** The latch map to persist (null = unchanged). */
  readonly latches: ExitLatches | null;
}

// ---------------------------------------------------------------------------
// Pure decisions
// ---------------------------------------------------------------------------

/** Does a NON-profile rule fire on this signal? (profile_match is decided separately.) */
export function ruleFiresOnSignal(rule: ExitRule, signal: ExitSignal): boolean {
  const w = rule.when;
  switch (w.kind) {
    case 'event':
      if (signal.kind !== 'event' || !eventTypesOf(w).includes(signal.type)) return false;
      if (!w.filter) return true;
      try {
        return evaluateEventPayloadFilter(w.filter, signal.payload);
      } catch {
        return false; // a filter that cannot be evaluated never fires
      }
    case 'segment_exit':
      return signal.kind === 'segment' && signal.action === 'exited' && signal.segmentId === w.segmentId;
    case 'segment_entry':
      return signal.kind === 'segment' && signal.action === 'entered' && signal.segmentId === w.segmentId;
    case 'profile_match':
      return false;
  }
}

/** Does this signal warrant evaluating profile_match rules? */
export function signalChecksProfile(signal: ExitSignal): boolean {
  return signal.kind === 'event' || signal.kind === 'profile' || signal.kind === 'tick';
}

/**
 * Decide a profile_match rule given whether the person matches NOW and the
 * rule's previous latch. exit = level (fires whenever matching); restart = edge
 * (fires only on a seen false→true; an unknown previous value just records).
 */
export function decideProfileMatch(
  rule: ExitRule,
  matchesNow: boolean,
  prevLatch: boolean | undefined,
): { fire: boolean; latch: boolean } {
  if (rule.action === 'exit') return { fire: matchesNow, latch: matchesNow };
  return { fire: prevLatch === false && matchesNow, latch: matchesNow };
}

/**
 * Combine fired rules into one decision. EXIT wins over RESTART; among equals the
 * first rule (definition order) is reported. A restart past MAX_RESTARTS is dropped.
 */
export function resolveExitDecision(
  fired: readonly ExitRule[],
  restarts: number,
  latches: ExitLatches | null,
): ExitDecision {
  const exit = fired.find((r) => r.action === 'exit');
  if (exit) return { action: 'exit', rule: exit, latches };
  const restart = fired.find((r) => r.action === 'restart');
  if (restart && restarts < MAX_RESTARTS) return { action: 'restart', rule: restart, latches };
  return { action: null, rule: null, latches };
}

/** Do two latch maps differ? (only write when they do) */
function latchesChanged(a: ExitLatches, b: ExitLatches): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) if (a[k] !== b[k]) return true;
  return false;
}

// ---------------------------------------------------------------------------
// SQL builders (workspace_id always at $1)
// ---------------------------------------------------------------------------

/** End an ACTIVE enrollment early with a reason. Idempotent (status guard). */
export function buildExitEnrollment(workspaceId: string, enrollmentId: string, reason: string): SqlStatement {
  if (!workspaceId) throw new Error('buildExitEnrollment: workspaceId is required');
  return {
    text: `UPDATE automation_enrollments
              SET status = 'exited', exit_reason = $3, next_run_at = NULL, updated_at = clock_timestamp()
            WHERE workspace_id = $1 AND id = $2 AND status = 'active'`,
    values: [workspaceId, enrollmentId, reason],
  };
}

/**
 * Send an ACTIVE enrollment back to its start node: journey vars + wait pins are
 * cleared, the event is replaced when `event` is given (else kept), the latches
 * are kept (so an edge-triggered rule does not instantly re-fire), restarts + 1.
 */
export function buildRestartEnrollment(
  workspaceId: string,
  enrollmentId: string,
  startNode: string,
  event: { type: string; payload: Record<string, unknown>; event_id: string } | null,
  latches: ExitLatches | null,
): SqlStatement {
  if (!workspaceId) throw new Error('buildRestartEnrollment: workspaceId is required');
  return {
    text: `UPDATE automation_enrollments
              SET current_node = $3,
                  next_run_at = now(),
                  restarts = restarts + 1,
                  exit_reason = NULL,
                  state = jsonb_strip_nulls(jsonb_build_object(
                    'event', COALESCE($4::jsonb, state->'event'),
                    'exit_latch', COALESCE($5::jsonb, state->'exit_latch'))),
                  updated_at = clock_timestamp()
            WHERE workspace_id = $1 AND id = $2 AND status = 'active' AND restarts < $6`,
    values: [
      workspaceId,
      enrollmentId,
      startNode,
      event ? JSON.stringify(event) : null,
      latches ? JSON.stringify(latches) : null,
      MAX_RESTARTS,
    ],
  };
}

/**
 * Persist the profile_match latches WITHOUT touching updated_at — the runner's
 * guarded advance compares updated_at, and a latch write inside the same tick must
 * not invalidate it.
 */
export function buildExitLatchUpdate(workspaceId: string, enrollmentId: string, latches: ExitLatches): SqlStatement {
  if (!workspaceId) throw new Error('buildExitLatchUpdate: workspaceId is required');
  return {
    text: `UPDATE automation_enrollments
              SET state = jsonb_set(COALESCE(state, '{}'::jsonb), '{exit_latch}', $3::jsonb, true)
            WHERE workspace_id = $1 AND id = $2 AND status = 'active'`,
    values: [workspaceId, enrollmentId, JSON.stringify(latches)],
  };
}

/** Cancel this enrollment's still-pending automation sends. */
export function buildCancelPendingAutomationOutbox(
  workspaceId: string,
  automationId: string,
  profileId: string,
  reason: string,
): SqlStatement {
  if (!workspaceId) throw new Error('buildCancelPendingAutomationOutbox: workspaceId is required');
  return {
    text: `UPDATE outbox SET status = 'cancelled', last_error = $4
            WHERE workspace_id = $1 AND automation_id = $2 AND profile_id = $3 AND status = 'pending'`,
    values: [workspaceId, automationId, profileId, reason],
  };
}

/** One journey-log line for the activity feed. */
export function buildExitActivityInsert(
  workspaceId: string,
  profileId: string,
  action: 'exit' | 'restart',
  detail: string,
): SqlStatement {
  if (!workspaceId) throw new Error('buildExitActivityInsert: workspaceId is required');
  return {
    text: `INSERT INTO activity_log (workspace_id, profile_id, source, type, outcome, detail)
           VALUES ($1, $2, 'automation', $3, 'info', $4)`,
    values: [workspaceId, profileId, action === 'exit' ? 'automation_exited' : 'automation_restarted', detail],
  };
}

/** The statements that carry out a decision (empty for "no action, no latch change"). */
export function buildDecisionStatements(
  workspaceId: string,
  e: ActiveEnrollment,
  decision: ExitDecision,
  signal: ExitSignal,
): SqlStatement[] {
  const out: SqlStatement[] = [];
  if (decision.action && decision.rule) {
    const why = describeExitRule(decision.rule);
    const name = e.automation_name ? `"${e.automation_name}"` : 'automation';
    if (decision.action === 'exit') {
      out.push(buildCancelPendingAutomationOutbox(workspaceId, e.automation_id, e.profile_id, `exited automation: ${why}`));
      out.push(buildExitEnrollment(workspaceId, e.id, `Exit rule: ${why}`));
      out.push(buildExitActivityInsert(workspaceId, e.profile_id, 'exit', `Left ${name} — ${why}`));
    } else {
      const event =
        signal.kind === 'event' ? { type: signal.type, payload: signal.payload, event_id: signal.eventId } : null;
      out.push(buildCancelPendingAutomationOutbox(workspaceId, e.automation_id, e.profile_id, `automation restarted: ${why}`));
      out.push(buildRestartEnrollment(workspaceId, e.id, e.start_node, event, decision.latches));
      out.push(buildExitActivityInsert(workspaceId, e.profile_id, 'restart', `Restarted ${name} — ${why}`));
    }
  } else if (decision.latches) {
    out.push(buildExitLatchUpdate(workspaceId, e.id, decision.latches));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

export interface ExitReader {
  query<T = Record<string, unknown>>(text: string, values?: readonly unknown[]): Promise<{ rows: T[] }>;
}

/** An active enrollment + what rule evaluation needs from its automation. */
export interface ActiveEnrollment {
  readonly id: string;
  readonly automation_id: string;
  readonly automation_name?: string | null;
  readonly profile_id: string;
  readonly restarts: number;
  readonly start_node: string;
  readonly rules: readonly ExitRule[];
  readonly state: {
    event?: { payload?: Record<string, unknown> };
    journey?: Record<string, unknown>;
    exit_latch?: Record<string, boolean>;
  } | null;
}

/**
 * Evaluate one enrollment's rules against a signal. Reads (profile_match SQL) go
 * through `read`; returns the decision. Never throws for a bad rule — a rule that
 * cannot be evaluated simply does not fire.
 */
export async function decideForEnrollment(
  read: ExitReader,
  workspaceId: string,
  e: ActiveEnrollment,
  signal: ExitSignal,
): Promise<ExitDecision> {
  const fired: ExitRule[] = [];
  const prev: ExitLatches = e.state?.exit_latch ?? {};
  const next: Record<string, boolean> = { ...prev };
  for (const rule of e.rules) {
    if (rule.when.kind !== 'profile_match') {
      if (ruleFiresOnSignal(rule, signal)) fired.push(rule);
      continue;
    }
    if (!signalChecksProfile(signal)) continue;
    let matches: boolean;
    try {
      let ast: AstNode = rewriteTriggerEventLeaves(rule.when.ast, e.state?.event?.payload ?? null);
      ast = rewriteJourneyLeaves(ast, e.state?.journey ?? null);
      const q = buildBranchMatchQuery(workspaceId, ast, e.profile_id);
      const { rows } = await read.query(q.text, q.values);
      matches = rows.length > 0;
    } catch {
      continue; // unevaluable → never fires, latch untouched
    }
    const d = decideProfileMatch(rule, matches, prev[rule.id]);
    next[rule.id] = d.latch;
    if (d.fire) fired.push(rule);
  }
  // Only restart rules need a latch; keep exit-rule entries out of the map.
  const restartIds = new Set(e.rules.filter((r) => r.action === 'restart').map((r) => r.id));
  const kept: Record<string, boolean> = {};
  for (const [k, v] of Object.entries(next)) if (restartIds.has(k)) kept[k] = v;
  const latches = latchesChanged(prev, kept) ? kept : null;
  return resolveExitDecision(fired, e.restarts, latches);
}

interface ActiveRow {
  id: string;
  automation_id: string;
  automation_name: string | null;
  profile_id: string;
  restarts: number | null;
  state: ActiveEnrollment['state'];
  definition: unknown;
}

/** Load a person's active enrollments in automations that HAVE exit rules. */
export async function loadActiveEnrollmentsWithRules(
  read: ExitReader,
  workspaceId: string,
  profileId: string,
): Promise<ActiveEnrollment[]> {
  const { rows } = await read.query<ActiveRow>(
    `SELECT e.id, e.automation_id, a.name AS automation_name, e.profile_id, e.restarts, e.state, a.definition
       FROM automation_enrollments e
       JOIN automations a ON a.id = e.automation_id AND a.workspace_id = e.workspace_id
      WHERE e.workspace_id = $1 AND e.profile_id = $2 AND e.status = 'active'
        AND a.status IN ('active', 'paused')
        AND jsonb_typeof(a.definition->'exitRules') = 'array'
        AND jsonb_array_length(a.definition->'exitRules') > 0`,
    [workspaceId, profileId],
  );
  const out: ActiveEnrollment[] = [];
  for (const r of rows) {
    const def = r.definition as { startNode?: unknown } | null;
    if (!def || typeof def.startNode !== 'string') continue;
    out.push({
      id: r.id,
      automation_id: r.automation_id,
      automation_name: r.automation_name,
      profile_id: r.profile_id,
      restarts: r.restarts ?? 0,
      start_node: def.startNode,
      rules: exitRulesOf(def),
      state: r.state,
    });
  }
  return out;
}

export interface ApplyExitRulesResult {
  readonly exited: number;
  readonly restarted: number;
  /** Statements to run in the caller's workspace tx, BEFORE any enrollment insert. */
  readonly statements: SqlStatement[];
}

/**
 * Evaluate every active, rule-carrying enrollment of a person against a signal and
 * return the statements that carry out the decisions. Does not write — the caller
 * runs the statements in its own workspace-scoped tx (so a rule and an enrollment
 * driven by the same event commit together).
 */
export async function applyExitRules(
  read: ExitReader,
  workspaceId: string,
  profileId: string,
  signal: ExitSignal,
): Promise<ApplyExitRulesResult> {
  if (!workspaceId) throw new Error('applyExitRules: workspaceId is required');
  const active = await loadActiveEnrollmentsWithRules(read, workspaceId, profileId);
  let exited = 0;
  let restarted = 0;
  const statements: SqlStatement[] = [];
  for (const e of active) {
    const d = await decideForEnrollment(read, workspaceId, e, signal);
    if (d.action === 'exit') exited += 1;
    if (d.action === 'restart') restarted += 1;
    statements.push(...buildDecisionStatements(workspaceId, e, d, signal));
  }
  return { exited, restarted, statements };
}

/**
 * The runner-tick check: evaluate the enrollment's profile_match rules (only —
 * events and segment changes are handled where they happen). Returns no
 * statements and runs no query when the automation has no profile_match rule.
 */
export async function evaluateTickExitRules(
  read: ExitReader,
  workspaceId: string,
  definition: { startNode: string; exitRules?: readonly ExitRule[] },
  row: {
    id: string;
    automation_id: string;
    profile_id: string;
    restarts?: number | null;
    state?: ActiveEnrollment['state'] | undefined;
  },
  automationName: string | null,
): Promise<{ decision: ExitDecision; statements: SqlStatement[] }> {
  // The automation's own rules, plus the built-in "unsubscribed → exit".
  const rules = [...exitRulesOf(definition), UNSUBSCRIBED_EXIT_RULE];
  const e: ActiveEnrollment = {
    id: row.id,
    automation_id: row.automation_id,
    automation_name: automationName,
    profile_id: row.profile_id,
    restarts: row.restarts ?? 0,
    start_node: definition.startNode,
    rules,
    state: row.state ?? null,
  };
  const signal: ExitSignal = { kind: 'tick' };
  const decision = await decideForEnrollment(read, workspaceId, e, signal);
  return { decision, statements: buildDecisionStatements(workspaceId, e, decision, signal) };
}
