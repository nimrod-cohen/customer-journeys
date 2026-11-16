// Exit rules — pure decisions, validation, and SQL builders.
import { describe, it, expect } from 'vitest';
import { validateAutomationDefinition } from '../src/dsl.js';
import { validateExitRules, exitRuleSegmentIds, describeExitRule, MAX_EXIT_RULES, type ExitRule } from '../src/exit-rules-dsl.js';
import {
  ruleFiresOnSignal,
  decideProfileMatch,
  resolveExitDecision,
  buildRestartEnrollment,
  buildExitEnrollment,
  buildExitLatchUpdate,
  buildCancelPendingAutomationOutbox,
  decideForEnrollment,
  MAX_RESTARTS,
  type ActiveEnrollment,
} from '../src/exit-rules.js';
import { buildAutomationDedupeKey, buildAutomationOutboxInsert, buildWebhookActivityInsert } from '../src/core.js';

const GRAPH = {
  startNode: 't',
  nodes: { t: { type: 'trigger', kind: 'manual', next: 'x' }, x: { type: 'exit' } },
};

const evRule = (action: 'exit' | 'restart', extra: Partial<ExitRule> = {}): ExitRule => ({
  id: `ev-${action}`,
  action,
  when: { kind: 'event', eventType: 'purchase' },
  ...extra,
});
const pmRule = (action: 'exit' | 'restart'): ExitRule => ({
  id: `pm-${action}`,
  action,
  when: { kind: 'profile_match', ast: { field: 'attributes.plan', operator: '=', value: 'paid' } as never },
});

describe('validateExitRules', () => {
  it('accepts absent rules and every kind', () => {
    expect(() => validateExitRules(undefined)).not.toThrow();
    expect(() =>
      validateExitRules([
        evRule('exit'),
        { id: 'f', action: 'restart', when: { kind: 'event', eventType: 'x', filter: { field: 'payload.a', operator: '=', value: 1 } } },
        { id: 's1', action: 'exit', when: { kind: 'segment_exit', segmentId: 'seg' } },
        { id: 's2', action: 'restart', when: { kind: 'segment_entry', segmentId: 'seg' } },
        pmRule('exit'),
      ]),
    ).not.toThrow();
  });

  it.each([
    ['not an array', {}],
    ['missing id', [{ action: 'exit', when: { kind: 'event', eventType: 'x' } }]],
    ['duplicate id', [evRule('exit'), { ...evRule('restart'), id: 'ev-exit' }]],
    ['bad action', [{ id: 'a', action: 'pause', when: { kind: 'event', eventType: 'x' } }]],
    ['bad kind', [{ id: 'a', action: 'exit', when: { kind: 'weather' } }]],
    ['blank event type', [{ id: 'a', action: 'exit', when: { kind: 'event', eventType: '  ' } }]],
    ['missing segment', [{ id: 'a', action: 'exit', when: { kind: 'segment_exit' } }]],
    ['missing condition', [{ id: 'a', action: 'exit', when: { kind: 'profile_match' } }]],
    ['malformed condition', [{ id: 'a', action: 'exit', when: { kind: 'profile_match', ast: { op: 'and' } } }]],
  ])('rejects %s', (_label, rules) => {
    expect(() => validateExitRules(rules)).toThrow();
  });

  it('caps the rule count', () => {
    const many = Array.from({ length: MAX_EXIT_RULES + 1 }, (_, i) => ({ ...evRule('exit'), id: `r${i}` }));
    expect(() => validateExitRules(many)).toThrow(/at most/);
  });

  it('runs as part of validateAutomationDefinition', () => {
    expect(() => validateAutomationDefinition({ ...GRAPH, exitRules: [evRule('exit')] })).not.toThrow();
    expect(() => validateAutomationDefinition({ ...GRAPH, exitRules: [{ id: 'x' }] })).toThrow();
  });

  it('lists referenced segments and describes rules', () => {
    const rules: ExitRule[] = [
      { id: 'a', action: 'exit', when: { kind: 'segment_exit', segmentId: 's1' } },
      { id: 'b', action: 'exit', when: { kind: 'segment_entry', segmentId: 's1' } },
      { id: 'c', action: 'exit', when: { kind: 'segment_entry', segmentId: 's2' } },
    ];
    expect(exitRuleSegmentIds(rules).sort()).toEqual(['s1', 's2']);
    expect(describeExitRule(evRule('exit'))).toBe('event "purchase"');
    expect(describeExitRule({ ...evRule('exit'), label: ' Bought ' })).toBe('Bought');
  });
});

