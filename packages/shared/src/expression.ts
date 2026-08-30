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
 * (services/automation-runner/src/js-value.ts, via node:vm in an empty context with
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
 * Escape a merge value for an HTML text or quoted-attribute context.
 *
 * `&` MUST be replaced first: doing it after `<` would rewrite the `&` of the
 * `&lt;` we just produced into `&amp;lt;`, and the recipient would see the tag as
 * literal text.
 */
export function escapeHtmlValue(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Merge keys whose value is HTML WE generate, not user data — written verbatim
 * even in the double-brace form.
 *
 * `{{unsubscribe}}` resolves to a ready-made `<a href="…">Unsubscribe</a>` built by
 * the dispatcher from the recipient's signed token. Escaping it would print the
 * anchor as text in every marketing email — and a message with no working
 * unsubscribe link is a compliance problem, not a cosmetic one. It is trusted
 * because nothing outside our own code can set it: profile attributes land in the
 * `customer.*` namespace and a per-send payload cannot claim a bare key.
 */
export const SYSTEM_HTML_MERGE_KEYS: ReadonlySet<string> = new Set(['unsubscribe']);

/**
 * Render `{{token}}` into an HTML sink, ESCAPING every substituted value.
 *
 * This exists as its own function rather than a flag on `renderExpression`
 * because most of that function's callers must NOT escape — a subject line, a To
 * address, an SMS body and a profile-attribute write would each end up carrying a
 * literal `&amp;`. Separate functions make the non-HTML callers safe by
 * construction instead of by a correctly-passed argument.
 *
 * `{{{token}}}` writes the value RAW, for the deliberate case of a value that
 * carries a designed HTML block. The triple form leads the alternation so a raw
 * substitution is never re-scanned by the escaping form — running a second pass
 * over the output of the raw pass would be an injection we inflicted on ourselves.
 *
 * `onUnknown` preserves each caller's existing behaviour for a token with no
 * value: the dispatcher leaves the literal `{{token}}` in place (`'keep'`), the
 * transactional path renders nothing (`'empty'`). Unifying them would change mail
 * that is already going out.
 */
export function renderExpressionHtml(
  template: string,
  merge: Readonly<Record<string, string>>,
  onUnknown: 'empty' | 'keep' = 'empty',
  rawKeys: ReadonlySet<string> = SYSTEM_HTML_MERGE_KEYS,
): string {
  return template.replace(
    /\{\{\{\s*([\w.]+)\s*\}\}\}|\{\{\s*([\w.]+)\s*\}\}/g,
    (match: string, rawKey: string | undefined, escKey: string | undefined) => {
      const key = rawKey ?? escKey ?? '';
      const value = merge[expandCustomerToken(key)] ?? merge[key];
      if (value === undefined) return onUnknown === 'keep' ? match : '';
      return rawKey === undefined && !rawKeys.has(key) ? escapeHtmlValue(value) : value;
    },
  );
}

/** Link schemes an email body may carry. Everything else is dropped. */
const SAFE_HREF_SCHEMES = new Set(['http', 'https', 'mailto', 'tel']);

/**
 * Drop any `href` whose scheme is not one an email may use.
 *
 * Entity-escaping a merge value is not enough on its own: a token whose VALUE is a
 * URL sits inside the quotes already — `<a href="{{data.link}}">` with
 * `javascript:…` or `data:text/html,…` needs no HTML-significant character to
 * work, and some clients still honour it. So this runs on the FINAL rendered HTML,
 * after substitution; running it on the template (where the tracking rewrite runs)
 * would only ever see the unresolved `{{token}}`.
 *
 * A schemeless href — relative, or a `#fragment` — is left alone; it cannot
 * execute. The attribute is REMOVED rather than pointed somewhere harmless, so the
 * anchor text still renders and nothing is clickable.
 */
export function sanitizeHrefSchemes(html: string): string {
  return html.replace(/\bhref\s*=\s*(["'])([^"']*)\1/gi, (match, _q: string, value: string) => {
    // Clients ignore control characters and whitespace inside a scheme, so
    // `java\tscript:` runs. Normalize before deciding, and decide on the original.
    // eslint-disable-next-line no-control-regex
    const normalized = value.replace(/[\s\x00-\x1F\x7F]/g, '').toLowerCase();
    const scheme = /^([a-z][a-z0-9+.-]*):/.exec(normalized)?.[1];
    if (!scheme || SAFE_HREF_SCHEMES.has(scheme)) return match;
    return '';
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
  // validator (validateAutomationDefinition) rejects it before persistence. Defensive
  // here: treat an unknown spec object as null rather than throw at runner time.
  if (isSpecObject(spec)) return null;
  // Legacy bare scalar — the original static value shape — is an implicit literal.
  return spec;
}
