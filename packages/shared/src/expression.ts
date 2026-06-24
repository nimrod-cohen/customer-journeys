// The set_attribute VALUE spec + resolver (§9B update-profile, event-sourced).
//
// A set_attribute action's `value` is EITHER:
//   - a LITERAL   ({ kind:'literal', value })  — written verbatim (any JSON value);
//   - an EXPRESSION ({ kind:'expression', expression }) — a {{token}} template
//     rendered against the profile (customer.*) + the trigger event (event.*); or
//   - a LEGACY BARE SCALAR (the original static-value shape) — treated as a literal.
//
// resolveValueSpec is the PURE twin of the dispatcher's renderTemplateBody: ONE
// shared interpolation engine (renderExpression) over the customer.* + event.*
// merge maps. Resolution is READ-ONLY string substitution — never interpolated into
// SQL (invariant 6 untouched). An undefined/unknown path resolves SAFELY to empty
// (never throws, never leaves a raw `{{...}}` token as the written value), so an
// event.* expression on a manual/segment enrollment (no state.event) is harmless.
import { customerMerge, expandCustomerToken, type CustomerProfile } from './customer.js';
import { eventMerge } from './event.js';
import { journeyMerge } from './journey.js';

/** A literal value spec — written verbatim (number/string/null/object…). */
export interface LiteralValueSpec {
  readonly kind: 'literal';
  readonly value: unknown;
}

/** An expression value spec — a {{token}} template resolved at runner execution. */
export interface ExpressionValueSpec {
  readonly kind: 'expression';
  readonly expression: string;
}

/**
 * A SANDBOXED JS value spec — a snippet of JavaScript evaluated NODE-SIDE ONLY
 * (services/campaign-runner/src/js-value.ts, via node:vm in an empty context with
 * NO host globals). `code` may contain {{customer.*}}/{{event.*}} placeholders that
 * are interpolated as SAFE QUOTED literals BEFORE evaluation; `customer`/`event`
 * objects are also in scope inside the sandbox.
 *
 * IMPORTANT: this module (@cdp/shared) is ISOMORPHIC (used by the web SPA) and so it
 * MUST NOT import node:vm or evaluate 'js'. resolveValueSpec below only handles
 * literal/expression; the runner resolves a 'js' spec with evaluateJsValue. The web
 * only needs this TYPE (for the editor's value-mode form), never the evaluator.
 */
export interface JsValueSpec {
  readonly kind: 'js';
  readonly code: string;
}

/** The explicit value spec union (a legacy bare scalar is ALSO an accepted value). */
export type ValueSpec = LiteralValueSpec | ExpressionValueSpec | JsValueSpec;

/** The context a value expression resolves against: profile + trigger event + journey vars. */
export interface ValueResolveContext {
  readonly profile: CustomerProfile;
  /** The persisted trigger event payload (enrollment.state.event); absent for
   *  manual/segment enrollment → an event.* token resolves safe-empty. */
  readonly event?: unknown;
  /** Per-enrollment journey variables (enrollment.state.journey); absent on a
   *  fresh enrollment → a journey.* token resolves safe-empty. */
  readonly journey?: unknown;
}

/** True iff `v` is an explicit expression spec object. */
export function isExpressionSpec(v: unknown): v is ExpressionValueSpec {
  return typeof v === 'object' && v !== null && (v as { kind?: unknown }).kind === 'expression';
}

/** True iff `v` is an explicit literal spec object. */
export function isLiteralSpec(v: unknown): v is LiteralValueSpec {
  return typeof v === 'object' && v !== null && (v as { kind?: unknown }).kind === 'literal';
}

/**
 * True iff `v` is a SANDBOXED JS value spec ({ kind:'js', code:<string> }). The
 * runner gates on this to route a value through the NODE-ONLY evaluateJsValue; the
 * shared resolver below intentionally does NOT execute it (isomorphic-safe).
 */
export function isJsSpec(v: unknown): v is JsValueSpec {
  return (
    typeof v === 'object' &&
    v !== null &&
    (v as { kind?: unknown }).kind === 'js' &&
    typeof (v as { code?: unknown }).code === 'string'
  );
}

/** True iff `v` is a SPEC OBJECT (has a `kind`) — i.e. NOT a legacy bare scalar. */
function isSpecObject(v: unknown): v is { kind?: unknown } {
  return typeof v === 'object' && v !== null && 'kind' in (v as object);
}

/**
 * The shared `{{token}}` interpolation engine — extracted so this resolver and the
 * dispatcher's renderTemplateBody substitute identically (same expandCustomerToken
 * normalization, whitespace-tolerant). UNKNOWN tokens resolve to EMPTY here (value
 * resolution must never write a raw `{{...}}` into a profile attribute). Tokens are
 * looked up by the canonical (customer-expanded) key first, then the raw key.
 */
export function renderExpression(template: string, merge: Readonly<Record<string, string>>): string {
  return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_match, key: string) => {
    const value = merge[expandCustomerToken(key)] ?? merge[key];
    return value === undefined ? '' : value;
  });
}

/**
 * Resolve a set_attribute value spec to the value to write (§9B). PURE; never
 * throws. A literal (explicit or legacy bare scalar) is returned UNCHANGED (numbers
 * stay numbers, an explicit null stays null). An expression is rendered against the
 * combined customer.* + event.* merge map via renderExpression — so a fully-resolved
 * expression yields a string, and an undefined/unknown path yields '' (safe-empty).
 */
export function resolveValueSpec(spec: unknown, ctx: ValueResolveContext): unknown {
  if (isExpressionSpec(spec)) {
    const merge = {
      ...customerMerge(ctx.profile),
      ...eventMerge(ctx.event),
      ...journeyMerge(ctx.journey),
    };
    return renderExpression(spec.expression, merge);
  }
  if (isLiteralSpec(spec)) {
    return spec.value;
  }
  // A spec object that is neither literal nor expression is not a valid value; the
  // validator (validateCampaignDefinition) rejects it before persistence. Defensive
  // here: treat an unknown spec object as null rather than throw at runner time.
  if (isSpecObject(spec)) return null;
  // Legacy bare scalar — the original static value shape — is an implicit literal.
  return spec;
}