describe('ruleFiresOnSignal', () => {
  const ev = (type: string, payload: Record<string, unknown> = {}) => ({ kind: 'event' as const, type, payload, eventId: 'e' });

  it('event: type match, optional payload filter, unevaluable filter never fires', () => {
    expect(ruleFiresOnSignal(evRule('exit'), ev('purchase'))).toBe(true);
    expect(ruleFiresOnSignal(evRule('exit'), ev('view'))).toBe(false);
    const filtered: ExitRule = { id: 'f', action: 'exit', when: { kind: 'event', eventType: 'purchase', filter: { field: 'payload.total', operator: '>', value: 100 } as never } };
    expect(ruleFiresOnSignal(filtered, ev('purchase', { total: 150 }))).toBe(true);
    expect(ruleFiresOnSignal(filtered, ev('purchase', { total: 50 }))).toBe(false);
    const bad: ExitRule = { id: 'b', action: 'exit', when: { kind: 'event', eventType: 'purchase', filter: { field: 'attributes.x', operator: '=', value: 1 } as never } };
    expect(ruleFiresOnSignal(bad, ev('purchase'))).toBe(false);
  });

  it('segment rules match only their segment and direction', () => {
    const left: ExitRule = { id: 'l', action: 'exit', when: { kind: 'segment_exit', segmentId: 'S' } };
    const entered: ExitRule = { id: 'e', action: 'exit', when: { kind: 'segment_entry', segmentId: 'S' } };
    expect(ruleFiresOnSignal(left, { kind: 'segment', segmentId: 'S', action: 'exited' })).toBe(true);
    expect(ruleFiresOnSignal(left, { kind: 'segment', segmentId: 'S', action: 'entered' })).toBe(false);
    expect(ruleFiresOnSignal(left, { kind: 'segment', segmentId: 'T', action: 'exited' })).toBe(false);
    expect(ruleFiresOnSignal(entered, { kind: 'segment', segmentId: 'S', action: 'entered' })).toBe(true);
    expect(ruleFiresOnSignal(left, ev('purchase'))).toBe(false);
  });

  it('profile_match is never decided here', () => {
    expect(ruleFiresOnSignal(pmRule('exit'), { kind: 'tick' })).toBe(false);
  });
});

describe('decideProfileMatch', () => {
  it('exit is level-triggered', () => {
    expect(decideProfileMatch(pmRule('exit'), true, undefined).fire).toBe(true);
    expect(decideProfileMatch(pmRule('exit'), true, true).fire).toBe(true);
    expect(decideProfileMatch(pmRule('exit'), false, true).fire).toBe(false);
  });
  it('restart fires only on an observed false→true', () => {
    expect(decideProfileMatch(pmRule('restart'), true, undefined)).toEqual({ fire: false, latch: true });
    expect(decideProfileMatch(pmRule('restart'), true, true)).toEqual({ fire: false, latch: true });
    expect(decideProfileMatch(pmRule('restart'), false, true)).toEqual({ fire: false, latch: false });
    expect(decideProfileMatch(pmRule('restart'), true, false)).toEqual({ fire: true, latch: true });
  });
});

describe('resolveExitDecision', () => {
  it('exit beats restart, nothing fired = no action', () => {
    expect(resolveExitDecision([evRule('restart'), evRule('exit')], 0, null).action).toBe('exit');
    expect(resolveExitDecision([evRule('restart')], 0, null).action).toBe('restart');
    expect(resolveExitDecision([], 0, null).action).toBeNull();
  });
  it('drops a restart past the cap', () => {
    expect(resolveExitDecision([evRule('restart')], MAX_RESTARTS, null).action).toBeNull();
    expect(resolveExitDecision([evRule('exit')], MAX_RESTARTS, null).action).toBe('exit');
  });
});

