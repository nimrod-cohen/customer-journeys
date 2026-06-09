// Route handlers (§12). Each handler receives the TRUSTED WorkspaceContext (from
// the local authorizer via contextFromAuthorizer) + a pg Pool + the parsed
// request, and:
//   - scopes EVERY DB op to ctx.workspaceId via scopedQuery (workspace_id from
//     the token, NEVER the body — CLAUDE.md inv.2),
//   - delegates to existing cores (segments compiler / manual members / onboarding
//     / broadcast / campaign DSL) rather than re-implementing,
//   - audits system-admin cross-tenant reads via handleAdminAccess →
//     writeAuditEntry.
//
// SES/SQS/DNS are mocked at the boundary (deps injected); Postgres is real.
import type { Pool } from 'pg';
import { DEV_USERS, OPEN_EVENT_TYPES, PURCHASE_EVENT_TYPES, type WorkspaceContext } from '@cdp/shared';
import { scopedQuery } from '@cdp/db';

// Resolve an app user's email from the dev credential fixture (in production this
// is the Supabase user's email). userId → email for display; email → userId for
// add-member. Unknown ids fall back to a short, non-GUID label.
function emailForUser(userId: string | undefined): string {
  const u = DEV_USERS.find((d) => d.userId === userId);
  if (u) return u.email;
  return userId ? `user-${userId.slice(0, 8)}` : 'unknown';
}
function userIdForEmail(email: string): string | null {
  const e = email.trim().toLowerCase();
  return DEV_USERS.find((d) => d.email.toLowerCase() === e)?.userId ?? null;
}
import { handleAdminAccess, writeAuditEntry } from '@cdp/service-api';
import { recordCrossTenantAccess } from '@cdp/tenancy';
import {
  compileWhere,
  validateAst,
  addManualMembers,
  removeManualMembers,
  evaluateRealtimeSegmentsForProfile,
  type AstNode,
} from '@cdp/segments';
import { validateCampaignDefinition } from '@cdp/service-campaign-runner';
import { runBroadcast } from '@cdp/service-broadcast';
import {
  computeCostViewForWorkspaces,
  monthBucket,
  DEFAULT_PRICES,
  type MeteringDeps,
} from '@cdp/service-metering';
import {
  startDomain,
  checkDomain,
  activate,
} from '@cdp/service-onboarding';
import type { LocalApiDeps } from './deps.js';

/** A handler's request shape (already parsed by the server). */
export interface HandlerRequest {
  readonly params: Readonly<Record<string, string>>;
  readonly query: Readonly<Record<string, string>>;
  readonly body: unknown;
}

/** A handler's JSON response. */
export interface HandlerResponse {
  readonly status: number;
  readonly body: unknown;
}

/** The signature every handler implements. */
export type Handler = (
  ctx: WorkspaceContext,
  pool: Pool,
  req: HandlerRequest,
  deps: LocalApiDeps,
) => Promise<HandlerResponse>;

function ok(body: unknown, status = 200): HandlerResponse {
  return { status, body };
}

function asObject(body: unknown): Record<string, unknown> {
  return body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
}

/**
 * Confirm a row with `id` exists in the given table AND belongs to the token's
 * active workspace. Tenant-isolation guard for path-id handlers whose underlying
 * builders/cores don't themselves verify the id belongs to ctx.workspaceId
 * (workspace_id from the TOKEN, never the body — CLAUDE.md inv.2).
 */
async function ownsResource(
  pool: Pool,
  workspaceId: string,
  table: 'segments' | 'broadcasts' | 'campaigns',
  id: string,
): Promise<boolean> {
  const q = scopedQuery(workspaceId, `SELECT 1 FROM ${table} WHERE id = $1`, [id]);
  const { rowCount } = await pool.query(q.text, q.values);
  return (rowCount ?? 0) > 0;
}

// ---------------------------------------------------------------------------
// session / identity
// ---------------------------------------------------------------------------

/** GET /me — the resolved identity + the active workspace + capabilities the UI uses. */
export const getMe: Handler = async (ctx, pool) => {
  // Memberships carry the workspace NAME (joined) so the UI never shows a raw id.
  const { rows } = await pool.query(
    `SELECT wu.workspace_id, wu.role, w.name
       FROM workspace_users wu
       JOIN workspaces w ON w.id = wu.workspace_id
      WHERE wu.user_id = $1
      ORDER BY w.name`,
    [ctx.userId ?? ''],
  );
  // Resolve the ACTIVE workspace's name + its parent company (even when it isn't
  // one of the user's memberships — a platform admin viewing into a company) so
  // the UI can show friendly names, never raw ids.
  let workspaceName: string | null = null;
  let companyId: string | null = null;
  let companyName: string | null = null;
  if (ctx.workspaceId) {
    const wn = await pool.query(
      `SELECT w.name AS wname, w.company_id, c.name AS cname
         FROM workspaces w JOIN companies c ON c.id = w.company_id
        WHERE w.id = $1`,
      [ctx.workspaceId],
    );
    workspaceName = wn.rows[0]?.wname ?? null;
    companyId = wn.rows[0]?.company_id ?? null;
    companyName = wn.rows[0]?.cname ?? null;
  }
  return ok({
    sub: ctx.userId,
    email: emailForUser(ctx.userId),
    workspace_id: ctx.workspaceId || null,
    workspace_name: workspaceName,
    company_id: companyId,
    company_name: companyName,
    role: ctx.role ?? null,
    is_platform_admin: ctx.isPlatformAdmin,
    memberships: rows.map((r) => ({ workspaceId: r.workspace_id, role: r.role, name: r.name })),
  });
};

// ---------------------------------------------------------------------------
// workspace members + roles (manage_workspace_users)
// ---------------------------------------------------------------------------

/** GET /workspace/members — members of the ACTIVE workspace only (scoped). */
export const listMembers: Handler = async (ctx, pool) => {
  const { rows } = await pool.query(
    'SELECT user_id, role, created_at FROM workspace_users WHERE workspace_id = $1 ORDER BY created_at',
    [ctx.workspaceId],
  );
  // Surface the member's EMAIL (resolved) rather than the internal user id.
  return ok({
    members: rows.map((r) => ({ user_id: r.user_id, role: r.role, email: emailForUser(r.user_id) })),
  });
};

/** POST /workspace/members — add a member to the active workspace BY EMAIL. */
export const addMember: Handler = async (ctx, pool, req) => {
  const b = asObject(req.body);
  const role = String(b.role ?? 'marketer');
  // Resolve the member by email (the user-facing identifier); user_id is internal
  // and still accepted as a fallback (e.g. direct/e2e callers).
  const email = typeof b.email === 'string' ? b.email : '';
  const userId = email ? userIdForEmail(email) : String(b.user_id ?? '');
  if (!userId) {
    return ok({ error: email ? `no user with email ${email}` : 'email required' }, 400);
  }
  // A user belongs to ONE company: reject adding them here if they already have a
  // membership in a workspace owned by a DIFFERENT company than this workspace's.
  const conflict = await pool.query(
    `SELECT 1
       FROM workspace_users wu
       JOIN workspaces w ON w.id = wu.workspace_id
      WHERE wu.user_id = $1
        AND w.company_id <> (SELECT company_id FROM workspaces WHERE id = $2)
      LIMIT 1`,
    [userId, ctx.workspaceId],
  );
  if ((conflict.rowCount ?? 0) > 0) {
    return ok({ error: 'user already belongs to another company' }, 409);
  }
  await pool.query(
    `INSERT INTO workspace_users (workspace_id, user_id, role) VALUES ($1, $2, $3)
     ON CONFLICT (workspace_id, user_id) DO UPDATE SET role = EXCLUDED.role`,
    [ctx.workspaceId, userId, role],
  );
  return ok({ workspaceId: ctx.workspaceId, userId, email: emailForUser(userId), role }, 201);
};

