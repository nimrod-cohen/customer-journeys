// Phase 3: the optional payload filter is evaluated against the INGESTED EVENT
// payload (not the profile), deterministically and safely — a closed grammar that
// reuses the @cdp/segments operator/field whitelist conventions (payload.* is the
// namespace). Pure + in-memory (no DB).
import { describe, it, expect } from 'vitest';
import { evaluateEventPayloadFilter } from '../src/core.js';

describe('evaluateEventPayloadFilter — pure event-payload filter eval', () => {
  it('no filter ⇒ always matches', () => {
    expect(evaluateEventPayloadFilter(undefined, { anything: 1 })).toBe(true);
    expect(evaluateEventPayloadFilter(undefined, {})).toBe(true);
  });

  it('equality rule: payload.plan == "pro"', () => {
    const filter = { field: 'payload.plan', operator: '=', value: 'pro' };
    expect(evaluateEventPayloadFilter(filter, { plan: 'pro' })).toBe(true);
    expect(evaluateEventPayloadFilter(filter, { plan: 'free' })).toBe(false);
    expect(evaluateEventPayloadFilter(filter, {})).toBe(false); // missing key
  });

  it('numeric comparison honors >= / < against the payload values', () => {
    const ge = { field: 'payload.amount', operator: '>=', value: 100 };
    expect(evaluateEventPayloadFilter(ge, { amount: 150 })).toBe(true);
    expect(evaluateEventPayloadFilter(ge, { amount: 100 })).toBe(true);
    expect(evaluateEventPayloadFilter(ge, { amount: 50 })).toBe(false);

    const lt = { field: 'payload.amount', operator: '<', value: 100 };
    expect(evaluateEventPayloadFilter(lt, { amount: 50 })).toBe(true);
    expect(evaluateEventPayloadFilter(lt, { amount: 100 })).toBe(false);
  });

  it('boolean groups (and / or / not) combine leaf predicates', () => {
    const and = {
      op: 'and',
      conditions: [
        { field: 'payload.plan', operator: '=', value: 'pro' },
        { field: 'payload.amount', operator: '>=', value: 100 },
      ],
    };
    expect(evaluateEventPayloadFilter(and, { plan: 'pro', amount: 150 })).toBe(true);
    expect(evaluateEventPayloadFilter(and, { plan: 'pro', amount: 50 })).toBe(false);

    const or = {
      op: 'or',
      conditions: [
        { field: 'payload.plan', operator: '=', value: 'pro' },
        { field: 'payload.plan', operator: '=', value: 'enterprise' },
      ],
    };
    expect(evaluateEventPayloadFilter(or, { plan: 'enterprise' })).toBe(true);
    expect(evaluateEventPayloadFilter(or, { plan: 'free' })).toBe(false);

    const not = { op: 'not', conditions: [{ field: 'payload.plan', operator: '=', value: 'free' }] };
    expect(evaluateEventPayloadFilter(not, { plan: 'pro' })).toBe(true);
    expect(evaluateEventPayloadFilter(not, { plan: 'free' })).toBe(false);
  });

  it('exists operator tests presence', () => {
    const filter = { field: 'payload.coupon', operator: 'exists' };
    expect(evaluateEventPayloadFilter(filter, { coupon: 'X' })).toBe(true);
    expect(evaluateEventPayloadFilter(filter, {})).toBe(false);
  });

  it('a NESTED dotted key resolves deep AND is FORGIVING (webinar_data?.id semantics)', () => {
    const exists = { field: 'payload.webinar_data.id', operator: 'exists' };
    // present nested leaf ⇒ true
    expect(evaluateEventPayloadFilter(exists, { webinar_data: { id: 'w1' } })).toBe(true);
    // webinar_data present but no id ⇒ false (no throw)
    expect(evaluateEventPayloadFilter(exists, { webinar_data: {} })).toBe(false);
    // webinar_data entirely absent ⇒ false (NO exception — the whole point)
    expect(evaluateEventPayloadFilter(exists, {})).toBe(false);
    expect(evaluateEventPayloadFilter(exists, { other: 1 })).toBe(false);
    // a SCALAR at webinar_data can't be descended ⇒ false, still no throw
    expect(evaluateEventPayloadFilter(exists, { webinar_data: 'nope' })).toBe(false);

    // equality on a nested leaf works, and is forgiving when the parent is missing
    const eq = { field: 'payload.webinar_data.id', operator: '=', value: 'w1' };
    expect(evaluateEventPayloadFilter(eq, { webinar_data: { id: 'w1' } })).toBe(true);
    expect(evaluateEventPayloadFilter(eq, { webinar_data: { id: 'w2' } })).toBe(false);
    expect(evaluateEventPayloadFilter(eq, {})).toBe(false); // no parent ⇒ false, never throws

    // array index traversal is supported too (items.0.sku)
    const arr = { field: 'payload.items.0.sku', operator: '=', value: 'book' };
    expect(evaluateEventPayloadFilter(arr, { items: [{ sku: 'book' }] })).toBe(true);
    expect(evaluateEventPayloadFilter(arr, { items: [] })).toBe(false); // out of range ⇒ false
  });

  it('an unknown operator is REJECTED (throws) — closed grammar', () => {
    const filter = { field: 'payload.x', operator: 'LIKE', value: '%a%' };
    expect(() => evaluateEventPayloadFilter(filter, { x: 'a' })).toThrow();
  });

  it('a non-payload (non-whitelisted) field path is REJECTED (throws)', () => {
    const filter = { field: 'profile.email', operator: '=', value: 'a@b.c' };
    expect(() => evaluateEventPayloadFilter(filter, {})).toThrow();
    const bare = { field: 'amount', operator: '=', value: 1 };
    expect(() => evaluateEventPayloadFilter(bare, { amount: 1 })).toThrow();
  });
});
