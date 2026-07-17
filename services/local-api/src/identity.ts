// Profile identity — a profile is identified by email and/or phone (both core, reserved
// fields). Each alone is optional; at least one is required. Phones are normalized to E.164
// with the workspace's default country. Rules (product):
//   - a bad phone is DROPPED when a valid email is present, but a phone-only record with an
//     un-normalizable number is REJECTED (no reliable identity).
//   - "prefer email, don't steal the phone": when both are present the email is the primary
//     key; a phone is attached only if it isn't already owned by another profile.
import type { Pool, PoolClient } from 'pg';
import { normalizePhone } from '@cdp/channels';
import { RESERVED_CUSTOMER_FIELDS } from '@cdp/shared';

/** Drop reserved core-field keys (email/phone/…) from a dynamic-attributes object — they
 *  are core columns, never dynamic attributes. Keeps everything else untouched. */
export function stripReservedAttributes(attrs: Record<string, unknown>): Record<string, unknown> {
  const reserved = RESERVED_CUSTOMER_FIELDS as readonly string[];
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(attrs)) {
    if (!reserved.includes(k)) out[k] = v;
  }
  return out;
}

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

type Queryable = Pool | PoolClient;

/** The workspace's default phone country (ISO-2, uppercased) for national-number parsing. */
export async function defaultPhoneCountry(db: Queryable, workspaceId: string): Promise<string | null> {
  const { rows } = await db.query<{ v: string | null }>(
    "SELECT settings->>'default_phone_country' AS v FROM workspaces WHERE id = $1",
    [workspaceId],
  );
  const v = rows[0]?.v;
  return typeof v === 'string' && /^[A-Za-z]{2}$/.test(v) ? v.toUpperCase() : null;
}

export interface IdentityInput {
  email?: unknown;
  phone?: unknown;
}
export interface ResolvedIdentity {
  email: string | null;
  phone: string | null;
}
export type IdentityResult =
  | { ok: true; identity: ResolvedIdentity }
  | { ok: false; status: number; error: string };

/**
 * Validate + normalize an identity input. `emailPolicy` applies the workspace lowercase
 * policy (already resolved by the caller). Pure — no I/O.
 */
export function resolveIdentity(
  input: IdentityInput,
  opts: { defaultCountry: string | null; emailPolicy: (e: string) => string },
): IdentityResult {
  const rawEmail = typeof input.email === 'string' ? input.email.trim() : '';
  const email = rawEmail ? opts.emailPolicy(rawEmail) : null;
  if (email && !EMAIL_RE.test(email)) return { ok: false, status: 400, error: 'a valid email address is required' };

  const rawPhone = typeof input.phone === 'string' ? input.phone.trim() : '';
  let phone: string | null = null;
  if (rawPhone) {
    phone = normalizePhone(rawPhone, opts.defaultCountry);
    if (!phone && !email) {
      // phone-only record with an un-normalizable number → reject outright.
      return { ok: false, status: 400, error: 'a valid phone number is required (or provide an email)' };
    }
    // invalid phone + a valid email → phone is dropped (stays null), record kept.
  }

  if (!email && !phone) return { ok: false, status: 400, error: 'an email or phone number is required' };
  return { ok: true, identity: { email, phone } };
}

/** The profile id that currently owns `phone` in this workspace (or null). */
export async function phoneOwner(db: Queryable, workspaceId: string, phone: string): Promise<string | null> {
  const { rows } = await db.query<{ id: string }>(
    'SELECT id FROM profiles WHERE workspace_id = $1 AND phone = $2 LIMIT 1',
    [workspaceId, phone],
  );
  return rows[0]?.id ?? null;
}

/** The profile id that currently owns `email` in this workspace (or null). */
export async function emailOwner(db: Queryable, workspaceId: string, email: string): Promise<string | null> {
  const { rows } = await db.query<{ id: string }>(
    'SELECT id FROM profiles WHERE workspace_id = $1 AND email = $2 LIMIT 1',
    [workspaceId, email],
  );
  return rows[0]?.id ?? null;
}