/** PATCH /workspace/members — change a member's role in the active workspace. */
export const updateMember: Handler = async (ctx, pool, req) => {
  const b = asObject(req.body);
  const userId = String(b.user_id ?? '');
  const role = String(b.role ?? '');
  if (!userId || !role) return ok({ error: 'user_id and role required' }, 400);
  const { rowCount } = await pool.query(
    'UPDATE workspace_users SET role = $3 WHERE workspace_id = $1 AND user_id = $2',
    [ctx.workspaceId, userId, role],
  );
  return ok({ updated: rowCount ?? 0 });
};

// ---------------------------------------------------------------------------
// workspace settings (manage_workspace_users) — e.g. lowercase_emails
// ---------------------------------------------------------------------------

/** Whether this workspace enforces lowercase emails (default true when unset). */
async function lowercaseEmailsEnabled(pool: Pool, workspaceId: string): Promise<boolean> {
  const { rows } = await pool.query(
    "SELECT settings->>'lowercase_emails' AS v FROM workspaces WHERE id = $1",
    [workspaceId],
  );
  return rows[0]?.v !== 'false'; // default ON
}

/** Apply the workspace email-casing policy to an email (else return as-is). */
function applyEmailPolicy(email: string, lowercase: boolean): string {
  return lowercase ? email.toLowerCase() : email;
}

/** GET /workspace/settings — the active workspace's settings bag. */
export const getWorkspaceSettings: Handler = async (ctx, pool) => {
  const { rows } = await pool.query('SELECT settings FROM workspaces WHERE id = $1', [ctx.workspaceId]);
  const settings = (rows[0]?.settings as Record<string, unknown>) ?? {};
  return ok({ settings: { lowercase_emails: settings.lowercase_emails !== false, ...settings } });
};

/** PUT /workspace/settings — merge allowed settings (owner). */
export const updateWorkspaceSettings: Handler = async (ctx, pool, req) => {
  const b = asObject(req.body);
  const patch: Record<string, unknown> = {};
  if (b.lowercase_emails !== undefined) patch.lowercase_emails = Boolean(b.lowercase_emails);
  if (Object.keys(patch).length === 0) return ok({ error: 'no recognized settings' }, 400);
  const { rows } = await pool.query(
    `UPDATE workspaces SET settings = settings || $2::jsonb WHERE id = $1 RETURNING settings`,
    [ctx.workspaceId, JSON.stringify(patch)],
  );
  return ok({ settings: rows[0]?.settings ?? {} });
};

// ---------------------------------------------------------------------------
// sending domain (manage_sending_domain) — onboarding cores, SES/DNS injected
// ---------------------------------------------------------------------------

export const sendingDomainStart: Handler = async (ctx, _pool, req, deps) => {
  const b = asObject(req.body);
  const out = await startDomain(deps.onboarding, {
    workspaceId: ctx.workspaceId,
    fromDomain: String(b.from_domain ?? ''),
  });
  return ok(out);
};

export const sendingDomainCheck: Handler = async (ctx, _pool, _req, deps) => {
  const out = await checkDomain(deps.onboarding, { workspaceId: ctx.workspaceId });
  return ok(out);
};

export const sendingDomainActivate: Handler = async (ctx, _pool, _req, deps) => {
  const out = await activate(deps.onboarding, { workspaceId: ctx.workspaceId });
  return ok(out);
};

// ---------------------------------------------------------------------------
// segments + audiences (manage_content)
// ---------------------------------------------------------------------------

export const listSegments: Handler = async (ctx, pool) => {
  const q = scopedQuery(
    ctx.workspaceId,
    'SELECT id, name, kind, status, definition FROM segments',
  );
  const { rows } = await pool.query(q.text, q.values);
  return ok({ segments: rows });
};

/** GET /segments/:id — one segment (with its definition) for the editor. Scoped. */
export const getSegment: Handler = async (ctx, pool, req) => {
  const id = req.params.id!;
  const q = scopedQuery(
    ctx.workspaceId,
    'SELECT id, name, kind, status, definition FROM segments WHERE id = $1',
    [id],
  );
  const { rows } = await pool.query(q.text, q.values);
  if (!rows[0]) return ok({ error: 'not found' }, 404);
  return ok({ segment: rows[0] });
};

export const createSegment: Handler = async (ctx, pool, req) => {
  const b = asObject(req.body);
  const name = String(b.name ?? '');
  const kind = String(b.kind ?? 'dynamic_realtime');
  const definition = (b.definition ?? null) as AstNode | null;
  if (!name) return ok({ error: 'name required' }, 400);
  if (definition !== null) validateAst(definition); // reject garbage AST early
  const { rows } = await pool.query(
    `INSERT INTO segments (workspace_id, name, kind, definition)
     VALUES ($1, $2, $3, $4::jsonb) RETURNING id, name, kind, status`,
    [ctx.workspaceId, name, kind, definition === null ? null : JSON.stringify(definition)],
  );
  return ok({ segment: rows[0] }, 201);
};

export const updateSegment: Handler = async (ctx, pool, req) => {
  const b = asObject(req.body);
  const id = req.params.id!;
  const name = b.name !== undefined ? String(b.name) : null;
  const definition = b.definition !== undefined ? (b.definition as AstNode | null) : undefined;
  if (definition !== undefined && definition !== null) validateAst(definition);
  const q = scopedQuery(
    ctx.workspaceId,
    `UPDATE segments SET
       name = COALESCE($1, name),
       definition = CASE WHEN $3::boolean THEN $2::jsonb ELSE definition END,
       updated_at = now()
     WHERE id = $4`,
    [
      name,
      definition === undefined || definition === null ? null : JSON.stringify(definition),
      definition !== undefined,
      id,
    ],
  );
  const { rowCount } = await pool.query(q.text, q.values);
  return ok({ updated: rowCount ?? 0 });
};

/**
 * POST /segments/preview — LIVE size preview for a dynamic rule AST (§12). Reuses
 * the §8 compiler (workspace_id structurally $1) so the preview count is scoped
 * to the active workspace and can NEVER match another workspace's profiles.
 */
export const previewSegment: Handler = async (ctx, pool, req) => {
  const b = asObject(req.body);
  const ast = (b.definition ?? null) as AstNode | null;
  const where = compileWhere(ctx.workspaceId, ast);
  const { rows } = await pool.query(
    `SELECT count(*)::int AS size
     FROM profiles p
     LEFT JOIN profile_features pf ON pf.profile_id = p.id
     WHERE ${where.text}`,
    where.values,
  );
  return ok({ size: rows[0]?.size ?? 0 });
};

