import { describe, it, expect } from 'vitest';
import { validateCampaignDefinition } from '../src/dsl.js';
import { processNode, buildSetAttribute, buildSetJourney, type EnrollmentState } from '../src/core.js';
import type { Node } from '../src/dsl.js';

// PURE unit tests for the MULTI-ASSIGNMENT set_attribute (Feature B) + the js value
// spec validation (Feature C). No DB/AWS.

const wrap = (setAttr: Record<string, unknown>) => ({
  startNode: 't',
  nodes: {
    t: { type: 'trigger', kind: 'manual', next: 'a' },
    a: { type: 'action', kind: 'set_attribute', next: 'x', ...setAttr },
    x: { type: 'exit' },
  },
});

describe('validateCampaignDefinition — multi-assignment + js', () => {
  it('accepts an assignments[] list with ≥1 non-empty key (no single key)', () => {
    expect(() =>
      validateCampaignDefinition(
        wrap({ assignments: [{ key: 'tier', value: { kind: 'literal', value: 'gold' } }] }),
      ),
    ).not.toThrow();
  });

  it('accepts a MIXED list: literal + expression + js', () => {
    expect(() =>
      validateCampaignDefinition(
        wrap({
          assignments: [
            { key: 'tier', value: { kind: 'literal', value: 'gold' } },
            { key: 'last_amount', value: { kind: 'expression', expression: '{{event.amount}}' } },
            { key: 'upper_name', value: { kind: 'js', code: 'return customer.first_name.toUpperCase()' } },
          ],
        }),
      ),
    ).not.toThrow();
  });

  it('REJECTS a set_attribute with neither a key nor a keyed assignment', () => {
    expect(() => validateCampaignDefinition(wrap({}))).toThrow(/key/i);
    expect(() => validateCampaignDefinition(wrap({ assignments: [] }))).toThrow(/key/i);
    expect(() => validateCampaignDefinition(wrap({ assignments: [{ key: '', value: 'x' }] }))).toThrow(/key/i);
  });

  it('a js value spec is valid iff code is a string', () => {
    expect(() =>
      validateCampaignDefinition(wrap({ key: 'k', value: { kind: 'js', code: 'return 1' } })),
    ).not.toThrow();
    expect(() =>
      validateCampaignDefinition(wrap({ key: 'k', value: { kind: 'js' } })),
    ).toThrow(/js/i);
    expect(() =>
      validateCampaignDefinition(wrap({ key: 'k', value: { kind: 'js', code: 42 } })),
    ).toThrow(/js/i);
  });

  it('still accepts the legacy single key/value (back-compat)', () => {
    expect(() => validateCampaignDefinition(wrap({ key: 'tier', value: 'gold' }))).not.toThrow();
  });
});

describe('processNode — set_attribute emits an assignments LIST', () => {
  const state: EnrollmentState = {
    id: 'e1', workspace_id: 'w1', campaign_id: 'c1', profile_id: 'p1',
    current_node: 'a', status: 'active', next_run_at: null, updated_at: '2026-01-01T00:00:00Z',
  };

  it('normalizes a SINGLE key/value into a 1-element assignments list', () => {
    const node: Node = { type: 'action', kind: 'set_attribute', key: 'tier', value: 'gold', next: 'x' };
    const res = processNode(node, state, false, new Date());
    const eff = res.sideEffects[0] as { kind: string; assignments: Array<{ key: string; value: unknown }> };
    expect(eff.kind).toBe('set_attribute');
    expect(eff.assignments).toEqual([{ key: 'tier', value: 'gold' }]);
  });

  it('carries a MULTI assignments list through verbatim (specs not yet resolved)', () => {
    const node: Node = {
      type: 'action', kind: 'set_attribute',
      assignments: [
        { key: 'tier', value: { kind: 'literal', value: 'gold' } },
        { key: 'amt', value: { kind: 'expression', expression: '{{event.amount}}' } },
      ],
      next: 'x',
    } as unknown as Node;
    const res = processNode(node, state, false, new Date());
    const eff = res.sideEffects[0] as { assignments: Array<{ key: string; value: unknown }> };
    expect(eff.assignments).toEqual([
      { key: 'tier', value: { kind: 'literal', value: 'gold' } },
      { key: 'amt', value: { kind: 'expression', expression: '{{event.amount}}' } },
    ]);
  });

  it('drops assignment rows with a blank key; null when NO keyed assignment', () => {
    const node: Node = {
      type: 'action', kind: 'set_attribute',
      assignments: [{ key: '', value: 'x' }, { key: 'tier', value: 'gold' }],
      next: 'x',
    } as unknown as Node;
    const eff = processNode(node, state, false, new Date()).sideEffects[0] as { assignments: Array<{ key: string }> };
    expect(eff.assignments).toEqual([{ key: 'tier', value: 'gold' }]);

    const empty: Node = { type: 'action', kind: 'set_attribute', next: 'x' } as unknown as Node;
    expect(processNode(empty, state, false, new Date()).sideEffects).toHaveLength(0);
  });
});

