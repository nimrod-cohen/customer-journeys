// Dev session endpoints (§12): POST /auth/dev-login and POST /workspace/switch.
// These sit OUTSIDE the capability-enforced route table: dev-login is pre-auth
// (it mints the first token); switch only needs a valid token + membership (or
// platform-admin) and re-issues a token with the new active workspace_id —
// reusing @cdp/tenancy switchActiveWorkspace so the cross-tenant rule is shared.
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { switchActiveWorkspace } from '@cdp/tenancy';
import { findDevUser, DEV_USERS, type Membership } from '@cdp/shared';
import { encodeDevToken, decodeDevToken, extractBearer } from './auth.js';
import type { AuthorizerLookups } from './auth.js';
import { hashPassword, verifyPassword } from './creds.js';

/** Response for dev-login / switch — a bearer token + the resolved session. */
export interface SessionResult {
  readonly status: number;
  readonly body: unknown;
}

/**
 * POST /auth/dev-login — authenticate and mint a dev token whose active
 * workspace_id defaults to the FIRST membership (or a body-provided workspace_id
 * IF the user is a member / platform admin). Two input shapes (a real Supabase
 * login replaces all of this):
 *   - { email, password } — the primary UI path: verified against the DEV_USERS
 *     fixture, resolving to a seeded user id.
 *   - { user_id } / { sub } — direct/e2e path: trust the supplied seeded id.
 * workspace_id in the TOKEN is authoritative thereafter.
 */
export async function devLogin(
  lookups: AuthorizerLookups,
  pool: Pool,
  body: unknown,
): Promise<SessionResult> {
  const b = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};

  // Resolve the subject. Email+password is the primary path: try the seeded
  // DEV_USERS fixture first, then the registered users in the DB (migration 0031).
  // user_id/sub remains for the direct/e2e path.
  let sub = '';
  if (typeof b.email === 'string') {
    const email = b.email.trim();
    const password = String(b.password ?? '');
    const devUser = findDevUser(email, password);
    if (devUser) {
      sub = devUser.userId;
    } else {
      const { rows } = await pool.query<{ id: string; password_hash: string | null }>(
        'SELECT id, password_hash FROM users WHERE email = $1',
        [email],
      );
      if (!rows[0] || !verifyPassword(password, rows[0].password_hash)) {
        return { status: 401, body: { error: 'invalid email or password' } };
      }
      sub = rows[0].id;
    }
  } else {
    sub = String(b.user_id ?? b.sub ?? '');
  }
  if (!sub) return { status: 400, body: { error: 'email + password required' } };

  const [memberships, isPlatformAdmin] = await Promise.all([
    lookups.loadMemberships(sub),
    lookups.loadIsPlatformAdmin(sub),
  ]);

  // Choose the active workspace: a requested one (must be valid), else the first
  // membership, else null (platform admins may have none).
  const requested = typeof b.workspace_id === 'string' ? b.workspace_id : null;
  let active: string | null = null;
  if (requested) {
    const allowed =
      isPlatformAdmin || memberships.some((m: Membership) => m.workspaceId === requested);
    if (!allowed) {
      return { status: 403, body: { error: 'not a member of requested workspace' } };
    }
    active = requested;
  } else {
    active = memberships[0]?.workspaceId ?? null;
  }

  // A user with NO workspace access and who is NOT a platform admin can't do
  // anything — reject instead of minting a token that lands on an empty
  // dashboard. (Platform admins legitimately have no membership; they pick or
  // create a company.)
  if (active === null && !isPlatformAdmin) {
    return {
      status: 403,
      body: { error: 'This account has no workspace access. Ask an owner to invite you, or register a new company.' },
    };
  }

  const token = encodeDevToken({ sub, workspace_id: active });
  return {
    status: 200,
    body: {
      token,
      sub,
      workspace_id: active,
      is_platform_admin: isPlatformAdmin,
      memberships,
    },
  };
}

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/**
 * POST /auth/register — self-service company-owner signup. Creates a company, a
 * workspace, and the owner user (with a hashed local credential), makes them the
 * workspace owner, and mints a token logged into that workspace. Pre-auth, like
 * dev-login. (Production would do this through Supabase Auth + onboarding.)
 */
