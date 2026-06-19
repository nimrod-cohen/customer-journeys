// The `event.*` personalization namespace — the structural TWIN of `customer.*`
// (customer.ts), for referencing the TRIGGER EVENT payload that enrolled a profile
// into a campaign (§9B). It is used ONLY in the set_attribute value resolver
// (resolveValueSpec) so an update-profile step can copy a value FROM the event
// that started the journey, e.g. `attributes.last_purchase_amount = {{event.amount}}`.
//
//   event.<path>   → the leaf at <path> in the persisted enrollment.state.event
//                    payload (deep-dot, array indices supported: `items.0.sku`).
//
// The payload is persisted at enroll time (campaign_enrollments.state.event); it is
// already a trusted, closed-grammar object (the §8 payload filter ran against it).
// Resolution here is READ-ONLY string substitution — NEVER interpolated into SQL
// (invariant 6 untouched). A missing path resolves to undefined → safe-empty in the
// renderer.

/** The namespace prefix for an `event.*` token. */
export const EVENT_PREFIX = 'event.';

/**
 * Deep-dot resolver into the event payload (analogous to a customer path lookup).
 * Walks `pathAfterEvent` (e.g. `amount`, `items.0.sku`) into `payload`, descending
 * objects AND arrays (numeric segments index into arrays). Returns the leaf value
 * or `undefined` for any missing/unreachable segment. Never throws.
 */
export function resolveEventPath(payload: unknown, pathAfterEvent: string): unknown {
  if (payload === undefined || payload === null) return undefined;
  const segments = pathAfterEvent.split('.').map((s) => s.trim()).filter((s) => s.length > 0);
  if (segments.length === 0) return undefined;
  let cur: unknown = payload;
  for (const seg of segments) {
    if (cur === undefined || cur === null) return undefined;
    if (Array.isArray(cur)) {
      const idx = Number(seg);
      if (!Number.isInteger(idx) || idx < 0 || idx >= cur.length) return undefined;
      cur = cur[idx];
      continue;
    }
    if (typeof cur === 'object') {
      cur = (cur as Record<string, unknown>)[seg];
      continue;
    }
    return undefined; // a scalar can't be descended further
  }
  return cur;
}

/**
 * Normalize a full `event.*` token. There is no shorthand to expand (kept for
 * symmetry with expandCustomerToken so the renderer treats both namespaces the
 * same way) — an `event.*` token is returned unchanged, any other token too.
 */
export function expandEventToken(token: string): string {
  return token.trim();
}

/**
 * Build the merge map for the `event.*` namespace from a persisted trigger event
 * payload. Keys are FULL tokens (`event.amount`, `event.items.0.sku`); values are
 * stringified scalars. Walks the payload recursively so DEEP dotted leaf paths are
 * directly substitutable into a single merge tag (parity with customerMerge, which
 * flattens attributes). Objects/arrays are descended (their SCALAR leaves emitted);
 * a whole object/array is never emitted as one tag (not single-tag substitutable).
 * An undefined/null payload yields an empty map (the manual/segment enrollment case,
 * where state.event is absent → an event.* expression resolves safe-empty).
 */
export function eventMerge(payload: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (payload === undefined || payload === null || typeof payload !== 'object') return out;
  walk(payload as Record<string, unknown> | unknown[], EVENT_PREFIX, out);
  return out;
}

function walk(node: Record<string, unknown> | unknown[], prefix: string, out: Record<string, string>): void {
  const entries: [string, unknown][] = Array.isArray(node)
    ? node.map((v, i) => [String(i), v])
    : Object.entries(node);
  for (const [k, v] of entries) {
    if (v === undefined || v === null) continue;
    const token = `${prefix}${k}`;
    if (typeof v === 'object') {
      walk(v as Record<string, unknown> | unknown[], `${token}.`, out);
    } else {
      out[token] = stringify(v);
    }
  }
}

function stringify(v: unknown): string {
  if (v instanceof Date) return v.toISOString();
  return String(v);
}
