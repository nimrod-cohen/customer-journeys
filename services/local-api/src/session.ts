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
 * The DEV_USERS fixture (admin@journeys.dev / owner@acme.com / …) is a DEVELOPMENT
 * convenience — its emails+passwords are PUBLIC in the source, so it MUST be inert
 * in production (otherwise anyone could sign in as the seeded platform admin).
 * Gated on NODE_ENV: enabled in dev + tests, disabled in the deployed prod image
 * (Dockerfile sets NODE_ENV=production). Real registered users (password_hash in
 * the DB) authenticate on every environment, unaffected by this gate.
 */
export function devAuthEnabled(): boolean {
  return process.env.NODE_ENV !== 'production';
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
    // Only consult the seeded fixture outside production (public creds — inv.7).
    const devUser = devAuthEnabled() ? findDevUser(email, password) : null;
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

  // A non-platform-admin with no active workspace is one of two cases:
  //  - a COMPANY OWNER who has registered but not yet created a workspace →
  //    log them in to the "create your first workspace" state (needs_workspace),
  //  - anyone else → genuinely no access, reject (don't mint a token that lands
  //    on an empty dashboard).
  if (active === null && !isPlatformAdmin) {
    const owned = await pool.query<{ id: string; name: string; email: string | null; user_name: string | null }>(
      `SELECT c.id, c.name, u.email, u.name AS user_name
         FROM companies c JOIN users u ON u.id = c.owner_user_id
        WHERE c.owner_user_id = $1
        LIMIT 1`,
      [sub],
    );
    if (owned.rows[0]) {
      const co = owned.rows[0];
      const token = encodeDevToken({ sub, workspace_id: null });
      return {
        status: 200,
        body: {
          token,
          sub,
          workspace_id: null,
          is_platform_admin: false,
          memberships: [],
          needs_workspace: true,
          company: { id: co.id, name: co.name },
          email: co.email,
          name: co.user_name,
        },
      };
    }
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
 * POST /auth/register — self-service company-owner signup. Creates a COMPANY and
 * the owner user (with a hashed local credential) and records them as the
 * company's owner — but deliberately does NOT create a workspace. A company and a
 * workspace are distinct concepts (a company may own several workspaces), so the
 * owner creates their first workspace manually afterwards (POST /workspace/bootstrap,
 * surfaced as the "create your first workspace" screen). The minted token is
 * logged in but workspace-less (`needs_workspace`). Pre-auth, like dev-login.
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

  // Email must be free — across the registered users, and (dev/test only) the
  // seeded fixture. In production the fixture is inert, so its emails are normal.
  if (devAuthEnabled() && DEV_USERS.some((u) => u.email.toLowerCase() === email.toLowerCase())) {
    return { status: 409, body: { error: 'that email is already registered' } };
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // The owner user first (the company references it), then the company tagged
    // with that owner. No workspace, no workspace_users — that comes later.
    const userId = randomUUID();
    await client.query(
      'INSERT INTO users (id, name, email, password_hash) VALUES ($1, $2, $3, $4)',
      [userId, name || null, email, hashPassword(password)],
    );
    const company = await client.query<{ id: string }>(
      'INSERT INTO companies (name, owner_user_id) VALUES ($1, $2) RETURNING id',
      [companyName, userId],
    );
    const companyId = company.rows[0]!.id;
    await client.query('COMMIT');
    const token = encodeDevToken({ sub: userId, workspace_id: null });
    return {
      status: 201,
      body: {
        token,
        sub: userId,
        workspace_id: null,
        is_platform_admin: false,
        memberships: [],
        needs_workspace: true,
        company: { id: companyId, name: companyName },
        email,
        name: name || null,
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
 * POST /workspace/bootstrap — a company OWNER creates a workspace in the company
 * they own and is logged into it. This is the only way to create the FIRST
 * workspace: a workspace-less non-admin token is rejected by the strict authorizer
 * (so it can't reach the capability-gated POST /workspaces), hence — like
 * dev-login/switch — this is a session route that authenticates the token directly
 * and re-mints it with the new active workspace.
 *
 * The target company is NEVER client-supplied (inv.2): it is resolved server-side
 * from `companies.owner_user_id = <token sub>`. The creator becomes its owner.
 */
export async function createFirstWorkspace(
  pool: Pool,
  authorization: string | null,
  body: unknown,
): Promise<SessionResult> {
  const bearer = extractBearer(authorization);
  const jwt = bearer ? decodeDevToken(bearer) : null;
  if (!jwt) return { status: 401, body: { error: 'invalid token' } };

  const b = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  const name = String(b.name ?? '').trim();
  if (!name) return { status: 400, body: { error: 'workspace name is required' } };

  const owned = await pool.query<{ id: string }>(
    'SELECT id FROM companies WHERE owner_user_id = $1 LIMIT 1',
    [jwt.sub],
  );
  const companyId = owned.rows[0]?.id;
  if (!companyId) {
    return { status: 403, body: { error: 'no company to add a workspace to' } };
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const ws = await client.query<{ id: string; name: string }>(
      "INSERT INTO workspaces (name, status, company_id) VALUES ($1, 'active', $2) RETURNING id, name",
      [name, companyId],
    );
    const wsId = ws.rows[0]!.id;
    await client.query(
      "INSERT INTO workspace_users (workspace_id, user_id, role) VALUES ($1, $2, 'owner') ON CONFLICT DO NOTHING",
      [wsId, jwt.sub],
    );
    await client.query('COMMIT');
    const token = encodeDevToken({ sub: jwt.sub, workspace_id: wsId });
    return {
      status: 201,
      body: {
        token,
        sub: jwt.sub,
        workspace_id: wsId,
        is_platform_admin: false,
        memberships: [{ workspaceId: wsId, role: 'owner', name: ws.rows[0]!.name }],
      },
    };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
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
