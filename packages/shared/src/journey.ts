// The `journey.*` personalization namespace — per-enrollment variables that
// live on `campaign_enrollments.state.journey` for the duration of THIS profile's
// run through THIS campaign. Written by a `set_journey` action node; read in
// merge tags ({{journey.<key>}}) and in set_attribute / set_journey expressions.
//
// Keys are FREEFORM (no campaign-level schema): a `set_journey` simply writes the
// keys the admin types; reads to a missing key resolve to undefined → safe-empty
// in the renderer. The structural twin of `event.*` and `customer.*` (read-only
// string substitution at render time; never interpolated into SQL).

/** The namespace prefix for a `journey.*` token. */
export const JOURNEY_PREFIX = 'journey.';

/**
 * Deep-dot resolver into the journey state map (`enrollment.state.journey`).
 * Walks `pathAfterJourney` (e.g. `cohort`, `meta.score`) into `vars`, descending
 * objects AND arrays (numeric segments index into arrays). Returns the leaf
 * value or `undefined` for any missing/unreachable segment. Never throws.
 */
export function resolveJourneyPath(vars: unknown, pathAfterJourney: string): unknown {
  if (vars === undefined || vars === null) return undefined;
  const segments = pathAfterJourney.split('.').map((s) => s.trim()).filter((s) => s.length > 0);
  if (segments.length === 0) return undefined;
  let cur: unknown = vars;
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
    return undefined;
  }
  return cur;
}

/**
 * Normalize a full `journey.*` token. Returned unchanged (kept for symmetry
 * with `expandCustomerToken` / `expandEventToken` so the renderer treats every
 * namespace the same way).
 */
export function expandJourneyToken(token: string): string {
  return token.trim();
}

/**
 * Build the merge map for the `journey.*` namespace from a per-enrollment
 * journey-vars object. Keys are FULL tokens (`journey.cohort`, `journey.meta.0`);
 * values are stringified scalars. Walks the object recursively so deep dotted
 * leaf paths are directly substitutable into a single merge tag. An absent /
 * empty object yields `{}` (a `{{journey.X}}` to a missing key renders empty).
 */
export function journeyMerge(vars: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (vars === undefined || vars === null || typeof vars !== 'object') return out;
  walk(vars as Record<string, unknown> | unknown[], JOURNEY_PREFIX, out);
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
