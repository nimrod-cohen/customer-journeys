// NODE-ONLY sandboxed JS value evaluator for a set_attribute action (§9B,
// Feature C). A { kind:'js', code } value spec lets a marketer compute an attribute
// value with a small JS snippet over the recipient `customer` + the trigger `event`.
//
// THIS MODULE IS NODE-ONLY (it imports node:vm) and MUST NOT be imported by the web
// SPA — the web only needs the JsValueSpec TYPE from @cdp/shared. The runner routes
// a 'js' spec here (run.ts); everything else stays in @cdp/shared's resolveValueSpec.
//
// SAFE-SANDBOX RECIPE (security-critical — see the unit tests for the escape attempts
// it defeats):
//   1. Interpolate every {{token}} in `code` with JSON.stringify(resolvedStringValue)
//      — a SAFE QUOTED literal, never the raw value — so a placeholder value
//      containing JS cannot inject code. An unknown token → JSON.stringify('').
//   2. Build plain `customer`/`event` objects but PARSE THEM INSIDE THE VM CONTEXT
//      (pass JSON strings, JSON.parse inside the wrapper) so they are CONTEXT-NATIVE
//      — defeating the realm-escape via a host object's prototype chain
//      (customer.constructor.constructor('return process')()).
//   3. Context = vm.createContext(Object.create(null)) — EMPTY, so NO host globals
//      (process/require/Buffer/global are undefined); only the context's OWN
//      intrinsics (Object/Array/Math/JSON/String/Number/Date/Function) exist.
//   4. Source wraps the body in a strict IIFE; the body is `code` if it contains a
//      `return` keyword, else `return (<code>);`.
//   5. vm.runInContext(src, ctx, { timeout: 100, displayErrors:false }). Coerce the
//      result: undefined/null → '' ; else String(result). On ANY throw/timeout →
//      return '' (safe-empty; NEVER throw to the tick).
import vm from 'node:vm';
import {
  customerMerge,
  eventMerge,
  expandCustomerToken,
  RESERVED_CUSTOMER_FIELDS,
  type CustomerProfile,
} from '@cdp/shared';

/** The context an `evaluateJsValue` snippet runs against. */
export interface JsValueContext {
  readonly profile: CustomerProfile;
  /** The trigger-event payload (enrollment.state.event); absent for manual/segment. */
  readonly event?: unknown;
}

/** Matches a {{ token }} placeholder (whitespace-tolerant, dotted keys). */
const PLACEHOLDER_RE = /\{\{\s*([\w.]+)\s*\}\}/g;

/** Whether the snippet already contains a `return` statement (vs a bare expression). */
const RETURN_RE = /\breturn\b/;

/**
 * Build the `customer` object the sandbox sees:
 *   { ...reserved scalar fields, ...attributes, attributes }
 * so customer.first_name [attr], customer.email [field], and customer.attributes.x
 * all resolve. Reserved fields win at the top level over an identically-named attr.
 */
function buildCustomerObject(profile: CustomerProfile): Record<string, unknown> {
  const attributes = (profile.attributes ?? {}) as Record<string, unknown>;
  const out: Record<string, unknown> = { ...attributes };
  const rec = profile as Record<string, unknown>;
  for (const f of RESERVED_CUSTOMER_FIELDS) {
    const v = rec[f];
    if (v !== undefined && v !== null) out[f] = v instanceof Date ? v.toISOString() : v;
  }
  out.attributes = attributes;
  return out;
}

/**
 * Build the `event` object the sandbox sees: { type, ...payload } so event.plan ===
 * payload.plan. An absent/non-object payload yields {} (event.* reads safe-undefined).
 */
function buildEventObject(event: unknown): Record<string, unknown> {
  if (event === undefined || event === null || typeof event !== 'object') return {};
  // The payload IS the persisted state.event.payload (run.ts passes it directly);
  // it may already carry a `type`. Spread it; preserve any `type` it has.
  return { ...(event as Record<string, unknown>) };
}

/** Interpolate {{token}} → JSON.stringify(resolvedStringValue) (a safe quoted literal). */
function interpolatePlaceholders(code: string, profile: CustomerProfile, event: unknown): string {
  const merge: Record<string, string> = { ...customerMerge(profile), ...eventMerge(event) };
  return code.replace(PLACEHOLDER_RE, (_m, key: string) => {
    const value = merge[expandCustomerToken(key)] ?? merge[key] ?? '';
    return JSON.stringify(value); // a QUOTED string literal — injection-inert
  });
}

/**
 * Evaluate a sandboxed JS value snippet. Returns a STRING (the value to write).
 * NEVER throws — any error/timeout/escape attempt resolves to '' (safe-empty).
 */
export function evaluateJsValue(code: string, ctx: JsValueContext): string {
  if (typeof code !== 'string') return '';
  try {
    const customerObj = buildCustomerObject(ctx.profile);
    const eventObj = buildEventObject(ctx.event);
    // The data is passed as JSON STRINGS and parsed INSIDE the context, so the
    // resulting objects are context-native (their prototype chain leads to the
    // context's intrinsics, never the host realm).
    const cjson = JSON.stringify(JSON.stringify(customerObj));
    const ejson = JSON.stringify(JSON.stringify(eventObj));
    const interpolated = interpolatePlaceholders(code, ctx.profile, ctx.event);
    const body = RETURN_RE.test(interpolated) ? interpolated : `return (${interpolated});`;
    // Coerce the result to a string INSIDE the context, under the timeout — so a
    // returned object with a looping/throwing toString is bounded by the vm timeout
    // (a host-side String(result) would run that toString OUTSIDE the guard). Only a
    // string PRIMITIVE crosses the boundary back to the host (realm-agnostic, safe).
    const src =
      `"use strict";(function(){` +
      `const customer=JSON.parse(${cjson});const event=JSON.parse(${ejson});` +
      `const __v=(function(){${body}})();` +
      `return (__v===undefined||__v===null)?'':String(__v);` +
      `})()`;

    // EMPTY context: no host globals. Only the context's own intrinsics exist.
    const context = vm.createContext(Object.create(null) as object);
    const result = vm.runInContext(src, context, { timeout: 100, displayErrors: false });
    return typeof result === 'string' ? result : '';
  } catch {
    // Any throw (syntax/runtime/timeout/escape) → safe-empty. Never to the tick.
    return '';
  }
}