export const addSegmentMembers: Handler = async (ctx, pool, req) => {
  const b = asObject(req.body);
  const id = req.params.id!;
  const profileIds = Array.isArray(b.profile_ids) ? (b.profile_ids as string[]) : [];
  if (profileIds.length === 0) return ok({ added: 0 });
  // The manual-members builder binds segment_id structurally but does NOT verify
  // the segment row belongs to ctx.workspaceId — confirm ownership first so a
  // cross-workspace segment id (from another tenant) can't be mutated.
  if (!(await ownsResource(pool, ctx.workspaceId, 'segments', id)))
    return ok({ error: 'not found' }, 404);
  const stmt = addManualMembers(ctx.workspaceId, id, profileIds);
  await pool.query(stmt.text, stmt.values);
  return ok({ added: profileIds.length });
};

export const removeSegmentMembers: Handler = async (ctx, pool, req) => {
  const b = asObject(req.body);
  const id = req.params.id!;
  const profileIds = Array.isArray(b.profile_ids) ? (b.profile_ids as string[]) : [];
  if (profileIds.length === 0) return ok({ removed: 0 });
  if (!(await ownsResource(pool, ctx.workspaceId, 'segments', id)))
    return ok({ error: 'not found' }, 404);
  const stmt = removeManualMembers(ctx.workspaceId, id, profileIds);
  const { rowCount } = await pool.query(stmt.text, stmt.values);
  return ok({ removed: rowCount ?? 0 });
};

/** POST /segments/:id/import-csv — hand-pick by CSV: resolve emails → profile ids → manual members. */
export const importCsvMembers: Handler = async (ctx, pool, req) => {
  const b = asObject(req.body);
  const id = req.params.id!;
  const emails = Array.isArray(b.emails) ? (b.emails as string[]) : [];
  if (emails.length === 0) return ok({ added: 0, matched: 0 });
  if (!(await ownsResource(pool, ctx.workspaceId, 'segments', id)))
    return ok({ error: 'not found' }, 404);
  // Resolve emails to profile ids WITHIN the active workspace (scoped).
  const q = scopedQuery(
    ctx.workspaceId,
    'SELECT id FROM profiles WHERE email = ANY($1::citext[])',
    [emails],
  );
  const { rows } = await pool.query<{ id: string }>(q.text, q.values);
  const profileIds = rows.map((r) => r.id);
  if (profileIds.length > 0) {
    const stmt = addManualMembers(ctx.workspaceId, id, profileIds);
    await pool.query(stmt.text, stmt.values);
  }
  return ok({ added: profileIds.length, matched: profileIds.length });
};

// ---------------------------------------------------------------------------
// templates (manage_content)
// ---------------------------------------------------------------------------

export const listTemplates: Handler = async (ctx, pool) => {
  const q = scopedQuery(ctx.workspaceId, 'SELECT id, name, updated_at FROM email_templates');
  const { rows } = await pool.query(q.text, q.values);
  return ok({ templates: rows });
};

export const createTemplate: Handler = async (ctx, pool, req, deps) => {
  const b = asObject(req.body);
  const name = String(b.name ?? 'Untitled');
  const mjml = String(b.mjml ?? '');
  // Compile MJML→HTML server-side (reuse @cdp/email compileMjml via deps).
  const compiled = deps.compileMjml(mjml);
  const { rows } = await pool.query(
    `INSERT INTO email_templates (workspace_id, name, mjml, compiled_html)
     VALUES ($1, $2, $3, $4) RETURNING id, name, updated_at`,
    [ctx.workspaceId, name, mjml, compiled],
  );
  return ok({ template: rows[0] }, 201);
};

// ---------------------------------------------------------------------------
// broadcasts (manage_content)
// ---------------------------------------------------------------------------

export const listBroadcasts: Handler = async (ctx, pool) => {
  const q = scopedQuery(
    ctx.workspaceId,
    'SELECT id, name, status, audience_kind, audience_ref, template_id, sent_at FROM broadcasts',
  );
  const { rows } = await pool.query(q.text, q.values);
  return ok({ broadcasts: rows });
};

export const createBroadcast: Handler = async (ctx, pool, req) => {
  const b = asObject(req.body);
  const { rows } = await pool.query(
    `INSERT INTO broadcasts (workspace_id, name, template_id, audience_kind, audience_ref, created_by)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, name, status`,
    [
      ctx.workspaceId,
      String(b.name ?? 'Untitled'),
      b.template_id ?? null,
      String(b.audience_kind ?? 'segment'),
      b.audience_ref ?? null,
      ctx.userId ?? null,
    ],
  );
  return ok({ broadcast: rows[0] }, 201);
};

/** POST /broadcasts/:id/send — runs the broadcast core (SQS mocked at the boundary). */
export const sendBroadcast: Handler = async (ctx, pool, req, deps) => {
  const id = req.params.id!;
  // CRITICAL (CLAUDE.md inv.2): runBroadcast loads workspace_id FROM the broadcast
  // row, so it would happily send ANY broadcast id regardless of the caller's
  // active workspace. We MUST first confirm the target broadcast belongs to the
  // token's workspace (NEVER the body). If not, return 404 without revealing that
  // the id exists in another workspace, and never invoke the broadcast core.
  const guard = scopedQuery(ctx.workspaceId, 'SELECT 1 FROM broadcasts WHERE id = $1', [id]);
  const { rowCount } = await pool.query(guard.text, guard.values);
  if (!rowCount) return ok({ error: 'not found' }, 404);
  const result = await runBroadcast(deps.broadcast, id);
  return ok({ result });
};

// ---------------------------------------------------------------------------
// campaigns (manage_content)
// ---------------------------------------------------------------------------

export const listCampaigns: Handler = async (ctx, pool) => {
  const q = scopedQuery(ctx.workspaceId, 'SELECT id, name, status FROM campaigns');
  const { rows } = await pool.query(q.text, q.values);
  return ok({ campaigns: rows });
};

export const createCampaign: Handler = async (ctx, pool, req) => {
  const b = asObject(req.body);
  const name = String(b.name ?? '');
  const definition = b.definition;
  if (!name) return ok({ error: 'name required' }, 400);
  validateCampaignDefinition(definition); // reject malformed graphs (§9B)
  const { rows } = await pool.query(
    `INSERT INTO campaigns (workspace_id, name, definition, trigger_segment_id)
     VALUES ($1, $2, $3::jsonb, $4) RETURNING id, name, status`,
    [ctx.workspaceId, name, JSON.stringify(definition), b.trigger_segment_id ?? null],
  );
  return ok({ campaign: rows[0] }, 201);
};

export const updateCampaign: Handler = async (ctx, pool, req) => {
  const b = asObject(req.body);
  const id = req.params.id!;
  if (b.definition !== undefined) validateCampaignDefinition(b.definition);
  const q = scopedQuery(
    ctx.workspaceId,
    `UPDATE campaigns SET
       name = COALESCE($1, name),
       definition = CASE WHEN $3::boolean THEN $2::jsonb ELSE definition END,
       status = COALESCE($4, status)
     WHERE id = $5`,
    [
      b.name !== undefined ? String(b.name) : null,
      b.definition !== undefined ? JSON.stringify(b.definition) : null,
      b.definition !== undefined,
      b.status !== undefined ? String(b.status) : null,
      id,
    ],
  );
  const { rowCount } = await pool.query(q.text, q.values);
  return ok({ updated: rowCount ?? 0 });
};

