// NODE-ONLY JavaScript sandbox — `@cdp/shared/js-sandbox`, a separate entry point
// that the web bundle never imports (it needs `node:vm`). The package root stays
// isomorphic.
//
// Two users:
//   - `{{ return … }}` blocks in message text (subject, body, To, SMS/WhatsApp) —
//     `makeTemplateJs` builds the runner the renderers call;
//   - update-profile JS values (`evaluateJsValue` in the automation runner).
//
// SAFE-SANDBOX RECIPE (security-critical; the authors are marketers and AI tools
// holding an MCP token, and the code runs on our servers):
//   1. The data (`customer`, `event`, `journey`, `data`) crosses as JSON STRINGS and
//      is parsed INSIDE the context, so every object is context-native — defeating
//      the realm escape through a host object's prototype chain
//      (`customer.constructor.constructor('return process')()`).
//   2. The context is `vm.createContext(Object.create(null))` — EMPTY: no process,
//      require, Buffer, fetch or global. Only the context's own intrinsics exist.
//   3. A strict IIFE wraps the code; `vm.runInContext` has a 100 ms timeout.
//   4. The result is coerced to a string INSIDE the context, under the timeout, so a
//      returned object with a looping or throwing toString is bounded too. Only a
//      string primitive crosses back.
//   5. ANY throw, timeout or escape attempt → '' (safe-empty). Never thrown to a send.
// Node documents `vm` as not a hard security boundary; this is the same trade-off
// the update-profile JS values already make (decided 2026-11-18).
import vm from 'node:vm';
import type { TemplateJs } from './expression.js';
import { RESERVED_CUSTOMER_FIELDS, type CustomerProfile } from './customer.js';

/** The variables a snippet sees. Absent ones are `{}`. */
export interface JsVars {
  readonly customer?: unknown;
  readonly event?: unknown;
  readonly journey?: unknown;
  readonly data?: unknown;
}

const TIMEOUT_MS = 100;

/**
 * Code that already timed out once is not run again in this process: a broadcast
 * would otherwise spend the full timeout on EVERY recipient for the same loop.
 */
const timedOut = new Set<string>();
const TIMED_OUT_CAP = 500;

/** Whether the snippet has a `return` statement (vs a bare expression). */
const RETURN_RE = /\breturn\b/;

function asJsonObject(v: unknown): unknown {
  return v === undefined || v === null ? {} : v;
}

/**
 * Run `code` in a fresh empty sandbox with the given variables. Returns a string —
 * '' for undefined/null, an error, a timeout or an escape attempt. Never throws.
 */
export function runSandboxedJs(code: string, vars: JsVars): string {
  if (typeof code !== 'string' || timedOut.has(code)) return '';
  try {
    const decl = (['customer', 'event', 'journey', 'data'] as const)
      .map((k) => `const ${k}=JSON.parse(${JSON.stringify(JSON.stringify(asJsonObject(vars[k])))});`)
      .join('');
    const body = RETURN_RE.test(code) ? code : `return (${code});`;
    const src =
      `"use strict";(function(){${decl}` +
      `const __v=(function(){${body}\n})();` +
      `return (__v===undefined||__v===null)?'':String(__v);` +
      `})()`;
    const context = vm.createContext(Object.create(null) as object);
    const result = vm.runInContext(src, context, { timeout: TIMEOUT_MS, displayErrors: false });
    return typeof result === 'string' ? result : '';
  } catch (e) {
    if (e && typeof e === 'object' && (e as { code?: unknown }).code === 'ERR_SCRIPT_EXECUTION_TIMEOUT') {
      if (timedOut.size >= TIMED_OUT_CAP) timedOut.clear();
      timedOut.add(code);
    }
    return '';
  }
}

/** The runner the renderers call for each `{{ return … }}` block of ONE message. */
export function makeTemplateJs(vars: JsVars): TemplateJs {
  return (code: string) => runSandboxedJs(code, vars);
}

/**
 * The `customer` object a snippet sees: `{ ...attributes, ...core fields, attributes }`,
 * so `customer.first_name` (an attribute), `customer.email` (a core field) and
 * `customer.attributes.x` all work — the same shorthand as `{{customer.x}}`. Core
 * fields win over an attribute of the same name; `email`/`phone` fall back to their
 * legacy attribute spelling when the column is empty.
 */
export function customerJsObject(profile: CustomerProfile | Record<string, unknown>): Record<string, unknown> {
  const rec = profile as Record<string, unknown>;
  const attributes = (rec.attributes && typeof rec.attributes === 'object' ? rec.attributes : {}) as Record<string, unknown>;
  const out: Record<string, unknown> = { ...attributes };
  for (const f of RESERVED_CUSTOMER_FIELDS) {
    const v = rec[f];
    if (v !== undefined && v !== null && v !== '') out[f] = v instanceof Date ? v.toISOString() : v;
  }
  out.attributes = attributes;
  return out;
}

/**
 * Rebuild `event` / `journey` / `data` / `customer` objects from a FLAT merge map
 * (`event.items.0.sku` → `event.items[0].sku`). Values stay strings. Used only where
 * the structured source is not at hand — e.g. an outbox row queued before the
 * runner started carrying it.
 */
export function varsFromMerge(merge: Readonly<Record<string, string>>): {
  customer: unknown;
  event: unknown;
  journey: unknown;
  data: unknown;
} {
  const roots: Record<string, Record<string, unknown>> = { customer: {}, event: {}, journey: {}, data: {} };
  for (const [key, value] of Object.entries(merge)) {
    const parts = key.split('.');
    const root = roots[parts[0]!];
    if (!root || parts.length < 2) continue;
    let node: Record<string, unknown> = root;
    for (let i = 1; i < parts.length - 1; i++) {
      const p = parts[i]!;
      if (p === '__proto__' || p === 'constructor' || p === 'prototype') break;
      const next = node[p];
      if (!next || typeof next !== 'object') node[p] = {};
      node = node[p] as Record<string, unknown>;
    }
    const leaf = parts[parts.length - 1]!;
    if (leaf !== '__proto__' && leaf !== 'constructor' && leaf !== 'prototype') node[leaf] = value;
  }
  const arrayify = (v: unknown): unknown => {
    if (!v || typeof v !== 'object') return v;
    const o = v as Record<string, unknown>;
    const keys = Object.keys(o);
    for (const k of keys) o[k] = arrayify(o[k]);
    const isArray = keys.length > 0 && keys.every((k, i) => k === String(i));
    return isArray ? keys.map((k) => o[k]) : o;
  };
  return {
    customer: arrayify(roots.customer),
    event: arrayify(roots.event),
    journey: arrayify(roots.journey),
    data: arrayify(roots.data),
  };
}
