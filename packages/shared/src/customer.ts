// The `customer.*` personalization / segment-field namespace (§8, §11).
//
// ONE canonical rule, used systemwide (segment compiler + email dispatcher) so
// the shorthand means the same thing everywhere:
//
//   customer.email | customer.external_id | customer.email_status
//   | customer.created_at                       → the matching `profiles` column
//   customer.attributes.<key>                   → the custom attribute <key>
//   customer.<key>  (any non-reserved <key>)    → SHORTHAND for customer.attributes.<key>
//
// So `{{customer.tier}}` ≡ `{{customer.attributes.tier}}`, and in a segment rule
// `customer.tier` ≡ `attributes.tier`.

import { stringifyMergeValue } from './merge-util.js';

/** Top-level `profiles` columns addressable as `customer.<field>` (NOT attributes). */
export const RESERVED_CUSTOMER_FIELDS = ['id', 'email', 'external_id', 'email_status', 'created_at'] as const;
export type ReservedCustomerField = (typeof RESERVED_CUSTOMER_FIELDS)[number];

/** The namespace prefix and the explicit attributes sub-path. */
export const CUSTOMER_PREFIX = 'customer.';
const ATTRIBUTES_PREFIX = 'attributes.';

function isReserved(field: string): field is ReservedCustomerField {
  return (RESERVED_CUSTOMER_FIELDS as readonly string[]).includes(field);
}

/**
 * Expand the shorthand on the path AFTER `customer.`. Returns the canonical path:
 *   'attributes.tier' → 'attributes.tier'  (already explicit)
 *   'email'           → 'email'            (reserved column)
 *   'tier'            → 'attributes.tier'  (shorthand → attribute)
 * A non-reserved path that isn't already `attributes.*` becomes an attribute —
 * including dotted keys ('a.b' → 'attributes.a.b').
 */
export function expandCustomerPath(pathAfterCustomer: string): string {
  const p = pathAfterCustomer.trim();
  if (p.startsWith(ATTRIBUTES_PREFIX)) return p;
  if (isReserved(p)) return p;
  return ATTRIBUTES_PREFIX + p;
}

/**
 * Normalize a full token. A `customer.*` token gets its shorthand expanded
 * (`customer.tier` → `customer.attributes.tier`); any other token is returned
 * unchanged. Used by the email renderer to look up the canonical merge key.
 */
export function expandCustomerToken(token: string): string {
  const t = token.trim();
  if (!t.startsWith(CUSTOMER_PREFIX)) return t;
  const rest = t.slice(CUSTOMER_PREFIX.length);
  if (rest.length === 0) return t;
  return CUSTOMER_PREFIX + expandCustomerPath(rest);
}

/**
 * If `field` is a `customer.*` segment field, return the canonical field name the
 * compiler already understands (`email` / `attributes.<key>`); otherwise return
 * it unchanged (legacy `attributes.*` / `features.*` / scalar names still work).
 */
export function resolveCustomerField(field: string): string {
  if (typeof field !== 'string' || !field.startsWith(CUSTOMER_PREFIX)) return field;
  const rest = field.slice(CUSTOMER_PREFIX.length);
  if (rest.length === 0) return field; // bare 'customer.' is not a field
  return expandCustomerPath(rest);
}

/** A profile shape for building merge values (only the fields we personalize). */
export interface CustomerProfile {
  readonly id?: string | null;
  readonly email?: string | null;
  readonly external_id?: string | null;
  readonly email_status?: string | null;
  readonly created_at?: string | Date | null;
  readonly attributes?: Record<string, unknown> | null;
}

/**
 * Build the merge map for the `customer.*` namespace from a profile. Keys are
 * FULL tokens (`customer.email`, `customer.attributes.tier`); values are
 * stringified scalars. Nested/object attribute values are skipped (not directly
 * substitutable into a single merge tag). Pairs with `expandCustomerToken` in the
 * renderer so both `{{customer.tier}}` and `{{customer.attributes.tier}}` resolve.
 */
export function customerMerge(profile: CustomerProfile): Record<string, string> {
  const out: Record<string, string> = {};
  const rec = profile as Record<string, unknown>;
  for (const f of RESERVED_CUSTOMER_FIELDS) {
    const v = rec[f];
    if (v !== undefined && v !== null) out[`${CUSTOMER_PREFIX}${f}`] = stringifyMergeValue(v);
  }
  const attrs = profile.attributes ?? {};
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null) continue;
    if (typeof v === 'object') continue; // arrays/objects aren't single-tag substitutable
    out[`${CUSTOMER_PREFIX}${ATTRIBUTES_PREFIX}${k}`] = stringifyMergeValue(v);
  }
  return out;
}