// ---------------------------------------------------------------------------
// profiles (manage_content)
// ---------------------------------------------------------------------------

export const listProfiles: Handler = async (ctx, pool, req) => {
  // Optional ?segment_id=… narrows to that segment's members. Both the profile
  // AND the membership are scoped to the token's workspace (workspace_id = $1),
  // so a cross-workspace segment id can never surface another tenant's profiles.
  const segmentId = req.query.segment_id;
  if (segmentId) {
    // Resolve the segment first (scoped) — its kind decides the source of truth.
    // A dynamic (rule-based) segment is evaluated LIVE via the §8 compiler (the
    // same source the size preview uses), so the filter reflects who matches the
    // rule right now — not whatever the evaluator last materialized. A manual
    // segment uses its membership rows. A cross-workspace id resolves to nothing.
    const segQ = scopedQuery(
      ctx.workspaceId,
      'SELECT definition FROM segments WHERE id = $1',
      [segmentId],
    );
    const seg = await pool.query(segQ.text, segQ.values);
    if (!seg.rows[0]) return ok({ profiles: [] });
    const definition = (seg.rows[0].definition ?? null) as AstNode | null;

    if (definition) {
      // Dynamic: profiles currently matching the rule (workspace_id is $1, bound
      // structurally by the compiler — can never match another tenant).
      const where = compileWhere(ctx.workspaceId, definition);
      const { rows } = await pool.query(
        `SELECT p.id, p.external_id, p.email, p.email_status, p.created_at,
                floor(extract(epoch from p.created_at) * 1000)::double precision AS created_at_unix, p.attributes,
                (p.attributes ->> 'unsubscribed' = 'true') AS unsubscribed
           FROM profiles p
           LEFT JOIN profile_features pf ON pf.profile_id = p.id
          WHERE ${where.text}
          ORDER BY p.created_at DESC
          LIMIT 200`,
        where.values,
      );
      return ok({ profiles: rows });
    }

    // Manual (no rule): the materialized membership rows.
    const { rows } = await pool.query(
      `SELECT p.id, p.external_id, p.email, p.email_status, p.created_at,
                floor(extract(epoch from p.created_at) * 1000)::double precision AS created_at_unix, p.attributes,
              (p.attributes ->> 'unsubscribed' = 'true') AS unsubscribed
         FROM profiles p
         JOIN segment_memberships sm
           ON sm.profile_id = p.id AND sm.workspace_id = p.workspace_id
        WHERE p.workspace_id = $1 AND sm.segment_id = $2
        ORDER BY p.created_at DESC
        LIMIT 200`,
      [ctx.workspaceId, segmentId],
    );
    return ok({ profiles: rows });
  }
  // Explicit workspace_id = $1 scoping (the token's workspace), since this query
  // carries ORDER BY/LIMIT that scopedQuery's WHERE-rewriter cannot wrap.
  const { rows } = await pool.query(
    `SELECT id, external_id, email, email_status, created_at,
            floor(extract(epoch from created_at) * 1000)::double precision AS created_at_unix, attributes,
            (attributes ->> 'unsubscribed' = 'true') AS unsubscribed
       FROM profiles WHERE workspace_id = $1 ORDER BY created_at DESC LIMIT 200`,
    [ctx.workspaceId],
  );
  return ok({ profiles: rows });
};

/**
 * POST /profiles — manually create (or upsert) a profile in the active workspace.
 * external_id is the per-workspace unique key (required); email + attributes are
 * optional. New profiles seed unsubscribed=false; a re-create merges. Scoped to
 * the token's workspace in code (workspace_id NEVER from the body).
 */
export const createProfile: Handler = async (ctx, pool, req) => {
  const b = asObject(req.body);
  // EMAIL is the identity key (§7) — required; external_id is optional metadata.
  // Casing follows the workspace's lowercase_emails policy.
  const emailTrimmed = typeof b.email === 'string' ? b.email.trim() : '';
  const email = applyEmailPolicy(emailTrimmed, await lowercaseEmailsEnabled(pool, ctx.workspaceId));
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return ok({ error: 'a valid email is required' }, 400);
  const externalId = typeof b.external_id === 'string' && b.external_id.trim() ? b.external_id.trim() : null;
  const attrs =
    b.attributes && typeof b.attributes === 'object' && !Array.isArray(b.attributes)
      ? (b.attributes as Record<string, unknown>)
      : {};
  // Manual creation is a CREATE, not a silent merge: email is the identity key,
  // so an existing email is a conflict the user must know about. INSERT ... ON
  // CONFLICT DO NOTHING returns no row when the email already exists (race-safe
  // against the unique index); we then surface a 409 with the existing id so the
  // UI can offer to open it instead of silently overwriting.
  const { rows } = await pool.query(
    `INSERT INTO profiles (workspace_id, email, external_id, attributes)
     VALUES ($1, $2, $3, '{"unsubscribed": false}'::jsonb || $4::jsonb)
     ON CONFLICT (workspace_id, email) DO NOTHING
     RETURNING id, external_id, email, email_status`,
    [ctx.workspaceId, email, externalId, JSON.stringify(attrs)],
  );
  if (!rows[0]) {
    const existing = await pool.query('SELECT id FROM profiles WHERE workspace_id = $1 AND email = $2', [
      ctx.workspaceId,
      email,
    ]);
    return ok(
      { error: `A profile with email ${email} already exists.`, profile_id: existing.rows[0]?.id ?? null },
      409,
    );
  }
  const profileId = (rows[0] as { id: string }).id;
  await pool.query(
    `INSERT INTO profile_features (profile_id, workspace_id) VALUES ($1, $2)
     ON CONFLICT (profile_id) DO NOTHING`,
    [profileId, ctx.workspaceId],
  );
  return ok({ profile: rows[0] }, 201);
};

/**
 * POST /profiles/import-csv — bulk upsert profiles parsed from a CSV (the client
 * splits the file; we receive typed rows). Email is the identity key (§7), so we
 * UPSERT on (workspace_id, email): a new email is created (seeded
 * unsubscribed=false), an existing one has its attributes MERGED (the existing
 * `unsubscribed` flag is preserved unless the CSV supplies it). Casing follows
 * the workspace lowercase_emails policy. Returns per-outcome counts + row errors.
 */