export async function registerOwner(pool: Pool, body: unknown): Promise<SessionResult> {
  const b = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  const name = String(b.name ?? '').trim();
  const email = String(b.email ?? '').trim();
  const password = String(b.password ?? '');
  const companyName = String(b.company_name ?? '').trim();

  if (!EMAIL_RE.test(email)) return { status: 400, body: { error: 'a valid email is required' } };
  if (password.length < 8) return { status: 400, body: { error: 'password must be at least 8 characters' } };
  if (!companyName) return { status: 400, body: { error: 'company name is required' } };

  // Email must be free — across BOTH the seeded dev fixture and registered users.
  if (DEV_USERS.some((u) => u.email.toLowerCase() === email.toLowerCase())) {
    return { status: 409, body: { error: 'that email is already registered' } };
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const company = await client.query<{ id: string }>(
      'INSERT INTO companies (name) VALUES ($1) RETURNING id',
      [companyName],
    );
    const companyId = company.rows[0]!.id;
    const ws = await client.query<{ id: string }>(
      "INSERT INTO workspaces (name, status, company_id) VALUES ($1, 'active', $2) RETURNING id",
      [companyName, companyId],
    );
    const wsId = ws.rows[0]!.id;
    const userId = randomUUID();
    await client.query(
      'INSERT INTO users (id, name, email, password_hash) VALUES ($1, $2, $3, $4)',
      [userId, name || null, email, hashPassword(password)],
    );
    await client.query(
      "INSERT INTO workspace_users (workspace_id, user_id, role) VALUES ($1, $2, 'owner')",
      [wsId, userId],
    );
    await client.query('COMMIT');
    const token = encodeDevToken({ sub: userId, workspace_id: wsId });
    return {
      status: 201,
      body: {
        token,
        sub: userId,
        workspace_id: wsId,
        is_platform_admin: false,
        memberships: [{ workspaceId: wsId, role: 'owner' }],
      },
    };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    if ((e as { code?: string }).code === '23505') {
      return { status: 409, body: { error: 'that email is already registered' } };
    }
    throw e;
  } finally {
    client.release();
  }
}

/**
 * POST /workspace/switch — re-issue a token with a new active workspace_id.
 * Reuses tenancy.switchActiveWorkspace so the membership/platform-admin rule is
 * the single source of truth: a normal user can only switch to a workspace they
 * belong to; a platform admin may switch to ANY (the audited cross-tenant break).
 */
export async function switchWorkspace(
  lookups: AuthorizerLookups,
  authorization: string | null,
  body: unknown,
): Promise<SessionResult> {
  const bearer = extractBearer(authorization);
  const jwt = bearer ? decodeDevToken(bearer) : null;
  if (!jwt) return { status: 401, body: { error: 'invalid token' } };

  const b = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  const target = String(b.workspace_id ?? '');
  if (!target) return { status: 400, body: { error: 'workspace_id required' } };

  const [memberships, isPlatformAdmin] = await Promise.all([
    lookups.loadMemberships(jwt.sub),
    lookups.loadIsPlatformAdmin(jwt.sub),
  ]);

  try {
    const wsCtx = switchActiveWorkspace(memberships, target, isPlatformAdmin);
    const token = encodeDevToken({ sub: jwt.sub, workspace_id: wsCtx.workspaceId });
    return {
      status: 200,
      body: {
        token,
        sub: jwt.sub,
        workspace_id: wsCtx.workspaceId,
        role: wsCtx.role ?? null,
        is_platform_admin: isPlatformAdmin,
      },
    };
  } catch {
    return { status: 403, body: { error: 'cannot switch to that workspace' } };
  }
}