describe('decideForEnrollment', () => {
  const base: ActiveEnrollment = {
    id: 'en',
    automation_id: 'a',
    profile_id: 'p',
    restarts: 0,
    start_node: 't',
    rules: [pmRule('restart')],
    state: null,
  };
  const reader = (matches: boolean) => ({ query: async () => ({ rows: matches ? [{ id: 'p' }] : [] }) }) as never;

  it('records the first observation without restarting', async () => {
    const d = await decideForEnrollment(reader(true), 'ws', base, { kind: 'tick' });
    expect(d.action).toBeNull();
    expect(d.latches).toEqual({ 'pm-restart': true });
  });
  it('restarts on false→true and reports no latch change when unchanged', async () => {
    const d = await decideForEnrollment(reader(true), 'ws', { ...base, state: { exit_latch: { 'pm-restart': false } } }, { kind: 'tick' });
    expect(d.action).toBe('restart');
    const same = await decideForEnrollment(reader(true), 'ws', { ...base, state: { exit_latch: { 'pm-restart': true } } }, { kind: 'tick' });
    expect(same).toEqual({ action: null, rule: null, latches: null });
  });
  it('skips profile rules on segment signals (no query)', async () => {
    let calls = 0;
    const r = { query: async () => { calls += 1; return { rows: [] }; } } as never;
    await decideForEnrollment(r, 'ws', base, { kind: 'segment', segmentId: 's', action: 'exited' });
    expect(calls).toBe(0);
  });
  it('a query failure never fires', async () => {
    const r = { query: async () => { throw new Error('boom'); } } as never;
    const d = await decideForEnrollment(r, 'ws', { ...base, rules: [pmRule('exit')] }, { kind: 'tick' });
    expect(d.action).toBeNull();
  });
});

describe('SQL builders', () => {
  it('bind workspace_id at $1 and refuse a blank one', () => {
    for (const s of [
      buildExitEnrollment('ws', 'e', 'why'),
      buildRestartEnrollment('ws', 'e', 't', null, null),
      buildExitLatchUpdate('ws', 'e', {}),
      buildCancelPendingAutomationOutbox('ws', 'a', 'p', 'why'),
    ]) {
      expect(s.values[0]).toBe('ws');
    }
    expect(() => buildExitEnrollment('', 'e', 'why')).toThrow();
    expect(() => buildRestartEnrollment('', 'e', 't', null, null)).toThrow();
  });
  it('restart is guarded by the cap and only touches active rows', () => {
    const s = buildRestartEnrollment('ws', 'e', 't', { type: 'x', payload: {}, event_id: 'i' }, { r: true });
    expect(s.text).toMatch(/status = 'active'/);
    expect(s.text).toMatch(/restarts < \$6/);
    expect(s.values[5]).toBe(MAX_RESTARTS);
  });
  it('the latch write does not touch updated_at (runner guard)', () => {
    expect(buildExitLatchUpdate('ws', 'e', {}).text).not.toMatch(/updated_at/);
  });
  it('cancels only PENDING outbox rows', () => {
    expect(buildCancelPendingAutomationOutbox('ws', 'a', 'p', 'r').text).toMatch(/status = 'pending'/);
  });
});

describe('dedupe keys include the restart number', () => {
  it('run 0 keeps the original key; later runs get a fresh one', () => {
    expect(buildAutomationDedupeKey('a', 'p', 'n')).toBe('automation:a:p:n');
    expect(buildAutomationDedupeKey('a', 'p', 'n', 0)).toBe('automation:a:p:n');
    expect(buildAutomationDedupeKey('a', 'p', 'n', 2)).toBe('automation:a:p:n:r2');
    expect(buildAutomationOutboxInsert('ws', 'a', 'p', null, 'n', {}, 1).values).toContain('automation:a:p:n:r1');
    expect(buildWebhookActivityInsert('ws', 'p', 'a', 'n', { blocked: true }, 3).values).toContain('automation:a:p:n:r3');
  });
});
