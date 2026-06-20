import { describe, it, expect } from 'vitest';
import { isJsSpec, isExpressionSpec, isLiteralSpec, resolveValueSpec, type ValueSpec } from '../src/index.js';

// A 'js' value spec is part of the ValueSpec union + has a guard. @cdp/shared is
// isomorphic (used by web), so it NEVER evaluates the js code itself (no node:vm
// import) — resolveValueSpec stays literal/expression-only. The runner's NODE-ONLY
// js-value module evaluates 'js'; here we only assert the TYPE + the guard + that
// the shared resolver does NOT execute it.
describe('JsValueSpec — type + guard (isomorphic; never evaluated here)', () => {
  it('isJsSpec recognizes a { kind:"js", code } spec only', () => {
    expect(isJsSpec({ kind: 'js', code: 'return 1' })).toBe(true);
    expect(isJsSpec({ kind: 'literal', value: 1 })).toBe(false);
    expect(isJsSpec({ kind: 'expression', expression: '{{x}}' })).toBe(false);
    expect(isJsSpec('bare')).toBe(false);
    expect(isJsSpec(null)).toBe(false);
    expect(isJsSpec({ kind: 'js' })).toBe(false); // code must be a string
  });

  it('the three guards are mutually exclusive on a js spec', () => {
    const js = { kind: 'js', code: 'return customer.email' };
    expect(isJsSpec(js)).toBe(true);
    expect(isExpressionSpec(js)).toBe(false);
    expect(isLiteralSpec(js)).toBe(false);
  });

  it('resolveValueSpec does NOT execute a js spec (isomorphic-safe) — returns null', () => {
    // The shared resolver only knows literal/expression; a js spec is a spec object
    // it does not recognize → defensive null (the runner resolves js NODE-side).
    expect(resolveValueSpec({ kind: 'js', code: 'return 1+1' }, { profile: { id: 'p' } })).toBeNull();
  });

  it('a js spec is assignable to ValueSpec', () => {
    const spec: ValueSpec = { kind: 'js', code: 'return 1' };
    expect(spec.kind).toBe('js');
  });
});