const IMPORT_ROW_CAP = 10000;
export const importProfilesCsv: Handler = async (ctx, pool, req) => {
  const b = asObject(req.body);
  const rows = Array.isArray(b.rows) ? (b.rows as unknown[]) : [];
  if (rows.length === 0) return ok({ error: 'no rows to import' }, 400);
  if (rows.length > IMPORT_ROW_CAP) return ok({ error: `too many rows (max ${IMPORT_ROW_CAP})` }, 400);
  const lowercase = await lowercaseEmailsEnabled(pool, ctx.workspaceId);

  let created = 0;
  let updated = 0;
  const errors: Array<{ row: number; email: string; error: string }> = [];
  for (let i = 0; i < rows.length; i++) {
    const r = asObject(rows[i]);
    const email = applyEmailPolicy(typeof r.email === 'string' ? r.email.trim() : '', lowercase);
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      errors.push({ row: i + 1, email, error: 'invalid or missing email' });
      continue;
    }
    const externalId = typeof r.external_id === 'string' && r.external_id.trim() ? r.external_id.trim() : '';
    const attrs =
      r.attributes && typeof r.attributes === 'object' && !Array.isArray(r.attributes)
        ? (r.attributes as Record<string, unknown>)
        : {};
    try {
      const res = await pool.query<{ inserted: boolean; id: string }>(
        `INSERT INTO profiles (workspace_id, email, external_id, attributes)
         VALUES ($1, $2, NULLIF($3,''), '{"unsubscribed": false}'::jsonb || $4::jsonb)
         ON CONFLICT (workspace_id, email) DO UPDATE SET
           attributes = profiles.attributes || $4::jsonb,
           external_id = COALESCE(NULLIF($3,''), profiles.external_id),
           updated_at = now()
         RETURNING (xmax = 0) AS inserted, id`,
        [ctx.workspaceId, email, externalId, JSON.stringify(attrs)],
      );
      const row = res.rows[0]!;
      if (row.inserted) {
        created++;
        await pool.query(
          `INSERT INTO profile_features (profile_id, workspace_id) VALUES ($1, $2)
           ON CONFLICT (profile_id) DO NOTHING`,
          [row.id, ctx.workspaceId],
        );
      } else {
        updated++;
      }
    } catch (e) {
      errors.push({ row: i + 1, email, error: (e as { message?: string }).message ?? 'insert failed' });
    }
  }
  return ok({ created, updated, skipped: errors.length, total: rows.length, errors: errors.slice(0, 50) });
};

/**
 * GET /profiles/attribute-keys — the DISTINCT attribute keys across the
 * workspace's profiles (powers the column picker exhaustively, not limited to a
 * loaded page). Scoped to the token's workspace; excludes the internal
 * `unsubscribed` flag.
 */
export const listAttributeKeys: Handler = async (ctx, pool) => {
  const { rows } = await pool.query<{ key: string }>(
    `SELECT DISTINCT key
       FROM profiles p, jsonb_object_keys(p.attributes) AS key
      WHERE p.workspace_id = $1
      ORDER BY key`,
    [ctx.workspaceId],
  );
  return ok({ keys: rows.map((r) => r.key).filter((k) => k !== 'unsubscribed') });
};

export const getProfile: Handler = async (ctx, pool, req) => {
  const id = req.params.id!;
  const q = scopedQuery(
    ctx.workspaceId,
    `SELECT id, external_id, email, email_status, attributes, created_at, updated_at,
            floor(extract(epoch from created_at) * 1000)::double precision AS created_at_unix,
            floor(extract(epoch from updated_at) * 1000)::double precision AS updated_at_unix
       FROM profiles WHERE id = $1`,
    [id],
  );
  const { rows } = await pool.query(q.text, q.values);
  if (!rows[0]) return ok({ error: 'not found' }, 404);
  // Rolling aggregates for the detail header (workspace-scoped). Absent until the
  // processor has computed features for this profile — return nulls/zeros then.
  const f = await pool.query(
    `SELECT total_events, last_event_at, last_email_open_at, monetary_total
       FROM profile_features WHERE profile_id = $1 AND workspace_id = $2`,
    [id, ctx.workspaceId],
  );
  return ok({ profile: rows[0], features: f.rows[0] ?? null });
};

// email_status is the address DELIVERABILITY state (what the provider told us):
// active (good), bounced (hard bounce — address invalid), complained (marked
// spam). It is NOT consent — unsubscribe is the separate boolean attribute
// `unsubscribed`, which can be true in parallel with any deliverability state.
const EDITABLE_EMAIL_STATUS = new Set(['active', 'bounced', 'complained']);

/**
 * PATCH /profiles/:id — edit core fields + REPLACE the attributes object (§6).
 * Scoped to the token's workspace in code (workspace_id in the WHERE, NEVER the
 * body — CLAUDE.md inv.2); a cross-workspace id simply matches nothing → 404.
 */
export const updateProfile: Handler = async (ctx, pool, req) => {
  const id = req.params.id!;
  const b = asObject(req.body);
  // Email edits follow the workspace's lowercase_emails policy.
  const email =
    b.email !== undefined
      ? applyEmailPolicy(String(b.email).trim(), await lowercaseEmailsEnabled(pool, ctx.workspaceId))
      : null;
  const externalId = b.external_id !== undefined ? String(b.external_id) : null;
  const emailStatus = b.email_status !== undefined ? String(b.email_status) : null;
  if (emailStatus !== null && !EDITABLE_EMAIL_STATUS.has(emailStatus))
    return ok({ error: `invalid email_status: ${emailStatus}` }, 400);
  // attributes: full replacement when provided; must be a plain JSON object.
  const hasAttrs = b.attributes !== undefined;
  let attributes: string | null = null;
  if (hasAttrs) {
    const a = b.attributes;
    if (a === null || typeof a !== 'object' || Array.isArray(a))
      return ok({ error: 'attributes must be an object' }, 400);
    attributes = JSON.stringify(a);
  }
  // Explicit workspace_id in the WHERE (scopedQuery can't host a trailing
  // RETURNING). Email is unique per workspace — changing it to one already in use
  // surfaces a friendly 409 instead of the raw unique violation (Postgres 23505).
  let rows: Array<Record<string, unknown>>;
  try {
    ({ rows } = await pool.query(
      `UPDATE profiles SET
         email = COALESCE($1, email),
         external_id = COALESCE($2, external_id),
         email_status = COALESCE($3, email_status),
         attributes = CASE WHEN $5::boolean THEN $4::jsonb ELSE attributes END,
         updated_at = now()
       WHERE id = $6 AND workspace_id = $7
       RETURNING id, external_id, email, email_status, attributes`,
      [email, externalId, emailStatus, attributes, hasAttrs, id, ctx.workspaceId],
    ));
  } catch (e) {
    if ((e as { code?: string }).code === '23505') {
      return ok({ error: `A profile with email ${email} already exists.` }, 409);
    }
    throw e;
  }
  if (!rows[0]) return ok({ error: 'not found' }, 404);

  // Act like the real pipelines: reconcile the suppression list to the profile's
  // new state. A manual edit that marks the address bounced/complained or
  // unsubscribed must put it on the do-not-send list (source='manual'); clearing
  // those states removes the MANUAL suppression (never a pipeline-written one).
  const updated = rows[0] as {
    email: string | null;
    email_status: string;
    attributes: Record<string, unknown> | null;
  };
  if (updated.email) {
    const unsub = updated.attributes?.unsubscribed === true || updated.attributes?.unsubscribed === 'true';
    const reason =
      unsub ? 'unsubscribe' : updated.email_status === 'bounced' ? 'hard_bounce' : updated.email_status === 'complained' ? 'complaint' : null;
    if (reason) {
      await pool.query(
        `INSERT INTO suppressions (workspace_id, email, reason, source)
         VALUES ($1, $2, $3, 'manual') ON CONFLICT (workspace_id, email) DO NOTHING`,
        [ctx.workspaceId, updated.email, reason],
      );
    } else {
      // Subscribed + deliverable again → lift the MANUAL suppression only.
      await pool.query(
        `DELETE FROM suppressions WHERE workspace_id = $1 AND email = $2 AND source = 'manual'`,
        [ctx.workspaceId, updated.email],
      );
    }
  }
  return ok({ profile: rows[0] });
};

