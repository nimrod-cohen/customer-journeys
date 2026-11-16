// Automation EXIT RULES (§9B extension) — the DSL half: types + structural
// validation. Pure, no I/O, and deliberately free of runner imports so dsl.ts can
// call validateExitRules without an import cycle.
//
// An exit rule watches for something that happens WHILE a person is enrolled and
// either takes them out of the automation ('exit') or sends them back to the start
// ('restart'). Rules live in the definition JSON (`definition.exitRules`) so they
// are drafted, published and versioned together with the graph.
import { validateAst, type AstNode } from '@cdp/segments';

/** What a fired rule does to the enrollment. */
export type ExitRuleAction = 'exit' | 'restart';

/** What a rule watches for. */
export type ExitRuleWhen =
  /** An event of `eventType` (optionally matching a payload.* filter) is received. */
  | { readonly kind: 'event'; readonly eventType: string; readonly filter?: AstNode }
  /** The person leaves the segment. */
  | { readonly kind: 'segment_exit'; readonly segmentId: string }
  /** The person enters the segment. */
  | { readonly kind: 'segment_entry'; readonly segmentId: string }
  /** The person matches a profile condition (the same §8 AST the IF node uses). */
  | { readonly kind: 'profile_match'; readonly ast: AstNode };

export interface ExitRule {
  /** Stable id — keys the profile_match latch on the enrollment state. */
  readonly id: string;
  /** Optional human label, shown in the journey log. Never affects behavior. */
  readonly label?: string;
  readonly when: ExitRuleWhen;
  readonly action: ExitRuleAction;
}

/** Upper bound on rules per automation (each one costs work on every event). */
export const MAX_EXIT_RULES = 20;

const WHEN_KINDS = new Set(['event', 'segment_exit', 'segment_entry', 'profile_match']);

function fail(msg: string): never {
  throw new Error(`validateAutomationDefinition: ${msg}`);
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Structurally validate `definition.exitRules`. Absent is valid (no rules). THROWS
 * (with the same "validateAutomationDefinition:" prefix as the graph checks) on
 * any malformed rule so a bad rule is a typed 400 at draft-save, never a runtime
 * surprise.
 */
export function validateExitRules(rules: unknown): void {
  if (rules === undefined) return;
  if (!Array.isArray(rules)) fail('exitRules must be an array');
  if (rules.length > MAX_EXIT_RULES) fail(`at most ${MAX_EXIT_RULES} exit rules are allowed`);
  const ids = new Set<string>();
  rules.forEach((r, i) => {
    const where = `exit rule #${i + 1}`;
    if (!isObject(r)) fail(`${where} must be an object`);
    if (typeof r.id !== 'string' || r.id.trim() === '') fail(`${where} needs an id`);
    if (ids.has(r.id)) fail(`${where} id "${r.id}" is duplicated`);
    ids.add(r.id);
    if (r.label !== undefined && typeof r.label !== 'string') fail(`${where} label must be a string`);
    if (r.action !== 'exit' && r.action !== 'restart') fail(`${where} action must be exit or restart`);
    const w = r.when;
    if (!isObject(w) || typeof w.kind !== 'string' || !WHEN_KINDS.has(w.kind)) {
      fail(`${where} needs a valid "when" (event | segment_exit | segment_entry | profile_match)`);
    }
    switch (w.kind) {
      case 'event':
        if (typeof w.eventType !== 'string' || w.eventType.trim() === '') fail(`${where} needs an event type`);
        if (w.filter !== undefined) {
          if (!isObject(w.filter)) fail(`${where} filter must be a rule object`);
          validateAst(w.filter as unknown as AstNode);
        }
        return;
      case 'segment_exit':
      case 'segment_entry':
        if (typeof w.segmentId !== 'string' || w.segmentId === '') fail(`${where} needs a segment`);
        return;
      case 'profile_match':
        if (!isObject(w.ast)) fail(`${where} needs a condition`);
        validateAst(w.ast as unknown as AstNode);
        return;
    }
  });
}

/** The exit rules of a (validated) definition — [] when there are none. */
export function exitRulesOf(def: unknown): readonly ExitRule[] {
  const rules = isObject(def) ? def.exitRules : undefined;
  return Array.isArray(rules) ? (rules as ExitRule[]) : [];
}

/** Every segment id the rules reference (for the cross-workspace check, inv.2). */
export function exitRuleSegmentIds(rules: readonly ExitRule[]): string[] {
  const out = new Set<string>();
  for (const r of rules) {
    if (r.when.kind === 'segment_exit' || r.when.kind === 'segment_entry') out.add(r.when.segmentId);
  }
  return [...out];
}

/** A short human description of a rule, for the journey log / exit reason. */
export function describeExitRule(rule: ExitRule): string {
  if (rule.label && rule.label.trim()) return rule.label.trim();
  switch (rule.when.kind) {
    case 'event':
      return `event "${rule.when.eventType}"`;
    case 'segment_exit':
      return 'left a segment';
    case 'segment_entry':
      return 'entered a segment';
    case 'profile_match':
      return 'profile matched a condition';
  }
}
