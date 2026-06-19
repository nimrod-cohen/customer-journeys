import { describe, it, expect } from 'vitest';
import { validateCampaignDefinition } from '../src/dsl.js';
import { processNode, type EnrollmentState } from '../src/core.js';
import type { Node } from '../src/dsl.js';

// PURE unit tests for the set_attribute VALUE SPEC validation + the side effect now
// carrying the spec (resolution deferred to runner execution). No DB/AWS imports.

const wrap = (setAttr: Record<string, unknown>) => ({
  startNode: 't',
  nodes: {
    t: { type: 'trigger', kind: 'manual', next: 'a' },
    a: { type: 'action', kind: 'set_attribute', next: 'x', ...setAttr },
    x: { type: 'exit' },
  },
});

describe('validateCampaignDefinition — set_attribute value spec', () => {
  it('accepts a bare scalar value (BACKWARD-COMPAT: legacy static value = implicit literal)', () => {
    expect(() => validateCampaignDefinition(wrap({ key: 'tier', value: 'gold' }))).not.toThrow();
    expect(() => validateCampaignDefinition(wrap({ key: 'count', value: 3 }))).not.toThrow();
  });

  it('accepts a set_attribute with NO value at all (value optional, defaults null)', () => {
    expect(() => validateCampaignDefinition(wrap({ key: 'tier' }))).not.toThrow();
  });

  it('accepts an explicit { kind:"literal", value }', () => {
    expect(() =>
      validateCampaignDefinition(wrap({ key: 'tier', value: { kind: 'literal', value: 'gold' } })),
    ).not.toThrow();
  });

  it('accepts an explicit { kind:"expression", expression }', () => {
    expect(() =>
      validateCampaignDefinition(
        wrap({ key: 'last_amount', value: { kind: 'expression', expression: '{{event.amount}}' } }),
      ),
    ).not.toThrow();
  });

  it('THROWS when an expression spec has a missing/empty expression string', () => {
    expect(() =>
      validateCampaignDefinition(wrap({ key: 'k', value: { kind: 'expression' } })),
    ).toThrow(/expression/i);
    expect(() =>
      validateCampaignDefinition(wrap({ key: 'k', value: { kind: 'expression', expression: '' } })),
    ).toThrow(/expression/i);
  });

  it('THROWS when a literal spec object omits its `value` payload', () => {
    expect(() =>
      validateCampaignDefinition(wrap({ key: 'k', value: { kind: 'literal' } })),
    ).toThrow(/literal/i);
  });

  it('THROWS on an unknown value-spec kind (e.g. {kind:"sql"})', () => {
    expect(() =>
      validateCampaignDefinition(wrap({ key: 'k', value: { kind: 'sql', expression: 'DROP' } })),
    ).toThrow(/value/i);
  });

  it('still THROWS when set_attribute has no key (existing rule unchanged)', () => {
    expect(() => validateCampaignDefinition(wrap({ value: 'x' }))).toThrow(/key/i);
  });
});

describe('processNode — set_attribute emits the VALUE SPEC, not a pre-resolved value', () => {
  const state: EnrollmentState = {
    id: 'e1',
    workspace_id: 'w1',
    campaign_id: 'c1',
    profile_id: 'p1',
    current_node: 'a',
    status: 'active',
    next_run_at: null,
    updated_at: '2026-01-01T00:00:00Z',
  };

  it('carries an expression spec through to the side effect (resolution happens later)', () => {
    const node: Node = {
      type: 'action',
      kind: 'set_attribute',
      key: 'last_amount',
      value: { kind: 'expression', expression: '{{event.amount}}' },
      next: 'x',
    };
    const res = processNode(node, state, false, new Date());
    expect(res.disposition).toBe('advance');
    const eff = res.sideEffects[0];
    expect(eff).toMatchObject({ kind: 'set_attribute', key: 'last_amount' });
    // The spec is carried verbatim — NOT resolved to a value at this point.
    expect((eff as { value: unknown }).value).toEqual({ kind: 'expression', expression: '{{event.amount}}' });
  });

  it('carries a bare scalar value through unchanged', () => {
    const node: Node = { type: 'action', kind: 'set_attribute', key: 'tier', value: 'gold', next: 'x' };
    const res = processNode(node, state, false, new Date());
    expect((res.sideEffects[0] as { value: unknown }).value).toBe('gold');
  });
});