/**
 * POST /profiles/:id/merge — merge `secondary_id` INTO `:id` (the lead/survivor),
 * then delete the secondary. In ONE workspace-scoped transaction:
 *   - reassign every row that references the secondary (events, email_events,
 *     messages_log, outbox, campaign_enrollments, segment_change_log) to the lead,
 *   - move segment memberships to the lead (manual memberships now point at the
 *     survivor; conflicts dropped),
 *   - set the lead's attributes to the caller-resolved merged object,
 *   - RECOMPUTE the lead's rolling features from the merged events,
 *   - RE-EVALUATE the lead's dynamic_realtime segments (enter/exit + change_log),
 *   - delete the secondary profile.
 * Both ids must belong to the token's workspace (scoped in code).
 */
export const mergeProfiles: Handler = async (ctx, pool, req) => {
  const lead = req.params.id!;
  const b = asObject(req.body);
  const secondary = typeof b.secondary_id === 'string' ? b.secondary_id : '';
  if (!secondary || secondary === lead) return ok({ error: 'a different secondary_id is required' }, 400);
  const attrs =
    b.attributes && typeof b.attributes === 'object' && !Array.isArray(b.attributes)
      ? (b.attributes as Record<string, unknown>)
      : null;

  const ws = ctx.workspaceId;
  const client = await pool.connect();
  try {
    // Both profiles must exist in THIS workspace.
    const { rows: present } = await client.query(
      'SELECT id FROM profiles WHERE workspace_id = $1 AND id = ANY($2::uuid[])',
      [ws, [lead, secondary]],
    );
    if (present.length !== 2) {
      client.release();
      return ok({ error: 'not found' }, 404);
    }

    await client.query('BEGIN');
    const reassign = (table: string) =>
      client.query(`UPDATE ${table} SET profile_id = $2 WHERE workspace_id = $1 AND profile_id = $3`, [
        ws,
        lead,
        secondary,
      ]);
    // Plain reassigns (no per-profile uniqueness on these).
    await reassign('events');
    await reassign('email_events');
    await reassign('messages_log');
    await reassign('outbox');
    await reassign('segment_change_log');
    // Memberships: UNIQUE(segment_id, profile_id) — move missing, drop the rest.
    await client.query(
      `INSERT INTO segment_memberships (segment_id, profile_id, workspace_id, source, entered_at)
       SELECT segment_id, $2, workspace_id, source, entered_at
         FROM segment_memberships WHERE workspace_id = $1 AND profile_id = $3
       ON CONFLICT (segment_id, profile_id) DO NOTHING`,
      [ws, lead, secondary],
    );
    await client.query('DELETE FROM segment_memberships WHERE workspace_id = $1 AND profile_id = $2', [
      ws,
      secondary,
    ]);
    // Campaign enrollments: UNIQUE(campaign_id, profile_id) — move missing, drop rest.
    await client.query(
      `INSERT INTO campaign_enrollments
         (workspace_id, campaign_id, profile_id, current_node, status, next_run_at, state, enrolled_at, updated_at)
       SELECT workspace_id, campaign_id, $2, current_node, status, next_run_at, state, enrolled_at, now()
         FROM campaign_enrollments WHERE workspace_id = $1 AND profile_id = $3
       ON CONFLICT (campaign_id, profile_id) DO NOTHING`,
      [ws, lead, secondary],
    );
    await client.query('DELETE FROM campaign_enrollments WHERE workspace_id = $1 AND profile_id = $2', [
      ws,
      secondary,
    ]);

    // Lead attributes = caller-resolved merged set (else keep the lead's).
    if (attrs !== null) {
      await client.query(
        'UPDATE profiles SET attributes = $3::jsonb, updated_at = now() WHERE workspace_id = $1 AND id = $2',
        [ws, lead, JSON.stringify(attrs)],
      );
    }

    // Recompute the lead's rolling features from ALL its (now-merged) events,
    // mirroring the processor's aggregates (§6).
    await client.query(
      `WITH agg AS (
         SELECT count(*)::int AS total_events,
                max(occurred_at) AS last_event_at,
                max(occurred_at) FILTER (WHERE type = ANY($3::text[])) AS last_email_open_at,
                COALESCE(sum((payload->>'amount')::numeric) FILTER (WHERE type = ANY($4::text[])), 0) AS monetary_total
           FROM events WHERE workspace_id = $1 AND profile_id = $2
       ),
       cnt AS (
         SELECT COALESCE(jsonb_object_agg(type, c), '{}'::jsonb) AS counters
           FROM (SELECT type, count(*)::int c FROM events WHERE workspace_id = $1 AND profile_id = $2 GROUP BY type) t
       )
       INSERT INTO profile_features
         (profile_id, workspace_id, total_events, last_event_at, last_email_open_at, counters, monetary_total, updated_at)
       SELECT $2, $1, agg.total_events, agg.last_event_at, agg.last_email_open_at, cnt.counters, agg.monetary_total, now()
         FROM agg, cnt
       ON CONFLICT (profile_id) DO UPDATE SET
         total_events = EXCLUDED.total_events,
         last_event_at = EXCLUDED.last_event_at,
         last_email_open_at = EXCLUDED.last_email_open_at,
         counters = EXCLUDED.counters,
         monetary_total = EXCLUDED.monetary_total,
         updated_at = now()`,
      [ws, lead, OPEN_EVENT_TYPES as readonly string[], PURCHASE_EVENT_TYPES as readonly string[]],
    );

    // Remove the secondary (features first — FK).
    await client.query('DELETE FROM profile_features WHERE workspace_id = $1 AND profile_id = $2', [ws, secondary]);
    await client.query('DELETE FROM profiles WHERE workspace_id = $1 AND id = $2', [ws, secondary]);

    // Re-evaluate the lead's realtime segments against its merged features, in
    // the SAME tx (membership diff + change_log via the shared evaluator).
    await evaluateRealtimeSegmentsForProfile(
      {
        reader: { query: (text, values) => client.query(text, values) },
        runInWorkspaceTx: async (_w, statements) => {
          for (const s of statements) await client.query(s.text, s.values);
        },
      },
      ws,
      lead,
    );

    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
    throw e;
  }
  client.release();

  const { rows } = await pool.query(
    'SELECT id, external_id, email, email_status, attributes FROM profiles WHERE workspace_id = $1 AND id = $2',
    [ws, lead],
  );
  return ok({ profile: rows[0] });
};

/** GET /profiles/:id/events — this profile's event history, newest first (scoped). */
export const listProfileEvents: Handler = async (ctx, pool, req) => {
  const id = req.params.id!;
  // workspace_id + profile_id both scope the read; a cross-tenant profile id can
  // never surface another workspace's events (the workspace_id predicate fails).
  const { rows } = await pool.query(
    `SELECT event_id, type, occurred_at, received_at, payload
       FROM events
      WHERE workspace_id = $1 AND profile_id = $2
      ORDER BY occurred_at DESC
      LIMIT 200`,
    [ctx.workspaceId, id],
  );
  return ok({ events: rows });
};

