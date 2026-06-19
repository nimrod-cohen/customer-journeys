import { describe, it, expect } from 'vitest';
import {
  resolveValueSpec,
  renderExpression,
  eventMerge,
  resolveEventPath,
  expandEventToken,
  EVENT_PREFIX,
  type ValueSpec,
} from '../src/index.js';

// The set_attribute VALUE RESOLVER (@cdp/shared) — the pure twin of the
// dispatcher's renderTemplateBody. A literal is returned unchanged; an expression
// renders {{customer.*}} + {{event.*}} merge tags via ONE interpolation engine;
// an undefined/unknown path resolves SAFELY (no throw, no leftover raw token).
describe('resolveValueSpec — literal | expression | undefined-safe', () => {
  const profile = {
    id: 'p1',
    email: 'jo@example.com',
    attributes: { tier: 'gold' },
  };

  it('a numeric literal is returned UNCHANGED (not stringified)', () => {
    expect(resolveValueSpec({ kind: 'literal', value: 42 }, { profile })).toBe(42);
  });

  it('a string literal is returned unchanged', () => {
    expect(resolveValueSpec({ kind: 'literal', value: 'gold' }, { profile })).toBe('gold');
  });

  it('an explicit null literal is honored (distinct from undefined)', () => {
    expect(resolveValueSpec({ kind: 'literal', value: null }, { profile })).toBeNull();
  });

  it('a bare scalar (legacy static value) is treated as an implicit literal', () => {
    expect(resolveValueSpec('legacy', { profile })).toBe('legacy');
    expect(resolveValueSpec(7, { profile })).toBe(7);
  });

  it('expression {{customer.tier}} resolves the attribute shorthand', () => {
    expect(
      resolveValueSpec({ kind: 'expression', expression: '{{customer.tier}}' }, { profile }),
    ).toBe('gold');
  });

  it('expression {{customer.email}} resolves the reserved profile column', () => {
    expect(
      resolveValueSpec({ kind: 'expression', expression: '{{customer.email}}' }, { profile }),
    ).toBe('jo@example.com');
  });

  it('expression {{event.amount}} resolves from the persisted enrollment.state.event', () => {
    expect(
      resolveValueSpec(
        { kind: 'expression', expression: '{{event.amount}}' },
        { profile, event: { amount: 19.99 } },
      ),
    ).toBe('19.99');
  });

  it('expression {{event.items.0.sku}} resolves a DEEP dotted path', () => {
    expect(
      resolveValueSpec(
        { kind: 'expression', expression: '{{event.items.0.sku}}' },
        { profile, event: { items: [{ sku: 'ABC-1' }] } },
      ),
    ).toBe('ABC-1');
  });

  it('expression {{event.missing}} resolves SAFELY to empty (never the raw token)', () => {
    const out = resolveValueSpec(
      { kind: 'expression', expression: '{{event.missing}}' },
      { profile, event: { amount: 1 } },
    );
    expect(out).toBe('');
  });

  it('expression {{customer.unknownAttr}} resolves SAFELY (empty)', () => {
    expect(
      resolveValueSpec({ kind: 'expression', expression: '{{customer.unknownAttr}}' }, { profile }),
    ).toBe('');
  });

  it('an event.* expression with NO event on the ctx (manual/segment enroll) is safe-empty', () => {
    expect(
      resolveValueSpec({ kind: 'expression', expression: '{{event.amount}}' }, { profile }),
    ).toBe('');
  });

  it('surrounding literal text is preserved (string interpolation, not just whole-token)', () => {
    expect(
      resolveValueSpec(
        { kind: 'expression', expression: 'pre {{customer.tier}} post' },
        { profile },
      ),
    ).toBe('pre gold post');
  });

  it('an unknown namespace token {{order.total}} is left safe-empty and never throws', () => {
    expect(
      resolveValueSpec({ kind: 'expression', expression: '{{order.total}}' }, { profile }),
    ).toBe('');
  });
});

describe('event.* resolver primitives', () => {
  it('EVENT_PREFIX is "event."', () => {
    expect(EVENT_PREFIX).toBe('event.');
  });

  it('resolveEventPath does deep-dot lookup; missing → undefined', () => {
    const payload = { amount: 5, items: [{ sku: 'X' }] };
    expect(resolveEventPath(payload, 'amount')).toBe(5);
    expect(resolveEventPath(payload, 'items.0.sku')).toBe('X');
    expect(resolveEventPath(payload, 'nope')).toBeUndefined();
    expect(resolveEventPath(undefined, 'amount')).toBeUndefined();
  });

  it('eventMerge builds full event.<path> tokens for scalar leaves', () => {
    const m = eventMerge({ amount: 19.99, currency: 'USD' });
    expect(m['event.amount']).toBe('19.99');
    expect(m['event.currency']).toBe('USD');
  });

  it('eventMerge for an undefined event yields an empty map', () => {
    expect(eventMerge(undefined)).toEqual({});
  });

  it('expandEventToken is identity for event.* tokens', () => {
    expect(expandEventToken('event.amount')).toBe('event.amount');
  });
});

describe('renderExpression — the shared {{token}} engine', () => {
  it('substitutes known tokens and leaves unknown tokens EMPTY (value-resolution mode)', () => {
    const merge = { 'customer.email': 'a@b.com', 'event.amount': '5' };
    expect(renderExpression('{{customer.email}} paid {{event.amount}}', merge)).toBe('a@b.com paid 5');
    expect(renderExpression('{{event.nope}}', merge)).toBe('');
  });

  it('expands the customer.* shorthand like renderTemplateBody', () => {
    const merge = { 'customer.attributes.tier': 'gold' };
    expect(renderExpression('{{customer.tier}}', merge)).toBe('gold');
  });
});

// Type-level smoke: ValueSpec is exported and usable.
const _spec: ValueSpec = { kind: 'literal', value: 1 };
void _spec;
