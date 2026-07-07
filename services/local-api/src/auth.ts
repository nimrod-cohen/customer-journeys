// Local dev authorizer (§12). Mirrors services/authorizer logic but for local
// development: a DEV JWT is a base64url-encoded JSON payload (no signature — this
// is a local/dev + e2e harness only; the spec permits "Mock/local auth is fine
// for e2e as long as the token carries active workspace_id + role"). The local
// authorizer:
//   1. decodes the dev token → { sub, workspace_id },
//   2. loads memberships + platform_admins from REAL Postgres,
//   3. runs the SAME pure authorize() core the production authorizer uses,
//   4. produces the SAME string context shape API Gateway injects
//      (sub, workspace_id, role, is_platform_admin) — read downstream via
//      contextFromAuthorizer().
//
// workspace_id ALWAYS comes from the token (the active-workspace claim), never
// from a request body (CLAUDE.md inv.2).
import { authorize, buildAuthorizerPolicy, type DecodedJwt } from '@cdp/service-authorizer';
import type { CompanyMembership, Membership } from '@cdp/shared';
import { createHmac, timingSafeEqual } from 'node:crypto';

/** The authorizer-injected request context (string values), as API GW produces. */
export interface AuthorizerContext {
  readonly sub: string;
  readonly workspace_id: string;
  readonly company_id?: string;
  readonly is_platform_admin: string; // 'true' | 'false'
  readonly role?: string;
  readonly effective_role?: string;
}

/** A decoded dev token payload. */
export interface DevTokenPayload {
  readonly sub: string;
  /** The ACTIVE workspace id claim (set at login / switch). May be null. */
  readonly workspace_id: string | null;
}

// The session token is HMAC-SIGNED (`<base64url(payload)>.<base64url(sig)>`), so a
// client CANNOT forge or alter (sub, workspace_id) without the secret. This is the
// authentication boundary for the containerized API — an unsigned token here would
// let anyone impersonate any user in any workspace.

/** A well-known dev/test fallback for the signing secret — NOT a real secret. */
const DEV_SESSION_SECRET = 'dev-session-secret-do-not-use-in-prod';

/** Resolve the HMAC signing secret. Fail-fast in production (mirrors the other
 *  prod secrets): a missing secret must never fall back to the public dev value. */
function sessionSecret(): string {
  const env = process.env.SESSION_JWT_SECRET;
  if (env) return env;
  if (process.env.NODE_ENV === 'production') {
    throw new Error('SESSION_JWT_SECRET must be set in production (refusing the dev fallback).');
  }
  return DEV_SESSION_SECRET;
}

/** Session lifetime — 30 days, after which the token is rejected (re-login). */
const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;

function signPart(encoded: string): string {
  return createHmac('sha256', sessionSecret()).update(encoded).digest('base64url');
}

/** Encode a SIGNED session token: base64url(payload incl. iat/exp) + '.' + HMAC. */
export function encodeDevToken(payload: DevTokenPayload): string {
  const now = Math.floor(Date.now() / 1000);
  const body = { ...payload, iat: now, exp: now + SESSION_TTL_SECONDS };
  const encoded = Buffer.from(JSON.stringify(body), 'utf8').toString('base64url');
  return `${encoded}.${signPart(encoded)}`;
}

/**
 * Verify + decode a session token. Returns null when the signature is missing/
 * invalid (a forged or tampered token) or the token has expired. Constant-time
 * signature comparison.
 */
export function decodeDevToken(token: string): DecodedJwt | null {
  try {
    const dot = token.lastIndexOf('.');
    if (dot <= 0) return null;
    const encoded = token.slice(0, dot);
    const sig = Buffer.from(token.slice(dot + 1));
    const expected = Buffer.from(signPart(encoded));
    if (sig.length !== expected.length || !timingSafeEqual(sig, expected)) return null;
    const obj = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as Record<string, unknown>;
    if (typeof obj.exp === 'number' && obj.exp * 1000 < Date.now()) return null;
    const sub = typeof obj.sub === 'string' ? obj.sub : '';
    if (!sub) return null;
    const ws = obj.workspace_id;
    const workspace_id = typeof ws === 'string' && ws.length > 0 ? ws : null;
    return { sub, workspace_id };
  } catch {
    return null;
  }
}

/** Extract a bearer token from an Authorization header value. */
export function extractBearer(header: string | undefined | null): string | null {
  if (!header) return null;
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  return m && m[1] ? m[1] : null;
}

/** The DB lookups the local authorizer needs (injected for testability). */
export interface AuthorizerLookups {
  /** The user's COMPANY membership (company-centric RBAC), or null if none. */
  loadCompany(userId: string): Promise<CompanyMembership | null>;
  /** The workspaces the user may ACT in (owner→all, marketer→grants, accounting→none). */
  loadMemberships(userId: string): Promise<readonly Membership[]>;
  loadIsPlatformAdmin(userId: string): Promise<boolean>;
}

/** The outcome of running the local authorizer over a request. */
export type LocalAuthResult =
  | { readonly ok: true; readonly context: AuthorizerContext }
  | { readonly ok: false; readonly status: 401 | 403; readonly reason: string };

/**
 * Run the local authorizer over a bearer token: decode → load membership +
 * platform-admin from PG → authorize() (the production pure core) → produce the
 * API-Gateway-shaped string context. A missing/garbage token is 401; an
 * authenticated-but-denied result (e.g. active workspace not a membership) is 403.
 */
export async function runLocalAuthorizer(
  bearer: string | null,
  lookups: AuthorizerLookups,
): Promise<LocalAuthResult> {
  if (!bearer) return { ok: false, status: 401, reason: 'missing token' };
  const jwt = decodeDevToken(bearer);
  if (!jwt) return { ok: false, status: 401, reason: 'invalid token' };

  const [company, memberships, isPlatformAdmin] = await Promise.all([
    lookups.loadCompany(jwt.sub),
    lookups.loadMemberships(jwt.sub),
    lookups.loadIsPlatformAdmin(jwt.sub),
  ]);

  const result = authorize(jwt, memberships, isPlatformAdmin, company);
  if (!result.allowed) {
    return { ok: false, status: 403, reason: result.reason ?? 'forbidden' };
  }

  // Reuse the production policy builder to get the EXACT context shape API GW
  // injects (string values: sub, workspace_id, is_platform_admin, role, ...).
  const policy = buildAuthorizerPolicy(result);
  const ctx = policy.context;
  const context: AuthorizerContext = {
    sub: ctx.sub ?? '',
    workspace_id: ctx.workspace_id ?? '',
    is_platform_admin: ctx.is_platform_admin ?? 'false',
    ...(ctx.company_id !== undefined ? { company_id: ctx.company_id } : {}),
    ...(ctx.role !== undefined ? { role: ctx.role } : {}),
    ...(ctx.effective_role !== undefined ? { effective_role: ctx.effective_role } : {}),
  };
  return { ok: true, context };
}
