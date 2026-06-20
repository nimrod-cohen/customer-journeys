import { describe, it, expect } from 'vitest';
import { evaluateJsValue } from '../src/js-value.js';
import type { CustomerProfile } from '@cdp/shared';

// SECURITY-CRITICAL unit tests for the NODE-ONLY sandboxed JS value evaluator
// (node:vm in an EMPTY context). Two contracts:
//   1. SAFETY: no escape attempt may reach the host realm (process/require/etc.);
//      every attempt resolves to a harmless value ('' on throw/timeout/undefined),
//      NEVER throwing to the tick.
//   2. CORRECTNESS: valid expressions over the in-scope customer/event objects work,
//      and {{placeholders}} expand (as SAFE QUOTED literals) before eval.

const profile: CustomerProfile = {
  id: 'p1',
  email: 'jo@example.com',
  external_id: 'EXT-9',
  email_status: 'active',
  created_at: '2026-01-01T00:00:00.000Z',
  attributes: { first_name: 'jo', tier: 'gold' },
};

describe('evaluateJsValue — SANDBOX SAFETY (every escape attempt → safe-empty)', () => {
  // These attempts all resolve to the empty string: `process`/`require`/`global`
  // are undefined in the empty context (→ '') ; the realm-escape attempts via
  // constructor.constructor run the synthesized Function IN THE SAME isolated
  // context, so they too reach only undefined → ''.
  const ESCAPES_EMPTY: Array<[string, string]> = [
    ['return process', 'return process'],
    ['return require', "return require('fs')"],
    ['return global', 'return global'],
    ['this.constructor.constructor', "return this.constructor.constructor('return process')()"],
    ['customer.constructor.constructor', "return customer.constructor.constructor('return process')()"],
    ['({}).constructor.constructor', "return ({}).constructor.constructor('return this.process')()"],
  ];

  for (const [name, code] of ESCAPES_EMPTY) {
    it(`escape attempt "${name}" resolves to safe-empty (never reaches the host)`, () => {
      const out = evaluateJsValue(code, { profile });
      expect(typeof out).toBe('string');
      // The host `process` would stringify to '[object process]'; assert we never see it.
      expect(out).not.toContain('[object process]');
      expect(out).not.toContain('ChildProcess');
      expect(out).toBe('');
    });
  }

  it('`return globalThis` yields only the EMPTY sandbox global — no host leak reachable through it', () => {
    // globalThis IS the empty context's own global ([object Object]); the security
    // property is that NOTHING host-realm is reachable through it.
    const out = evaluateJsValue('return globalThis', { profile });
    expect(out).not.toContain('[object process]');
    expect(evaluateJsValue('return typeof globalThis.process', { profile })).toBe('undefined');
    expect(evaluateJsValue('return typeof globalThis.require', { profile })).toBe('undefined');
    // A realm escape THROUGH globalThis still reaches only the isolated context.
    expect(
      evaluateJsValue("return globalThis.constructor.constructor('return typeof process')()", { profile }),
    ).toBe('undefined');
  });

  it('an infinite loop is killed by the 100ms timeout → safe-empty', () => {
    const out = evaluateJsValue('while(true){}', { profile });
    expect(out).toBe('');
  });

  it('a returned object with a LOOPING toString is bounded by the timeout (coercion is INSIDE the sandbox) → safe-empty', () => {
    // If String(result) ran host-side AFTER the vm timeout, this would hang the tick.
    const out = evaluateJsValue('return { toString(){ while(true){} } }', { profile });
    expect(out).toBe('');
  });

  it('a returned object coerces via its (sandboxed) toString — only a string primitive crosses back', () => {
    expect(evaluateJsValue('return { toString(){ return "ok" } }', { profile })).toBe('ok');
    expect(typeof evaluateJsValue('return {a:1}', { profile })).toBe('string'); // [object Object], never a live object
  });

  it('a {{placeholder}} INJECTION cannot break out: an attribute value of `");return this.process;("` interpolates as a QUOTED literal → harmless', () => {
    const evil: CustomerProfile = {
      id: 'p2',
      email: 'x@y.com',
      attributes: { payload: '");return this.process;("' },
    };
    // The code embeds the placeholder where a string is expected. Because the
    // placeholder is JSON.stringify'd (a quoted literal), the injection is inert.
    const out = evaluateJsValue('return ({{customer.payload}})', { profile: evil });
    // It evaluates to the literal injected STRING (harmless), never the host process.
    expect(out).not.toContain('[object process]');
    expect(out).toBe('");return this.process;("');
  });

  it('a syntactically broken snippet throws internally but resolves safe-empty (never to the tick)', () => {
    expect(evaluateJsValue('return (', { profile })).toBe('');
    expect(() => evaluateJsValue('return (', { profile })).not.toThrow();
  });
});

describe('evaluateJsValue — VALID expressions over in-scope customer/event', () => {
  it('return customer.first_name.toUpperCase() reads an ATTRIBUTE', () => {
    expect(evaluateJsValue('return customer.first_name.toUpperCase()', { profile })).toBe('JO');
  });

  it('customer.email reads a RESERVED scalar field (top-level), and customer.attributes.x works too', () => {
    expect(evaluateJsValue('return customer.email', { profile })).toBe('jo@example.com');
    expect(evaluateJsValue('return customer.attributes.tier', { profile })).toBe('gold');
  });

  it('a BARE expression (no return keyword) is wrapped in `return (...)`', () => {
    expect(evaluateJsValue('customer.email', { profile })).toBe('jo@example.com');
  });

  it('return (event.amount*1.1).toFixed(2) computes over the event', () => {
    expect(evaluateJsValue('return (event.amount*1.1).toFixed(2)', { profile, event: { amount: 100 } })).toBe('110.00');
  });

  it('event.plan reads payload.plan (event = { type, ...payload })', () => {
    expect(evaluateJsValue('return event.plan', { profile, event: { plan: 'pro' } })).toBe('pro');
  });

  it('an event.* read on a NO-EVENT ctx is safe-empty (never throws)', () => {
    // event is {} → event.amount is undefined → (undefined).toFixed throws → ''.
    expect(evaluateJsValue('return event.amount.toFixed(2)', { profile })).toBe('');
    // a plain undefined read coerces to ''.
    expect(evaluateJsValue('return event.amount', { profile })).toBe('');
  });

  it('undefined / null results coerce to empty string', () => {
    expect(evaluateJsValue('return undefined', { profile })).toBe('');
    expect(evaluateJsValue('return null', { profile })).toBe('');
  });

  it('a {{customer.*}} placeholder expands (quoted) before eval', () => {
    // The placeholder is replaced with JSON.stringify('gold') = "gold" → a string literal.
    expect(evaluateJsValue('return ({{customer.tier}}).toUpperCase()', { profile })).toBe('GOLD');
  });

  it('an unknown placeholder token expands to a quoted empty string', () => {
    expect(evaluateJsValue('return {{customer.nope}} + "x"', { profile })).toBe('x');
  });

  it('Math/JSON/Date intrinsics of the context ARE available (own intrinsics, not host)', () => {
    expect(evaluateJsValue('return Math.max(2,5)', { profile })).toBe('5');
    expect(evaluateJsValue('return JSON.stringify({a:1})', { profile })).toBe('{"a":1}');
  });
});