describe('buildSetAttribute — MULTIPLE assignments in ONE parameterized UPDATE (nested jsonb_set)', () => {
  it('binds workspace_id at $1, every value as a ::jsonb param; nested jsonb_set, never interpolated', () => {
    const stmt = buildSetAttribute('w1', 'p1', [
      { key: 'tier', value: 'gold' },
      { key: 'amount', value: 19.99 },
    ]);
    expect(stmt.values[0]).toBe('w1'); // workspace_id at $1
    expect(stmt.values[1]).toBe('p1'); // profile id at $2
    // path + value params follow as pairs.
    expect(stmt.values).toEqual(['w1', 'p1', '{tier}', JSON.stringify('gold'), '{amount}', JSON.stringify(19.99)]);
    // NESTED jsonb_set: two set calls. No literal value spliced into the SQL text.
    const setCount = (stmt.text.match(/jsonb_set/g) ?? []).length;
    expect(setCount).toBe(2);
    expect(stmt.text).toMatch(/workspace_id = \$1/);
    expect(stmt.text).not.toContain('gold'); // value never interpolated
  });

  it('accepts a SINGLE-element list (back-compat shape) and uses one jsonb_set', () => {
    const stmt = buildSetAttribute('w1', 'p1', [{ key: 'tier', value: 'gold' }]);
    expect((stmt.text.match(/jsonb_set/g) ?? []).length).toBe(1);
    expect(stmt.values).toEqual(['w1', 'p1', '{tier}', JSON.stringify('gold')]);
  });

  it('THROWS on a falsy workspaceId (tenant-isolation guard)', () => {
    expect(() => buildSetAttribute('', 'p1', [{ key: 'tier', value: 'gold' }])).toThrow(/workspaceId/);
  });
});

describe('buildSetJourney — writes to campaign_enrollments.state.journey (per-enrollment)', () => {
  it('seeds state.journey then nested jsonb_set with bound (path, value) params', () => {
    const stmt = buildSetJourney('w1', 'e1', [
      { key: 'cohort', value: 'launch' },
      { key: 'step', value: 3 },
    ]);
    expect(stmt.values[0]).toBe('w1');
    expect(stmt.values[1]).toBe('e1');
    // path params include the `journey` prefix; value params are jsonb-stringified.
    expect(stmt.values).toEqual([
      'w1', 'e1',
      '{journey,cohort}', JSON.stringify('launch'),
      '{journey,step}', JSON.stringify(3),
    ]);
    // Three jsonb_set calls — one seeds state.journey, two write the assignments.
    expect((stmt.text.match(/jsonb_set/g) ?? []).length).toBe(3);
    expect(stmt.text).toMatch(/UPDATE campaign_enrollments/);
    expect(stmt.text).toMatch(/workspace_id = \$1/);
    expect(stmt.text).not.toContain('launch'); // value never interpolated
  });

  it('THROWS on a falsy workspaceId (tenant-isolation guard)', () => {
    expect(() => buildSetJourney('', 'e1', [{ key: 'k', value: 1 }])).toThrow(/workspaceId/);
  });

  it('THROWS on an empty assignments list', () => {
    expect(() => buildSetJourney('w1', 'e1', [])).toThrow(/at least one assignment/);
  });
});