/** GET /profiles/:id/segments — segments this profile currently belongs to (scoped). */
export const listProfileSegments: Handler = async (ctx, pool, req) => {
  const id = req.params.id!;
  const { rows } = await pool.query(
    `SELECT s.id, s.name, s.kind, sm.source, sm.entered_at
       FROM segment_memberships sm
       JOIN segments s ON s.id = sm.segment_id
      WHERE sm.workspace_id = $1 AND sm.profile_id = $2
      ORDER BY sm.entered_at DESC`,
    [ctx.workspaceId, id],
  );
  return ok({ segments: rows });
};

// ---------------------------------------------------------------------------
// activity log (manage_content) — unified, filterable feed
// ---------------------------------------------------------------------------

/**
 * GET /activity — a unified activity feed across the workspace: behavioural
 * events, email/delivery events, and sends, time-ordered newest-first. Filters:
 * from/to (datetime), type, outcome (success|failure|info), source. Each source
 * subquery is scoped to the token's workspace (workspace_id = $1) IN CODE, so the
 * feed can never include another tenant's activity. Outcome is DERIVED:
 * delivery/open/click + sent = success; bounce/complaint + non-sent = failure;
 * behavioural events = info.
 */
export const listActivity: Handler = async (ctx, pool, req) => {
  const q = req.query;
  const from = q.from || null;
  const to = q.to || null;
  const type = q.type || null;
  const outcome = q.outcome || null;
  const source = q.source || null;
  const { rows } = await pool.query(
    `SELECT a.at, a.source, a.type, a.outcome, a.profile_id, a.detail, p.email
       FROM (
         SELECT occurred_at AS at, 'event'::text AS source, type,
                'info'::text AS outcome, profile_id, payload::text AS detail
           FROM events WHERE workspace_id = $1
         UNION ALL
         SELECT occurred_at, 'email', type,
                CASE WHEN type IN ('delivery','open','click') THEN 'success'
                     WHEN type IN ('bounce','complaint') THEN 'failure'
                     ELSE 'info' END,
                profile_id, coalesce(sub_type, '')
           FROM email_events WHERE workspace_id = $1
         UNION ALL
         SELECT sent_at, 'send', 'send',
                CASE WHEN status = 'sent' THEN 'success' ELSE 'failure' END,
                profile_id, status
           FROM messages_log WHERE workspace_id = $1
       ) a
       LEFT JOIN profiles p ON p.id = a.profile_id AND p.workspace_id = $1
      WHERE ($2::timestamptz IS NULL OR a.at >= $2::timestamptz)
        AND ($3::timestamptz IS NULL OR a.at <= $3::timestamptz)
        AND ($4::text IS NULL OR a.type = $4)
        AND ($5::text IS NULL OR a.outcome = $5)
        AND ($6::text IS NULL OR a.source = $6)
      ORDER BY a.at DESC
      LIMIT 200`,
    [ctx.workspaceId, from, to, type, outcome, source],
  );
  return ok({ activity: rows });
};

// ---------------------------------------------------------------------------
// dashboards (manage_content)
// ---------------------------------------------------------------------------

export const dashboardSummary: Handler = async (ctx, pool) => {
  const counts = await Promise.all([
    pool.query(`SELECT count(*)::int AS c FROM profiles WHERE workspace_id = $1`, [ctx.workspaceId]),
    pool.query(`SELECT count(*)::int AS c FROM segments WHERE workspace_id = $1`, [ctx.workspaceId]),
    pool.query(`SELECT count(*)::int AS c FROM broadcasts WHERE workspace_id = $1`, [ctx.workspaceId]),
    pool.query(`SELECT count(*)::int AS c FROM messages_log WHERE workspace_id = $1`, [ctx.workspaceId]),
  ]);
  return ok({
    profiles: counts[0].rows[0]?.c ?? 0,
    segments: counts[1].rows[0]?.c ?? 0,
    broadcasts: counts[2].rows[0]?.c ?? 0,
    messages_sent: counts[3].rows[0]?.c ?? 0,
  });
};

// ---------------------------------------------------------------------------
// suppressions (manage_content)
// ---------------------------------------------------------------------------

export const listSuppressions: Handler = async (ctx, pool) => {
  const { rows } = await pool.query(
    'SELECT email, reason, source, created_at FROM suppressions WHERE workspace_id = $1 ORDER BY created_at DESC LIMIT 500',
    [ctx.workspaceId],
  );
  return ok({ suppressions: rows });
};

// ---------------------------------------------------------------------------
// billing / usage (view_billing)
// ---------------------------------------------------------------------------

/** The fixed-cost pool split evenly across active workspaces (§20, ≈$40/mo). */
const FIXED_COST_TOTAL = Number(process.env.METERING_FIXED_TOTAL ?? '40');

export const billingUsage: Handler = async (ctx, pool) => {
  // Raw counters (unchanged contract) for the current workspace.
  const { rows } = await pool.query(
    'SELECT period, metric, value FROM usage_counters WHERE workspace_id = $1 ORDER BY period DESC',
    [ctx.workspaceId],
  );

  // Computed §20 cost view. The even-split denominator AND iterated rows are the
  // SAME active set (status='active'); per-workspace figures sum to the true
  // total. This workspace's line is surfaced; the platform totals reconcile.
  const period = monthBucket(new Date());
  const active = await pool.query("SELECT id FROM workspaces WHERE status = 'active' ORDER BY id");
  const activeIds = active.rows.map((r) => r.id as string);
  const meteringDeps: MeteringDeps = {
    reader: { query: (text, values) => pool.query(text, values) },
    // The billing view is READ-ONLY; no tx writer is needed (and never called).
    runInWorkspaceTx: async () => {
      throw new Error('billingUsage is read-only');
    },
  };
  const view = await computeCostViewForWorkspaces(
    meteringDeps,
    activeIds,
    period,
    FIXED_COST_TOTAL,
    DEFAULT_PRICES,
  );
  const mine = view.workspaces.find((w) => w.workspaceId === ctx.workspaceId) ?? null;

  // ip_recommendation badge (read-only) from sending_identity.
  const wsRow = await pool.query(
    "SELECT sending_identity ->> 'ip_mode' AS ip_mode, sending_identity -> 'ip_recommendation' AS ip_recommendation FROM workspaces WHERE id = $1",
    [ctx.workspaceId],
  );
  const ipMode = (wsRow.rows[0]?.ip_mode as string | null) ?? 'shared';
  const ipRecommendation = wsRow.rows[0]?.ip_recommendation ?? null;

  return ok({
    usage: rows,
    period,
    cost: mine
      ? { directCost: mine.directCost, fixedShare: mine.fixedShare, total: mine.total }
      : null,
    totals: {
      directTotal: view.directTotal,
      fixedTotal: view.fixedTotal,
      activeWorkspaceCount: view.activeWorkspaceCount,
    },
    ip_mode: ipMode,
    ip_recommendation: ipRecommendation,
  });
};

// ---------------------------------------------------------------------------
// system-admin cross-tenant console (view_all_workspaces, AUDITED)
// ---------------------------------------------------------------------------

