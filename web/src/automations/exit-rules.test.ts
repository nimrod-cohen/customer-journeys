import { describe, it, expect } from 'vitest';
import { blankExitRule, readExitRules, writeExitRules, summarizeExitRule, type ExitRuleDsl } from './exit-rules.js';

const STORED: ExitRuleDsl[] = [
  { id: 'a', action: 'exit', label: 'Bought', when: { kind: 'event', eventType: 'purchase', filter: { op: 'and', conditions: [{ field: 'payload.total', operator: '>', value: 10 }] } } },
  { id: 'b', action: 'restart', when: { kind: 'segment_entry', segmentId: 'seg-1' } },
  { id: 'c', action: 'exit', when: { kind: 'segment_exit', segmentId: 'seg-2' } },
  { id: 'd', action: 'exit', when: { kind: 'profile_match', ast: { field: 'attributes.plan', operator: '=', value: 'paid' } } },
];

describe('exit-rule forms', () => {
  it('round-trips every kind', () => {
    const out = writeExitRules(readExitRules(STORED));
    expect('rules' in out && out.rules).toBeTruthy();
    const rules = (out as { rules: ExitRuleDsl[] }).rules;
    expect(rules.map((r) => [r.id, r.action, r.when.kind])).toEqual(STORED.map((r) => [r.id, r.action, r.when.kind]));
    expect(rules[0]).toMatchObject({ label: 'Bought', when: { eventType: 'purchase', filter: { conditions: [{ field: 'payload.total', operator: '>', value: 10 }] } } });
    expect(rules[1]!.when).toEqual({ kind: 'segment_entry', segmentId: 'seg-1' });
    expect((rules[3]!.when as { ast: unknown }).ast).toBeTruthy();
  });

  it('reports the first incomplete rule', () => {
    expect(writeExitRules([blankExitRule()])).toEqual({ error: 'Rule 1: choose the event type.' });
    expect(writeExitRules([{ ...blankExitRule(), kind: 'segment_exit' }])).toEqual({ error: 'Rule 1: choose a segment.' });
    expect(writeExitRules([{ ...blankExitRule(), eventType: 'x' }, { ...blankExitRule(), kind: 'profile_match' }])).toEqual({
      error: 'Rule 2: add at least one condition.',
    });
  });

  it('omits an empty filter and a blank label', () => {
    const out = writeExitRules([{ ...blankExitRule(), id: 'z', eventType: ' purchase ', label: '  ' }]) as { rules: ExitRuleDsl[] };
    expect(out.rules).toEqual([{ id: 'z', action: 'exit', when: { kind: 'event', eventType: 'purchase' } }]);
  });

  it('gives each new rule its own id', () => {
    expect(blankExitRule().id).not.toBe(blankExitRule().id);
  });

  it('summarizes', () => {
    const name = (id: string) => (id === 'seg-1' ? 'VIPs' : undefined);
    expect(STORED.map((r) => summarizeExitRule(r, name))).toEqual([
      'Bought → exit',
      'Enters VIPs → restart',
      'Leaves a segment → exit',
      'Profile matches a condition → exit',
    ]);
  });
});
