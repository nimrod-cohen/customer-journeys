// Exit rules — the editor form ↔ DSL bridge (pure, unit-tested). The DSL shape
// mirrors @cdp/service-automation-runner's exit-rules-dsl.ts; the server
// re-validates every saved rule.
import type { AstNode, RuleGroup } from '../segments/ast-builder.js';
import {
  conditionAstToRows,
  editorRowsToConditionAst,
  readEventPayloadFilter,
  writeEventPayloadFilter,
  type EventFilterForm,
} from './node-config.js';

export type ExitWhenKind = 'event' | 'segment_exit' | 'segment_entry' | 'profile_match';
export type ExitAction = 'exit' | 'restart';

/** A stored rule (DSL). */
export interface ExitRuleDsl {
  id: string;
  label?: string;
  action: ExitAction;
  when:
    | { kind: 'event'; eventType: string; filter?: AstNode }
    | { kind: 'segment_exit' | 'segment_entry'; segmentId: string }
    | { kind: 'profile_match'; ast: AstNode };
}

/** One rule as the editor holds it — every kind's fields, so switching kind keeps input. */
export interface ExitRuleForm {
  id: string;
  label: string;
  action: ExitAction;
  kind: ExitWhenKind;
  eventType: string;
  filter: EventFilterForm;
  segmentId: string;
  condition: RuleGroup;
}

let counter = 0;
/** A fresh, unique-enough rule id (only needs to be unique within one automation). */
export function newExitRuleId(): string {
  counter += 1;
  return `rule_${Date.now().toString(36)}${counter.toString(36)}`;
}

export function blankExitRule(): ExitRuleForm {
  return {
    id: newExitRuleId(),
    label: '',
    action: 'exit',
    kind: 'event',
    eventType: '',
    filter: readEventPayloadFilter(null),
    segmentId: '',
    // Start with NO condition rows (a blank row would default to a real field and
    // silently save "tier = ''").
    condition: { combinator: 'and', rows: [], groups: [] },
  };
}

export function readExitRules(rules: readonly ExitRuleDsl[] | undefined | null): ExitRuleForm[] {
  return (rules ?? []).map((r) => {
    const f = { ...blankExitRule(), id: r.id, label: r.label ?? '', action: r.action, kind: r.when.kind };
    if (r.when.kind === 'event') return { ...f, eventType: r.when.eventType, filter: readEventPayloadFilter(r.when.filter ?? null) };
    if (r.when.kind === 'profile_match') return { ...f, condition: conditionAstToRows(r.when.ast) };
    return { ...f, segmentId: r.when.segmentId };
  });
}

/** Serialize the forms; the first incomplete rule is reported (1-based) instead. */
export function writeExitRules(forms: readonly ExitRuleForm[]): { rules: ExitRuleDsl[] } | { error: string } {
  const rules: ExitRuleDsl[] = [];
  for (const [i, f] of forms.entries()) {
    const n = i + 1;
    const base = { id: f.id, action: f.action, ...(f.label.trim() ? { label: f.label.trim() } : {}) };
    if (f.kind === 'event') {
      if (!f.eventType.trim()) return { error: `Rule ${n}: choose the event type.` };
      const filter = writeEventPayloadFilter(f.filter);
      rules.push({ ...base, when: { kind: 'event', eventType: f.eventType.trim(), ...(filter ? { filter } : {}) } });
    } else if (f.kind === 'profile_match') {
      const ast = editorRowsToConditionAst(f.condition);
      if (!ast) return { error: `Rule ${n}: add at least one condition.` };
      rules.push({ ...base, when: { kind: 'profile_match', ast } });
    } else {
      if (!f.segmentId) return { error: `Rule ${n}: choose a segment.` };
      rules.push({ ...base, when: { kind: f.kind, segmentId: f.segmentId } });
    }
  }
  return { rules };
}

/** A one-line summary of a stored rule, e.g. `When event "purchase" → exit`. */
export function summarizeExitRule(r: ExitRuleDsl, segmentName: (id: string) => string | undefined): string {
  const then = r.action === 'exit' ? 'exit' : 'restart';
  if (r.label) return `${r.label} → ${then}`;
  switch (r.when.kind) {
    case 'event':
      return `Event "${r.when.eventType}" → ${then}`;
    case 'segment_exit':
      return `Leaves ${segmentName(r.when.segmentId) ?? 'a segment'} → ${then}`;
    case 'segment_entry':
      return `Enters ${segmentName(r.when.segmentId) ?? 'a segment'} → ${then}`;
    case 'profile_match':
      return `Profile matches a condition → ${then}`;
  }
}