/** GET /admin/workspaces — cross-company list (system-admin only). Audited. */
/**
 * GET /admin/companies — every company with its workspaces (cross-tenant; only a
 * platform admin reaches this, gated by view_all_workspaces). Powers the
 * super-admin company → workspace picker. Always audited.
 */
export const adminListCompanies: Handler = async (ctx, pool) => {
  const { rows } = await pool.query(
    `SELECT c.id, c.name, c.status,
            COALESCE(
              json_agg(json_build_object('id', w.id, 'name', w.name, 'status', w.status)
                       ORDER BY w.name) FILTER (WHERE w.id IS NOT NULL),
              '[]'
            ) AS workspaces
       FROM companies c
       LEFT JOIN workspaces w ON w.company_id = c.id
      GROUP BY c.id, c.name, c.status
      ORDER BY c.name`,
  );
  await writeAuditEntry(
    recordCrossTenantAccess(ctx.userId ?? '', null, 'admin.list_companies', { count: rows.length }),
  );
  return ok({ companies: rows });
};

/** POST /admin/companies — create a company (platform admin; audited). */
export const adminCreateCompany: Handler = async (ctx, pool, req) => {
  const name = typeof asObject(req.body).name === 'string' ? String(asObject(req.body).name).trim() : '';
  if (!name) return ok({ error: 'name required' }, 400);
  const { rows } = await pool.query('INSERT INTO companies (name) VALUES ($1) RETURNING id, name, status', [name]);
  await writeAuditEntry(
    recordCrossTenantAccess(ctx.userId ?? '', null, 'admin.create_company', { company_id: rows[0].id, name }),
  );
  return ok({ company: rows[0] }, 201);
};

/** PATCH /admin/companies/:id — rename a company (platform admin; audited). */
export const adminRenameCompany: Handler = async (ctx, pool, req) => {
  const id = req.params.id!;
  const name = typeof asObject(req.body).name === 'string' ? String(asObject(req.body).name).trim() : '';
  if (!name) return ok({ error: 'name required' }, 400);
  const { rows } = await pool.query('UPDATE companies SET name = $2 WHERE id = $1 RETURNING id, name, status', [id, name]);
  if (!rows[0]) return ok({ error: 'not found' }, 404);
  await writeAuditEntry(
    recordCrossTenantAccess(ctx.userId ?? '', null, 'admin.rename_company', { company_id: id, name }),
  );
  return ok({ company: rows[0] });
};

/**
 * PATCH /admin/workspaces/:id — move a workspace into a company (platform admin;
 * audited). Reassigns the parent only; tenant data stays workspace-scoped.
 */
export const adminAssignWorkspaceCompany: Handler = async (ctx, pool, req) => {
  const id = req.params.id!;
  const companyId = typeof asObject(req.body).company_id === 'string' ? String(asObject(req.body).company_id) : '';
  if (!companyId) return ok({ error: 'company_id required' }, 400);
  const c = await pool.query('SELECT 1 FROM companies WHERE id = $1', [companyId]);
  if (!c.rows[0]) return ok({ error: 'company not found' }, 404);
  const { rows } = await pool.query(
    'UPDATE workspaces SET company_id = $2 WHERE id = $1 RETURNING id, name, company_id',
    [id, companyId],
  );
  if (!rows[0]) return ok({ error: 'workspace not found' }, 404);
  await handleAdminAccess(
    ctx,
    id,
    'admin.assign_workspace_company',
    { workspace_id: id, company_id: companyId },
    writeAuditEntry,
  );
  return ok({ workspace: rows[0] });
};

export const adminListWorkspaces: Handler = async (ctx, pool) => {
  const { rows } = await pool.query(
    'SELECT id, name, status, created_at FROM workspaces ORDER BY created_at',
  );
  // Listing ALL workspaces is inherently a cross-tenant action (only a platform
  // admin reaches this route, gated by view_all_workspaces) — always audit it.
  await writeAuditEntry(
    recordCrossTenantAccess(ctx.userId ?? '', null, 'admin.list_workspaces', {
      count: rows.length,
    }),
  );
  return ok({ workspaces: rows });
};

/** GET /admin/workspaces/:id — read ANOTHER workspace (cross-tenant). Audited. */
export const adminGetWorkspace: Handler = async (ctx, pool, req) => {
  const targetId = req.params.id!;
  const { rows } = await pool.query(
    'SELECT id, name, status, sending_identity, created_at FROM workspaces WHERE id = $1',
    [targetId],
  );
  if (!rows[0]) return ok({ error: 'not found' }, 404);
  // Reading a workspace OTHER than the active claim is the audited cross-tenant case.
  await handleAdminAccess(
    ctx,
    targetId,
    'admin.read_workspace',
    { workspace_id: targetId },
    writeAuditEntry,
  );
  return ok({ workspace: rows[0] });
};

/** Map a route key → its handler. */
export const HANDLERS: Readonly<Record<string, Handler>> = {
  'GET /me': getMe,
  'GET /workspace/members': listMembers,
  'POST /workspace/members': addMember,
  'PATCH /workspace/members': updateMember,
  'GET /workspace/settings': getWorkspaceSettings,
  'PUT /workspace/settings': updateWorkspaceSettings,
  'POST /sending-domain/start': sendingDomainStart,
  'POST /sending-domain/check': sendingDomainCheck,
  'POST /sending-domain/activate': sendingDomainActivate,
  'GET /segments': listSegments,
  'GET /segments/:id': getSegment,
  'POST /segments': createSegment,
  'PUT /segments/:id': updateSegment,
  'POST /segments/preview': previewSegment,
  'POST /segments/:id/members': addSegmentMembers,
  'DELETE /segments/:id/members': removeSegmentMembers,
  'POST /segments/:id/import-csv': importCsvMembers,
  'GET /templates': listTemplates,
  'POST /templates': createTemplate,
  'GET /broadcasts': listBroadcasts,
  'POST /broadcasts': createBroadcast,
  'POST /broadcasts/:id/send': sendBroadcast,
  'GET /campaigns': listCampaigns,
  'POST /campaigns': createCampaign,
  'PUT /campaigns/:id': updateCampaign,
  'GET /profiles': listProfiles,
  'POST /profiles': createProfile,
  'POST /profiles/import-csv': importProfilesCsv,
  'GET /profiles/attribute-keys': listAttributeKeys,
  'GET /profiles/:id': getProfile,
  'PATCH /profiles/:id': updateProfile,
  'POST /profiles/:id/merge': mergeProfiles,
  'GET /profiles/:id/events': listProfileEvents,
  'GET /profiles/:id/segments': listProfileSegments,
  'GET /activity': listActivity,
  'GET /dashboards/summary': dashboardSummary,
  'GET /suppressions': listSuppressions,
  'GET /billing/usage': billingUsage,
  'GET /admin/companies': adminListCompanies,
  'POST /admin/companies': adminCreateCompany,
  'PATCH /admin/companies/:id': adminRenameCompany,
  'PATCH /admin/workspaces/:id': adminAssignWorkspaceCompany,
  'GET /admin/workspaces': adminListWorkspaces,
  'GET /admin/workspaces/:id': adminGetWorkspace,
};
