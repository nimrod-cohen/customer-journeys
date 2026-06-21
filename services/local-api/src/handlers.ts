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
import type { Pool, PoolClient } from 'pg';
import { promises as dns } from 'node:dns';
import { createSesClient, type SesEmailClient } from '@cdp/email';
import { dispatchOutbox, type DispatchDeps } from '@cdp/service-dispatcher';
import { resolveChannelProvider } from '@cdp/channels';
import {
  DEV_USERS,
  OPEN_EVENT_TYPES,
  PURCHASE_EVENT_TYPES,
  isValidTimeZone,
  type WorkspaceContext,
} from '@cdp/shared';
import { scopedQuery, encryptSecret, decryptSecret, isEncryptedSecret } from '@cdp/db';

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
/** Resolve a user's email for display: the registered users.email (migration 0031)
 *  first, then the seeded DEV_USERS fixture, then a short non-GUID label. */
async function resolveEmail(pool: Pool, userId: string | undefined): Promise<string> {
  if (!userId) return 'unknown';
  const { rows } = await pool.query<{ email: string | null }>('SELECT email FROM users WHERE id = $1', [userId]);
  return rows[0]?.email ?? emailForUser(userId);
}
/** Resolve an email → user id: a registered user (users.email) first, else DEV_USERS. */
async function resolveUserIdByEmail(pool: Pool, email: string): Promise<string | null> {
  const { rows } = await pool.query<{ id: string }>('SELECT id FROM users WHERE email = $1', [email.trim()]);
  return rows[0]?.id ?? userIdForEmail(email);
}
import { handleAdminAccess, writeAuditEntry } from '@cdp/service-api';
import { recordCrossTenantAccess } from '@cdp/tenancy';
import {
  compileWhere,
  validateAst,
  addManualMembers,
  removeManualMembers,
  evaluateRealtimeSegmentsForProfile,
  buildSegmentMatch,
  type AstNode,
} from '@cdp/segments';
import {
  validateCampaignDefinition,
  enrollFromEvent,
  enrollFromProfileChange,
  enrollFromSegmentChange,
  enrollProfileManually,
  enrollSegmentSnapshot,
  collectSendNodeEnvelopeGaps,
  nextLifecycle,
  campaignCountsShape,
  runEnrollment,
  buildSweepQuery,
  withWorkspaceTx,
  runStatementsInWorkspaceTx as campaignRunnerTx,
  type CampaignLifecycleAction,
  type CampaignCountRow,
  type EnrollDeps,
  type CampaignDefinition,
  type RunDeps,
} from '@cdp/service-campaign-runner';
import { fetchWebhookClient } from '@cdp/runner-webhook';
import { runBroadcast, buildDueScheduledBroadcastsQuery } from '@cdp/service-broadcast';
import {
  computeCostViewForWorkspaces,
  monthBucket,
  DEFAULT_PRICES,
  type MeteringDeps,
} from '@cdp/service-metering';
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

/** Whether a topic id belongs to the active workspace (tenancy guard, inv.2). */
async function topicBelongsToWorkspace(pool: Pool, workspaceId: string, topicId: string): Promise<boolean> {
  const q = scopedQuery(workspaceId, 'SELECT 1 FROM topics WHERE id = $1', [topicId]);
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
  // App-owned profile (display name); identity/email live in the auth provider.
  const prof = await pool.query<{ name: string | null }>('SELECT name FROM users WHERE id = $1', [ctx.userId ?? '']);
  return ok({
    sub: ctx.userId,
    email: await resolveEmail(pool, ctx.userId),
    name: prof.rows[0]?.name ?? null,
    workspace_id: ctx.workspaceId || null,
    workspace_name: workspaceName,
    company_id: companyId,
    company_name: companyName,
    role: ctx.role ?? null,
    is_platform_admin: ctx.isPlatformAdmin,
    memberships: rows.map((r) => ({ workspaceId: r.workspace_id, role: r.role, name: r.name })),
  });
};

/** PATCH /me — the signed-in user edits their OWN profile (display name). Email
 *  and password are managed by the auth provider, not here. Scoped to ctx.userId
 *  (from the token), never a body-supplied id. */
export const updateMe: Handler = async (ctx, pool, req) => {
  if (!ctx.userId) return ok({ error: 'no user' }, 400);
  const name = String(asObject(req.body).name ?? '').trim();
  await pool.query(
    `INSERT INTO users (id, name, updated_at) VALUES ($1, $2, now())
     ON CONFLICT (id) DO UPDATE SET name = $2, updated_at = now()`,
    [ctx.userId, name || null],
  );
  return ok({ name: name || null });
};

// ---------------------------------------------------------------------------
// workspace members + roles (manage_workspace_users)
// ---------------------------------------------------------------------------

/** GET /workspace/members — members of the ACTIVE workspace only (scoped). */
export const listMembers: Handler = async (ctx, pool) => {
  const { rows } = await pool.query<{ user_id: string; role: string }>(
    'SELECT user_id, role, created_at FROM workspace_users WHERE workspace_id = $1 ORDER BY created_at',
    [ctx.workspaceId],
  );
  // Surface each member's EMAIL (registered users.email → DEV_USERS → label),
  // resolved in one batch query rather than per-row.
  const emailById = new Map<string, string>();
  const ids = rows.map((r) => r.user_id);
  if (ids.length) {
    const { rows: urows } = await pool.query<{ id: string; email: string | null }>(
      'SELECT id, email FROM users WHERE id = ANY($1::uuid[])',
      [ids],
    );
    for (const u of urows) if (u.email) emailById.set(u.id, u.email);
  }
  return ok({
    members: rows.map((r) => ({
      user_id: r.user_id,
      role: r.role,
      email: emailById.get(r.user_id) ?? emailForUser(r.user_id),
    })),
  });
};

/** POST /workspace/members — add a member to the active workspace BY EMAIL. */
export const addMember: Handler = async (ctx, pool, req) => {
  const b = asObject(req.body);
  const role = String(b.role ?? 'marketer');
  // Resolve the member by email (the user-facing identifier); user_id is internal
  // and still accepted as a fallback (e.g. direct/e2e callers).
  const email = typeof b.email === 'string' ? b.email : '';
  const userId = email ? await resolveUserIdByEmail(pool, email) : String(b.user_id ?? '');
  if (!userId) {
    return ok({ error: email ? `no user with email ${email}` : 'email required' }, 400);
  }
  // Can't change your OWN role (addMember upserts the role on conflict).
  if (userId === ctx.userId) {
    return ok({ error: 'you cannot change your own role — ask another owner' }, 403);
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
  return ok({ workspaceId: ctx.workspaceId, userId, email: await resolveEmail(pool, userId), role }, 201);
};

/**
 * POST /workspaces — an owner (manage_workspace_users) creates a new workspace IN
 * THEIR OWN company. The company is derived from the active workspace (never the
 * body — CLAUDE.md inv.2); the creator becomes an owner of the new workspace
 * (same company, so the one-company-per-user rule holds).
 */
export const createWorkspace: Handler = async (ctx, pool, req) => {
  const name = typeof asObject(req.body).name === 'string' ? String(asObject(req.body).name).trim() : '';
  if (!name) return ok({ error: 'name required' }, 400);
  const c = await pool.query<{ company_id: string }>('SELECT company_id FROM workspaces WHERE id = $1', [
    ctx.workspaceId,
  ]);
  const companyId = c.rows[0]?.company_id;
  if (!companyId) return ok({ error: 'no active company' }, 400);
  const { rows } = await pool.query<{ id: string; name: string; status: string }>(
    "INSERT INTO workspaces (name, status, company_id) VALUES ($1, 'active', $2) RETURNING id, name, status",
    [name, companyId],
  );
  const wsId = rows[0]!.id;
  if (ctx.userId) {
    await pool.query(
      "INSERT INTO workspace_users (workspace_id, user_id, role) VALUES ($1, $2, 'owner') ON CONFLICT DO NOTHING",
      [wsId, ctx.userId],
    );
  }
  return ok({ workspace: rows[0] }, 201);
};

/** PATCH /workspace/members — change a member's role in the active workspace. */
export const updateMember: Handler = async (ctx, pool, req) => {
  const b = asObject(req.body);
  const userId = String(b.user_id ?? '');
  const role = String(b.role ?? '');
  if (!userId || !role) return ok({ error: 'user_id and role required' }, 400);
  // A user cannot change their OWN role (no self-demotion) — only another owner
  // can change someone's role. Prevents an owner accidentally locking themselves
  // out of ownership.
  if (userId === ctx.userId) {
    return ok({ error: 'you cannot change your own role — ask another owner' }, 403);
  }
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
  return ok({
    settings: {
      ...settings,
      lowercase_emails: settings.lowercase_emails !== false, // default ON
      link_tracking: settings.link_tracking === true, // default OFF
      // The workspace clock for all campaign time math (§9B). Default UTC.
      timezone: typeof settings.timezone === 'string' && settings.timezone ? settings.timezone : 'UTC',
    },
  });
};

/** PUT /workspace/settings — merge allowed settings (owner). */
export const updateWorkspaceSettings: Handler = async (ctx, pool, req) => {
  const b = asObject(req.body);
  const patch: Record<string, unknown> = {};
  if (b.lowercase_emails !== undefined) patch.lowercase_emails = Boolean(b.lowercase_emails);
  if (b.link_tracking !== undefined) patch.link_tracking = Boolean(b.link_tracking);
  if (b.timezone !== undefined) {
    // The workspace timezone (§9B clock). Validate against a real IANA zone before
    // it ever drives campaign waits/windows. workspace_id is taken from ctx only —
    // never from the body (inv.2).
    if (typeof b.timezone !== 'string' || !isValidTimeZone(b.timezone)) {
      return ok({ error: 'invalid timezone (must be a valid IANA zone)' }, 400);
    }
    patch.timezone = b.timezone;
  }
  if (Object.keys(patch).length === 0) return ok({ error: 'no recognized settings' }, 400);
  const { rows } = await pool.query(
    `UPDATE workspaces SET settings = settings || $2::jsonb WHERE id = $1 RETURNING settings`,
    [ctx.workspaceId, JSON.stringify(patch)],
  );
  return ok({ settings: rows[0]?.settings ?? {} });
};


// --- per-company Amazon SES credentials (§10) ----------------------------------
// Each company brings its own SES account (key/secret/region). The secret is
// write-only over the API. The sending-domain handlers build an SES client from
// the active workspace's company config; with no config they fall back to the
// local mock (so dev/tests verify deterministically).

/** The company that owns the active workspace (workspaceId is trusted from the token). */
async function companyIdForWorkspace(pool: Pool, workspaceId: string): Promise<string | null> {
  const { rows } = await pool.query<{ company_id: string | null }>(
    'SELECT company_id FROM workspaces WHERE id = $1',
    [workspaceId],
  );
  return rows[0]?.company_id ?? null;
}

/**
 * Resolve how to talk to SES for a workspace:
 *   - 'real' — the company has Amazon SES credentials → a real SES client.
 *   - 'mock' — ONLY when LOCAL_SES_FORCE_MOCK is set (tests / offline dev): a
 *     deterministic mock so the verify flow can be exercised without AWS.
 *   - 'none' — no credentials and no force-mock → callers must REFUSE to
 *     provision/verify (no simulation), surfacing an error instead.
 */
type SesMode = 'real' | 'mock' | 'none';
async function sesForWorkspace(
  pool: Pool,
  workspaceId: string,
  deps: LocalApiDeps,
): Promise<{ ses: SesEmailClient; mode: SesMode; region: string | null }> {
  const { rows } = await pool.query<{ region: string; access_key_id: string; secret_access_key: string }>(
    `SELECT s.region, s.access_key_id, s.secret_access_key
       FROM company_ses_config s JOIN workspaces w ON w.company_id = s.company_id
      WHERE w.id = $1`,
    [workspaceId],
  );
  const cfg = rows[0];
  if (cfg) {
    // Stored secret is an encryption envelope (legacy plaintext tolerated).
    const secretAccessKey = isEncryptedSecret(cfg.secret_access_key)
      ? decryptSecret(cfg.secret_access_key)
      : cfg.secret_access_key;
    return {
      ses: createSesClient({ region: cfg.region, accessKeyId: cfg.access_key_id, secretAccessKey }),
      mode: 'real',
      region: cfg.region,
    };
  }
  // No real credentials. The local mock is allowed ONLY when explicitly forced
  // (tests / offline dev); otherwise the company must configure SES first.
  if (process.env.LOCAL_SES_FORCE_MOCK) {
    return { ses: deps.onboarding.ses, mode: 'mock', region: process.env.LOCAL_SES_REGION ?? 'il-central-1' };
  }
  return { ses: deps.onboarding.ses, mode: 'none', region: null };
}

const SES_NOT_CONFIGURED =
  'This company has no Amazon SES credentials. Add them in Company settings before setting up a sending domain.';

/**
 * Send a broadcast's queued outbox rows for REAL, right now — mirroring what the
 * deployed Dispatcher Lambda does (suppression → freq-cap → quiet-hours → SES
 * SendEmail → messages_log). In production the dispatcher drains the SQS queue
 * asynchronously; locally there's no queue/loop, so we run the SAME dispatcher
 * core synchronously after the broadcast is queued. Only fires when the
 * workspace's company has REAL SES credentials — with no creds we leave the rows
 * pending (the long-standing local no-op, so dev/e2e are unaffected).
 */
async function dispatchBroadcastNow(
  workspaceId: string,
  pool: Pool,
  deps: LocalApiDeps,
  broadcastId: string,
): Promise<void> {
  // The medium decides whether a local dispatch can actually deliver. EMAIL needs
  // REAL SES creds (mock/none → the long-standing local no-op, rows stay pending).
  // The TEXT channels (sms/whatsapp) ALWAYS deliver locally via the deterministic
  // MOCK channel provider — no credentials needed — so dev/e2e send for real.
  const bcRow = await pool.query<{ medium: string }>(
    'SELECT medium FROM broadcasts WHERE workspace_id = $1 AND id = $2',
    [workspaceId, broadcastId],
  );
  const medium = bcRow.rows[0]?.medium ?? 'email';
  const isText = medium === 'sms' || medium === 'whatsapp';

  const { ses, mode } = await sesForWorkspace(pool, workspaceId, deps);
  // For EMAIL: only real SES creds deliver. For TEXT: always deliver (mock channel),
  // using whatever SES client (the dispatcher never calls SES for a text send).
  if (!isText && mode !== 'real') return;
  const base = process.env.LOCAL_APP_BASE_URL ?? `http://localhost:${process.env.LOCAL_API_PORT ?? '8787'}`;
  const dispatchDeps: DispatchDeps = {
    reader: {
      query: async <T = Record<string, unknown>>(text: string, values?: readonly unknown[]) => {
        const r = await pool.query(text, values ? [...values] : undefined);
        return { rows: r.rows as T[] };
      },
    },
    ses,
    // The mock channel resolver (sms/whatsapp). Deterministic + offline.
    resolveChannel: resolveChannelProvider,
    runInWorkspaceTx: deps.broadcast.runInWorkspaceTx,
    now: () => new Date(),
    unsubscribeBaseUrl: `${base}/unsubscribe`,
    linkTrackingBaseUrl: base,
  };
  const { rows } = await pool.query<{ id: string }>(
    `SELECT id FROM outbox WHERE workspace_id = $1 AND status = 'pending' AND payload->>'broadcast_id' = $2 ORDER BY created_at`,
    [workspaceId, broadcastId],
  );
  // dispatchOutbox never throws on a send failure (it returns retryable-failure
  // and resets the claim), so one bad recipient can't abort the batch.
  for (const r of rows) {
    await dispatchOutbox(dispatchDeps, r.id);
  }
}

/**
 * Send every SCHEDULED broadcast whose time has arrived — the LOCAL equivalent of
 * the production EventBridge "scheduled sweep" (`@cdp/service-broadcast`
 * scheduledSweepHandler), which the dev server has no scheduler to run. For each
 * due broadcast we run it (enqueue → flip status) then dispatch it for real (when
 * the company has SES creds), exactly as the manual Send does. Failures are
 * isolated so one bad broadcast can't abort the sweep. Returns how many it ran.
 */
export async function sweepDueScheduledBroadcasts(pool: Pool, deps: LocalApiDeps): Promise<number> {
  const q = buildDueScheduledBroadcastsQuery(new Date());
  const { rows } = await pool.query<{ id: string }>(q.text, q.values);
  let processed = 0;
  for (const { id } of rows) {
    const w = await pool.query<{ workspace_id: string }>('SELECT workspace_id FROM broadcasts WHERE id = $1', [id]);
    const workspaceId = w.rows[0]?.workspace_id;
    if (!workspaceId) continue;
    try {
      await runBroadcast(deps.broadcast, id);
      await dispatchBroadcastNow(workspaceId, pool, deps, id);
      processed++;
    } catch {
      /* isolate: one failed broadcast must not abort the sweep; next tick retries */
    }
  }
  return processed;
}

/**
 * Dispatch every PENDING CAMPAIGN outbox row for REAL, right now — the campaign
 * twin of dispatchBroadcastNow. Campaign SEND nodes write outbox rows tagged with
 * `payload.campaign_id`; production drains them off SQS via the Dispatcher Lambda,
 * but the dev server has no queue/loop, so we run the SAME dispatcher core
 * synchronously after a sweep tick. Grouped by workspace; only the workspaces
 * whose company has REAL SES credentials actually deliver (mock/none → no-op, the
 * long-standing local behaviour, so a set_attribute/exit-only campaign with NO
 * outbox rows is simply a no-op). Failures are isolated and never thrown.
 */
async function dispatchCampaignOutboxNow(pool: Pool, deps: LocalApiDeps): Promise<void> {
  // Pending campaign outbox rows (a campaign send, not a broadcast), per workspace.
  const { rows } = await pool.query<{ id: string; workspace_id: string }>(
    `SELECT id, workspace_id FROM outbox
     WHERE status = 'pending' AND payload->>'campaign_id' IS NOT NULL
     ORDER BY workspace_id, created_at`,
  );
  if (rows.length === 0) return;
  const base = process.env.LOCAL_APP_BASE_URL ?? `http://localhost:${process.env.LOCAL_API_PORT ?? '8787'}`;
  // Build one DispatchDeps per workspace (its company's SES creds), reusing it for
  // every row in that workspace. Skip workspaces without REAL SES (mock/none).
  const dispatchByWs = new Map<string, DispatchDeps | null>();
  for (const r of rows) {
    let dispatchDeps = dispatchByWs.get(r.workspace_id);
    if (dispatchDeps === undefined) {
      const { ses, mode } = await sesForWorkspace(pool, r.workspace_id, deps);
      dispatchDeps =
        mode !== 'real'
          ? null
          : {
              reader: {
                query: async <T = Record<string, unknown>>(text: string, values?: readonly unknown[]) => {
                  const res = await pool.query(text, values ? [...values] : undefined);
                  return { rows: res.rows as T[] };
                },
              },
              ses,
              runInWorkspaceTx: deps.broadcast.runInWorkspaceTx,
              now: () => new Date(),
              unsubscribeBaseUrl: `${base}/unsubscribe`,
              linkTrackingBaseUrl: base,
            };
      dispatchByWs.set(r.workspace_id, dispatchDeps);
    }
    if (!dispatchDeps) continue; // no real SES for this workspace → leave row pending
    try {
      // dispatchOutbox never throws on a send failure (resets the claim), so one
      // bad recipient can't abort the batch.
      await dispatchOutbox(dispatchDeps, r.id);
    } catch {
      /* isolate: one failed campaign send must not abort the batch */
    }
  }
}

/**
 * Advance every CAMPAIGN ENROLLMENT whose time has arrived — the LOCAL equivalent
 * of the production EventBridge campaign sweep (`@cdp/service-campaign-runner`
 * scheduledSweepHandler → buildSweepQuery → runEnrollment), which the dev server
 * has no scheduler to run. Without this, enrollments are created (the trigger
 * fires) but NEVER advance, so update-profile/wait/send steps never run and
 * journeys never complete. We build a local RunDeps over the pool (the SAME
 * withWorkspaceTx single-tx tick path production uses; a NO-OP SQS sender since
 * local has no queue — we dispatch the outbox synchronously after, like
 * broadcasts) and run each due enrollment, isolating per-row failures. Returns
 * how many enrollments it ticked.
 */
export async function sweepDueCampaignEnrollments(pool: Pool, deps: LocalApiDeps): Promise<number> {
  const runDeps: RunDeps = {
    reader: {
      query: async <T = Record<string, unknown>>(text: string, values?: readonly unknown[]) => {
        const r = await pool.query(text, values ? [...values] : undefined);
        return { rows: r.rows as T[] };
      },
    },
    // Local has no SQS — sends are dispatched synchronously below (like broadcasts).
    // A no-op sender keeps the runner happy (it enqueues the outbox id we then drain).
    sqs: { async send() { return { MessageId: `local-campaign-${Date.now()}` }; } },
    withTx: (fn) => withWorkspaceTx(pool, fn),
    runInWorkspaceTx: (workspaceId, statements) => campaignRunnerTx(pool, workspaceId, statements),
    now: () => new Date(),
    dispatchQueueUrl: process.env.DISPATCH_QUEUE_URL ?? 'local://dispatch',
    webhookClient: fetchWebhookClient(),
    decryptSecret,
    isEncryptedSecret,
  };
  const q = buildSweepQuery(new Date());
  const { rows } = await pool.query<{ id: string }>(q.text, q.values);
  let processed = 0;
  for (const { id } of rows) {
    try {
      await runEnrollment(runDeps, id);
      processed++;
    } catch {
      /* isolate: one bad enrollment must not abort the sweep; next tick retries */
    }
  }
  // Drain any campaign send outbox rows this tick produced (no-op without real SES,
  // and for set_attribute/exit-only campaigns there are none — that's fine).
  try {
    await dispatchCampaignOutboxNow(pool, deps);
  } catch {
    /* isolate: dispatch must not abort the sweep */
  }
  return processed;
}

/** GET /company/ses-config — region + access key id + whether a secret is set (NEVER the secret). */
export const getCompanySesConfig: Handler = async (ctx, pool) => {
  const companyId = await companyIdForWorkspace(pool, ctx.workspaceId);
  if (!companyId) return ok({ configured: false });
  const { rows } = await pool.query<{ region: string; access_key_id: string }>(
    'SELECT region, access_key_id FROM company_ses_config WHERE company_id = $1',
    [companyId],
  );
  const c = rows[0];
  return ok(c ? { configured: true, region: c.region, access_key_id: c.access_key_id } : { configured: false });
};

/** PUT /company/ses-config — set the company's SES credentials. A blank secret on
 *  update keeps the stored one (so you can change region/key without re-entering it). */
export const putCompanySesConfig: Handler = async (ctx, pool, req) => {
  const companyId = await companyIdForWorkspace(pool, ctx.workspaceId);
  if (!companyId) return ok({ error: 'no company for this workspace' }, 400);
  const b = asObject(req.body);
  const region = String(b.region ?? '').trim();
  const accessKeyId = String(b.access_key_id ?? '').trim();
  const secret = typeof b.secret_access_key === 'string' ? b.secret_access_key.trim() : '';
  if (!region || !accessKeyId) return ok({ error: 'region and access key id are required' }, 400);
  const existing = await pool.query<{ secret_access_key: string }>(
    'SELECT secret_access_key FROM company_ses_config WHERE company_id = $1',
    [companyId],
  );
  // A new secret is envelope-encrypted before storage; a blank one keeps the
  // already-encrypted stored value (so you can change region/key alone).
  const effectiveSecret = secret ? encryptSecret(secret) : existing.rows[0]?.secret_access_key;
  if (!effectiveSecret) return ok({ error: 'secret access key is required' }, 400);
  await pool.query(
    `INSERT INTO company_ses_config (company_id, region, access_key_id, secret_access_key, updated_at)
     VALUES ($1, $2, $3, $4, now())
     ON CONFLICT (company_id)
     DO UPDATE SET region = $2, access_key_id = $3, secret_access_key = $4, updated_at = now()`,
    [companyId, region, accessKeyId, effectiveSecret],
  );
  return ok({ configured: true, region, access_key_id: accessKeyId });
};

/** DELETE /company/ses-config — clear the company's SES credentials. */
export const deleteCompanySesConfig: Handler = async (ctx, pool) => {
  const companyId = await companyIdForWorkspace(pool, ctx.workspaceId);
  if (!companyId) return ok({ deleted: 0 });
  const { rowCount } = await pool.query('DELETE FROM company_ses_config WHERE company_id = $1', [companyId]);
  return ok({ deleted: rowCount });
};

// --- sending domains (the LIST; a workspace may have several, §10) -------------
const DOMAIN_RE = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/i;

/** GET /sending-domains — the workspace's sending domains + verification state. */
export const listSendingDomains: Handler = async (ctx, pool) => {
  const q = scopedQuery(ctx.workspaceId, 'SELECT id, domain, verified, verified_at FROM sending_domains');
  const { rows } = await pool.query(`${q.text} ORDER BY domain`, q.values);
  return ok({ domains: rows });
};

/** POST /sending-domains — add a domain to the list, UNVERIFIED. */
export const createSendingDomain: Handler = async (ctx, pool, req) => {
  const domain = String(asObject(req.body).domain ?? '').trim().toLowerCase();
  if (!DOMAIN_RE.test(domain)) return ok({ error: 'a valid domain is required (e.g. mail.acme.com)' }, 400);
  try {
    const { rows } = await pool.query(
      `INSERT INTO sending_domains (workspace_id, domain) VALUES ($1, $2)
       RETURNING id, domain, verified, verified_at`,
      [ctx.workspaceId, domain],
    );
    return ok({ domain: rows[0] }, 201);
  } catch (e) {
    if ((e as { code?: string }).code === '23505') return ok({ error: 'that domain is already in the list' }, 409);
    throw e;
  }
};

interface SendingDomainRow {
  id: string;
  domain: string;
  verified: boolean;
  verified_at: string | null;
  ses_identity: string | null;
  dkim_tokens: string[];
  signing_hosted_zone: string | null;
}

type DnsRecordStatus = 'found' | 'missing' | 'mismatch';
interface DnsRecordOut {
  role: string;
  type: string;
  name: string;
  value: string;
  required: boolean; // required for SES verification (DKIM) vs recommended (SPF/DMARC)
  note?: string;
  status?: DnsRecordStatus; // whether the checker can currently see this record in DNS
}

const stripDot = (s: string): string => s.replace(/\.$/, '').toLowerCase();

// Resolve against PUBLIC DNS (Cloudflare/Google), not the machine's system
// resolver. The system/ISP resolver can lag or negatively-cache a freshly
// published record that's already globally visible — which is why a tool like
// dnschecker.org (which queries public resolvers) finds a record we'd otherwise
// miss. Override with CDP_DNS_SERVERS (comma-separated) if those are blocked.
const DNS_SERVERS = (process.env.CDP_DNS_SERVERS ?? '1.1.1.1,8.8.8.8,1.0.0.1')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
let _resolver: InstanceType<typeof dns.Resolver> | null = null;
function dnsResolver(): InstanceType<typeof dns.Resolver> {
  if (!_resolver) {
    _resolver = new dns.Resolver({ timeout: 4000, tries: 2 });
    if (DNS_SERVERS.length) _resolver.setServers(DNS_SERVERS);
  }
  return _resolver;
}

/** Resolve ONE record in real (public) DNS and report whether the checker sees it. */
async function lookupRecordStatus(rec: DnsRecordOut): Promise<DnsRecordStatus> {
  const resolver = dnsResolver();
  try {
    if (rec.type === 'CNAME') {
      const cnames = await resolver.resolveCname(rec.name);
      if (cnames.some((c) => stripDot(c) === stripDot(rec.value))) return 'found';
      return cnames.length ? 'mismatch' : 'missing';
    }
    if (rec.type === 'TXT') {
      const txts = (await resolver.resolveTxt(rec.name)).map((parts) => parts.join('').trim());
      if (rec.role === 'spf') {
        const spf = txts.find((t) => t.toLowerCase().startsWith('v=spf1'));
        if (!spf) return 'missing';
        return spf.toLowerCase().includes('amazonses.com') ? 'found' : 'mismatch';
      }
      if (rec.role === 'dmarc') {
        return txts.some((t) => t.toLowerCase().startsWith('v=dmarc1')) ? 'found' : 'missing';
      }
      return txts.includes(rec.value) ? 'found' : txts.length ? 'mismatch' : 'missing';
    }
  } catch {
    return 'missing'; // NXDOMAIN / no record / lookup error
  }
  return 'missing';
}

/**
 * Annotate each record with its live DNS status. With a real company SES config
 * we do real DNS lookups; in simulated mode (no SES creds) we report 'found' to
 * stay consistent with the simulated verification.
 */
async function withDnsStatus(
  records: DnsRecordOut[],
  configured: boolean,
  verified: boolean,
): Promise<DnsRecordOut[]> {
  if (!configured) return records.map((r) => ({ ...r, status: 'found' as DnsRecordStatus }));
  return Promise.all(
    records.map(async (r) => {
      // SES is the source of truth for the required DKIM records: once it has
      // CONFIRMED the domain, those records ARE correct — don't let our own
      // resolver (which can lag/cache/diverge from what SES sees) contradict the
      // "verified" status with a scary mismatch. SPF/DMARC keep their real lookup.
      if (verified && r.required) return { ...r, status: 'found' as DnsRecordStatus };
      return { ...r, status: await lookupRecordStatus(r) };
    }),
  );
}

/**
 * The DNS records to publish for a sending domain:
 *  - 3 DKIM CNAMEs (Amazon SES Easy-DKIM) — REQUIRED; SES verifies the domain on
 *    these, and DKIM alignment alone makes DMARC pass.
 *  - SPF (TXT) — recommended; authorizes SES and helps deliverability. Must be
 *    MERGED with any existing SPF (only one SPF record is allowed per name).
 *  - DMARC (TXT) — recommended; sets a policy + enables reporting.
 */
/**
 * The DKIM CNAME target host. PREFERS the `SigningHostedZone` reported by SES
 * (region-specific, authoritative — exactly what the SES console shows), so this
 * works in ANY region a company chooses without us hardcoding a rule. Fallbacks
 * (only when SES didn't report it / local mock): a region-qualified host, then
 * the legacy default.
 */
export function dkimCnameHost(signingHostedZone: string | null, region: string | null): string {
  return signingHostedZone ?? (region ? `dkim.${region}.amazonses.com` : 'dkim.amazonses.com');
}

function dnsRecordsFor(
  domain: string,
  tokens: readonly string[],
  signingHostedZone: string | null,
  region: string | null,
): DnsRecordOut[] {
  const dkimHost = dkimCnameHost(signingHostedZone, region);
  return [
    ...tokens.map((t, i) => ({
      role: `dkim${i + 1}`,
      type: 'CNAME',
      name: `${t}._domainkey.${domain}`,
      value: `${t}.${dkimHost}`,
      required: true,
    })),
    {
      role: 'spf',
      type: 'TXT',
      name: domain,
      value: 'v=spf1 include:amazonses.com ~all',
      required: false,
      note: 'If the domain already has an SPF record, merge this into it — keep only one SPF (TXT) record.',
    },
    {
      role: 'dmarc',
      type: 'TXT',
      name: `_dmarc.${domain}`,
      value: 'v=DMARC1; p=none;',
      required: false,
      note: 'Start with p=none (monitor); tighten to quarantine/reject once you’re confident.',
    },
  ];
}

/**
 * Ensure the domain has an SES identity + DKIM tokens, provisioning ONCE and
 * persisting them. Creating the SES identity returns the tokens; if it already
 * exists, read them back. Re-uses the stored tokens on subsequent calls.
 */
async function ensureSesIdentity(
  ses: SesEmailClient,
  pool: Pool,
  workspaceId: string,
  row: SendingDomainRow,
): Promise<{ identity: string; tokens: string[]; signingHostedZone: string | null }> {
  // Already provisioned: reuse the stored tokens. Backfill the signing hosted
  // zone for rows provisioned before we started capturing it from SES.
  if (row.dkim_tokens.length > 0) {
    const identity = row.ses_identity ?? row.domain;
    if (row.signing_hosted_zone) {
      return { identity, tokens: row.dkim_tokens, signingHostedZone: row.signing_hosted_zone };
    }
    let signingHostedZone: string | null = null;
    try {
      signingHostedZone = (await ses.getIdentityVerificationAttributes(identity)).signingHostedZone ?? null;
    } catch {
      /* SES unreachable — leave null; dnsRecordsFor falls back */
    }
    if (signingHostedZone) {
      const u = scopedQuery(workspaceId, 'UPDATE sending_domains SET signing_hosted_zone = $1 WHERE id = $2', [
        signingHostedZone,
        row.id,
      ]);
      await pool.query(u.text, u.values);
    }
    return { identity, tokens: row.dkim_tokens, signingHostedZone };
  }
  let identity = row.domain;
  let tokens: string[] = [];
  // The CNAME target host comes FROM SES (DkimAttributes.SigningHostedZone) — it's
  // region-specific, so we never hardcode it (this system is multi-region).
  let signingHostedZone: string | null = null;
  try {
    const r = await ses.createDomainIdentity(row.domain);
    identity = r.identity;
    tokens = [...r.dkimTokens];
    signingHostedZone = r.signingHostedZone ?? null;
  } catch {
    // Identity already exists (or transient) — read the tokens back.
    const a = await ses.getIdentityVerificationAttributes(row.domain);
    tokens = [...a.dkimTokens];
    signingHostedZone = a.signingHostedZone ?? null;
  }
  // The create response may omit the hosted zone — read it explicitly if so.
  if (tokens.length > 0 && !signingHostedZone) {
    try {
      signingHostedZone = (await ses.getIdentityVerificationAttributes(identity)).signingHostedZone ?? null;
    } catch {
      /* fall back */
    }
  }
  const upd = scopedQuery(
    workspaceId,
    'UPDATE sending_domains SET ses_identity = $1, dkim_tokens = $2, signing_hosted_zone = $3 WHERE id = $4',
    [identity, tokens, signingHostedZone, row.id],
  );
  await pool.query(upd.text, upd.values);
  return { identity, tokens, signingHostedZone };
}

async function loadSendingDomain(
  pool: Pool,
  workspaceId: string,
  id: string,
): Promise<SendingDomainRow | undefined> {
  const q = scopedQuery(
    workspaceId,
    'SELECT id, domain, verified, verified_at, ses_identity, dkim_tokens, signing_hosted_zone FROM sending_domains WHERE id = $1',
    [id],
  );
  const { rows } = await pool.query<SendingDomainRow>(q.text, q.values);
  return rows[0];
}

/** GET /sending-domains/:id — one domain + the SES DKIM CNAME records to publish. */
export const getSendingDomain: Handler = async (ctx, pool, req, deps) => {
  const row = await loadSendingDomain(pool, ctx.workspaceId, req.params.id!);
  if (!row) return ok({ error: 'not found' }, 404);
  const { ses_identity, dkim_tokens, ...domainOut } = row;
  void ses_identity;
  void dkim_tokens;
  const { ses, mode, region } = await sesForWorkspace(pool, ctx.workspaceId, deps);
  // No SES credentials → don't simulate. Surface the error and show no records so
  // the UI blocks setup until the company configures SES.
  if (mode === 'none') {
    return ok({ domain: domainOut, records: [], sesConfigured: false, sesError: SES_NOT_CONFIGURED });
  }
  try {
    const { tokens, signingHostedZone } = await ensureSesIdentity(ses, pool, ctx.workspaceId, row);
    const records = await withDnsStatus(
      dnsRecordsFor(row.domain, tokens, signingHostedZone, region),
      mode === 'real', // real → live DNS lookups; mock → marked found
      row.verified,
    );
    return ok({ domain: domainOut, records, sesConfigured: mode === 'real' });
  } catch (e) {
    // SES unreachable (e.g. bad company credentials) — return without records.
    return ok({
      domain: domainOut,
      records: [],
      sesConfigured: mode === 'real',
      sesError: e instanceof Error ? e.message : 'SES unavailable',
    });
  }
};

/**
 * POST /sending-domains/:id/check — ask the company's Amazon SES whether the
 * domain's Easy-DKIM is verified. The domain verifies ONLY when SES reports
 * DkimStatus = SUCCESS; there is no manual flip. Once verified it stays verified.
 * With no company SES configured, the local mock is used (dev/tests). Scoped.
 */
export const checkSendingDomain: Handler = async (ctx, pool, req, deps) => {
  const row = await loadSendingDomain(pool, ctx.workspaceId, req.params.id!);
  if (!row) return ok({ error: 'not found' }, 404);
  const { ses, mode, region } = await sesForWorkspace(pool, ctx.workspaceId, deps);
  // No SES credentials → don't simulate a verification; require SES first.
  if (mode === 'none') {
    return ok({ verified: row.verified, sesConfigured: false, error: SES_NOT_CONFIGURED });
  }
  try {
    const { identity, tokens, signingHostedZone } = await ensureSesIdentity(ses, pool, ctx.workspaceId, row);
    const attrs = await ses.getIdentityVerificationAttributes(identity);
    const verified = attrs.dkimStatus === 'SUCCESS';
    if (verified && !row.verified) {
      const upd = scopedQuery(
        ctx.workspaceId,
        'UPDATE sending_domains SET verified = true, verified_at = now() WHERE id = $1',
        [req.params.id!],
      );
      await pool.query(upd.text, upd.values);
    }
    return ok({
      verified: verified || row.verified,
      dkimStatus: attrs.dkimStatus,
      records: await withDnsStatus(
        dnsRecordsFor(row.domain, tokens, attrs.signingHostedZone ?? signingHostedZone, region),
        mode === 'real',
        verified || row.verified,
      ),
      sesConfigured: mode === 'real',
    });
  } catch (e) {
    return ok({ verified: row.verified, sesConfigured: mode === 'real', error: e instanceof Error ? e.message : 'SES check failed' });
  }
};

/** DELETE /sending-domains/:id — remove a domain; blocked if it still has senders. */
export const deleteSendingDomain: Handler = async (ctx, pool, req) => {
  const sel = scopedQuery(ctx.workspaceId, 'SELECT domain FROM sending_domains WHERE id = $1', [req.params.id!]);
  const { rows } = await pool.query<{ domain: string }>(sel.text, sel.values);
  if (!rows[0]) return ok({ error: 'not found' }, 404);
  const cnt = scopedQuery(
    ctx.workspaceId,
    'SELECT count(*)::int AS n FROM domain_senders WHERE domain = $1',
    [rows[0].domain],
  );
  const { rows: cntRows } = await pool.query<{ n: number }>(cnt.text, cnt.values);
  if ((cntRows[0]?.n ?? 0) > 0) {
    return ok({ error: 'remove this domain’s senders before deleting it' }, 409);
  }
  const del = scopedQuery(ctx.workspaceId, 'DELETE FROM sending_domains WHERE id = $1', [req.params.id!]);
  const { rowCount } = await pool.query(del.text, del.values);
  return ok({ deleted: rowCount });
};

// --- domain senders (named "From" identities per sending domain, §10) ----------
// Each row is a display name + a full address; the address's domain is captured
// so the UI can group senders by domain. The address must parse as an email.
const SENDER_EMAIL_RE = /^[^\s@]+@([^\s@]+\.[^\s@]+)$/;

/** GET /domain-senders — the workspace's named senders (grouped client-side by domain). */
export const listDomainSenders: Handler = async (ctx, pool) => {
  const q = scopedQuery(ctx.workspaceId, 'SELECT id, domain, name, email, created_at FROM domain_senders');
  const { rows } = await pool.query(`${q.text} ORDER BY domain, lower(name)`, q.values);
  return ok({ senders: rows });
};

/** POST /domain-senders — add {name, email}; the domain is derived from the address. */
export const createDomainSender: Handler = async (ctx, pool, req) => {
  const b = asObject(req.body);
  const name = String(b.name ?? '').trim();
  const email = String(b.email ?? '').trim().toLowerCase();
  if (!name) return ok({ error: 'sender name is required' }, 400);
  const m = SENDER_EMAIL_RE.exec(email);
  if (!m) return ok({ error: 'a valid email address is required' }, 400);
  const domain = m[1]!;
  // Gate: the address's domain must be a VERIFIED sending domain (§10) — you can
  // queue an unverified domain in the list, but not send as it yet.
  const v = scopedQuery(
    ctx.workspaceId,
    'SELECT verified FROM sending_domains WHERE domain = $1',
    [domain],
  );
  const { rows: vRows } = await pool.query<{ verified: boolean }>(v.text, v.values);
  if (vRows.length === 0) {
    return ok({ error: `add the domain ${domain} to your sending domains first` }, 400);
  }
  if (!vRows[0]!.verified) {
    return ok({ error: `the domain ${domain} is not verified yet` }, 400);
  }
  try {
    const { rows } = await pool.query(
      `INSERT INTO domain_senders (workspace_id, domain, name, email) VALUES ($1, $2, $3, $4)
       RETURNING id, domain, name, email, created_at`,
      [ctx.workspaceId, domain, name, email],
    );
    return ok({ sender: rows[0] }, 201);
  } catch (e) {
    if ((e as { code?: string }).code === '23505') {
      return ok({ error: 'that email is already a sender' }, 409);
    }
    throw e;
  }
};

/** DELETE /domain-senders/:id — remove a sender. Scoped. */
export const deleteDomainSender: Handler = async (ctx, pool, req) => {
  const q = scopedQuery(ctx.workspaceId, 'DELETE FROM domain_senders WHERE id = $1', [req.params.id!]);
  const { rowCount } = await pool.query(q.text, q.values);
  if (!rowCount) return ok({ error: 'not found' }, 404);
  return ok({ deleted: rowCount });
};

// ---------------------------------------------------------------------------
// segments + audiences (manage_content)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// topics (subscription management) — workspace-scoped CRUD (manage_content)
// ---------------------------------------------------------------------------

/** GET /topics?include_archived= — the workspace's topics (active only by default). */
export const listTopics: Handler = async (ctx, pool, req) => {
  const includeArchived = req.query.include_archived === 'true' || req.query.include_archived === '1';
  const q = scopedQuery(
    ctx.workspaceId,
    includeArchived
      ? 'SELECT id, name, description, archived, created_at FROM topics'
      : 'SELECT id, name, description, archived, created_at FROM topics WHERE archived = false',
  );
  const { rows } = await pool.query(`${q.text} ORDER BY created_at DESC`, q.values);
  return ok({ topics: rows });
};

/** POST /topics — create a topic. name required; scoped to the active workspace. */
export const createTopic: Handler = async (ctx, pool, req) => {
  const b = asObject(req.body);
  const name = String(b.name ?? '').trim();
  if (!name) return ok({ error: 'name required' }, 400);
  const description = b.description != null ? String(b.description) : null;
  const { rows } = await pool.query(
    `INSERT INTO topics (workspace_id, name, description)
     VALUES ($1, $2, $3) RETURNING id, name, description, archived, created_at`,
    [ctx.workspaceId, name, description],
  );
  return ok({ topic: rows[0] }, 201);
};

/** PATCH /topics/:id — rename / re-describe / archive. Scoped; a foreign id 404s. */
export const updateTopic: Handler = async (ctx, pool, req) => {
  const id = req.params.id!;
  const b = asObject(req.body);
  const name = b.name !== undefined ? String(b.name).trim() : null;
  if (b.name !== undefined && !name) return ok({ error: 'name required' }, 400);
  const archived = b.archived !== undefined ? Boolean(b.archived) : null;
  const description = b.description !== undefined ? (b.description != null ? String(b.description) : null) : undefined;
  const q = scopedQuery(
    ctx.workspaceId,
    `UPDATE topics SET
       name = COALESCE($1, name),
       description = CASE WHEN $2::boolean THEN $3 ELSE description END,
       archived = COALESCE($4, archived)
     WHERE id = $5`,
    [name, description !== undefined, description ?? null, archived, id],
  );
  const { rowCount } = await pool.query(q.text, q.values);
  if (!rowCount) return ok({ error: 'not found' }, 404);
  const sel = scopedQuery(
    ctx.workspaceId,
    'SELECT id, name, description, archived, created_at FROM topics WHERE id = $1',
    [id],
  );
  const { rows } = await pool.query(sel.text, sel.values);
  return ok({ topic: rows[0] });
};

/** DELETE /topics/:id — hard-delete a topic (its subscription rows cascade). Scoped. */
export const deleteTopic: Handler = async (ctx, pool, req) => {
  const id = req.params.id!;
  // Defensively null out any broadcast/campaign reference so the FK doesn't block
  // (an attached topic just becomes untopiced — sends to everyone not opted out).
  await pool.query('UPDATE broadcasts SET topic_id = NULL WHERE workspace_id = $1 AND topic_id = $2', [ctx.workspaceId, id]);
  await pool.query('UPDATE campaigns SET topic_id = NULL WHERE workspace_id = $1 AND topic_id = $2', [ctx.workspaceId, id]);
  const q = scopedQuery(ctx.workspaceId, 'DELETE FROM topics WHERE id = $1', [id]);
  const { rowCount } = await pool.query(q.text, q.values);
  if (!rowCount) return ok({ error: 'not found' }, 404);
  return ok({ deleted: rowCount });
};

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
  // A dynamic segment with NO rules is an inactive DRAFT (never evaluated, so it
  // never accidentally matches everyone). Manual lists are always active.
  const status = kind === 'dynamic_realtime' && definition === null ? 'draft' : 'active';
  const { rows } = await pool.query<{ id: string; name: string; kind: string; status: string }>(
    `INSERT INTO segments (workspace_id, name, kind, status, definition)
     VALUES ($1, $2, $3, $4, $5::jsonb) RETURNING id, name, kind, status`,
    [ctx.workspaceId, name, kind, status, definition === null ? null : JSON.stringify(definition)],
  );
  // Dynamic membership is NOT materialized on save (it doesn't scale and a
  // time-windowed rule drifts with the clock). Reads resolve the rule LIVE
  // (profile tab, members preview, broadcast at send time); the materialized cache
  // for campaign enter/exit is maintained by the async sweep (later phase).
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
       -- When the rules are (re)set: empty → inactive draft, non-empty → active.
       -- A rename-only update ($3 false) leaves status untouched.
       status = CASE WHEN $3::boolean THEN (CASE WHEN $2 IS NULL THEN 'draft' ELSE 'active' END) ELSE status END,
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
const PREVIEW_PAGE_SIZE = 50;
export const previewSegment: Handler = async (ctx, pool, req) => {
  const b = asObject(req.body);
  const ast = (b.definition ?? null) as AstNode | null;
  const offset = Number.isFinite(Number(b.offset)) ? Math.max(0, Math.floor(Number(b.offset))) : 0;
  const where = compileWhere(ctx.workspaceId, ast);
  const countRes = await pool.query<{ size: number }>(
    `SELECT count(*)::int AS size
       FROM profiles p
       LEFT JOIN profile_features pf ON pf.profile_id = p.id
      WHERE ${where.text}`,
    where.values,
  );
  const size = countRes.rows[0]?.size ?? 0;
  // The page of matching profiles (id, email), 50 per page at the given offset.
  const pageRes = await pool.query<{ id: string; email: string | null }>(
    `SELECT p.id, p.email
       FROM profiles p
       LEFT JOIN profile_features pf ON pf.profile_id = p.id
      WHERE ${where.text}
      ORDER BY p.email
      LIMIT ${PREVIEW_PAGE_SIZE} OFFSET $${where.values.length + 1}`,
    [...where.values, offset],
  );
  return ok({ size, offset, page_size: PREVIEW_PAGE_SIZE, members: pageRes.rows });
};

/** GET /segments/:id/members?offset= — a segment's CURRENT members (50/page). Scoped. */
export const getSegmentMembers: Handler = async (ctx, pool, req) => {
  const id = req.params.id!;
  if (!(await ownsResource(pool, ctx.workspaceId, 'segments', id))) return ok({ error: 'not found' }, 404);
  const offset = Number.isFinite(Number(req.query.offset)) ? Math.max(0, Math.floor(Number(req.query.offset))) : 0;
  const countRes = await pool.query<{ size: number }>(
    'SELECT count(*)::int AS size FROM segment_memberships WHERE workspace_id = $1 AND segment_id = $2',
    [ctx.workspaceId, id],
  );
  const pageRes = await pool.query<{ id: string; email: string | null }>(
    `SELECT p.id, p.email
       FROM segment_memberships sm
       JOIN profiles p ON p.id = sm.profile_id
      WHERE sm.workspace_id = $1 AND sm.segment_id = $2
      ORDER BY p.email
      LIMIT ${PREVIEW_PAGE_SIZE} OFFSET $3`,
    [ctx.workspaceId, id, offset],
  );
  return ok({ size: countRes.rows[0]?.size ?? 0, offset, page_size: PREVIEW_PAGE_SIZE, members: pageRes.rows });
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

/**
 * GET /templates — the LIBRARY templates only. kind='copy' rows (per-broadcast/
 * campaign clones) are working copies, not library entries — they never list.
 */
export const listTemplates: Handler = async (ctx, pool) => {
  const q = scopedQuery(
    ctx.workspaceId,
    "SELECT id, name, updated_at FROM email_templates WHERE kind = 'library'",
  );
  const { rows } = await pool.query(`${q.text} ORDER BY updated_at DESC`, q.values);
  return ok({ templates: rows });
};

export const createTemplate: Handler = async (ctx, pool, req, deps) => {
  const b = asObject(req.body);
  const name = String(b.name ?? 'Untitled');
  const mjml = String(b.mjml ?? '');
  // Compile MJML→HTML server-side (reuse @cdp/email compileMjml via deps). The
  // designer's editable source (design JSON) is stored alongside the derived MJML.
  const compiled = deps.compileMjml(mjml);
  // kind: 'library' (default — shows in the Templates list) or 'copy' (a working
  // copy created from a broadcast/campaign design flow; never listed).
  const kind = b.kind === 'copy' ? 'copy' : 'library';
  // Envelope (lives on the email instance): subject + optional named sender; the
  // To token defaults to {{customer.email}} when not supplied.
  const sender = await validateSenderId(ctx.workspaceId, pool, b.sender_id);
  if ('error' in sender) return ok({ error: sender.error }, 400);
  const { rows } = await pool.query(
    `INSERT INTO email_templates (workspace_id, name, mjml, compiled_html, design, kind, subject, sender_id, to_address, from_selected)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, COALESCE($9, '{{customer.email}}'), $10) RETURNING id, name, updated_at`,
    [
      ctx.workspaceId,
      name,
      mjml,
      compiled,
      b.design === undefined ? null : JSON.stringify(b.design),
      kind,
      b.subject !== undefined && b.subject !== null ? String(b.subject) : null,
      sender.senderId,
      b.to_address !== undefined && b.to_address !== null ? String(b.to_address) : null,
      b.from_selected === true,
    ],
  );
  return ok({ template: rows[0] }, 201);
};

/** GET /templates/:id — one template (MJML + design) for the editor. Scoped. */
export const getTemplate: Handler = async (ctx, pool, req) => {
  const id = req.params.id!;
  const q = scopedQuery(
    ctx.workspaceId,
    'SELECT id, name, mjml, design, kind, source_template_id, subject, sender_id, to_address, from_selected, updated_at FROM email_templates WHERE id = $1',
    [id],
  );
  const { rows } = await pool.query(q.text, q.values);
  if (!rows[0]) return ok({ error: 'not found' }, 404);
  return ok({ template: rows[0] });
};

/** PUT /templates/:id — update name/MJML/design (recompiles HTML server-side). Scoped. */
export const updateTemplate: Handler = async (ctx, pool, req, deps) => {
  const id = req.params.id!;
  const b = asObject(req.body);
  const name = b.name !== undefined ? String(b.name) : null;
  const mjml = b.mjml !== undefined ? String(b.mjml) : null;
  const compiled = mjml !== null ? deps.compileMjml(mjml) : null;
  // Envelope fields use present-flags (like design) so the editor can set/clear
  // them — including unsetting the named sender back to the no-reply fallback.
  const sender = await validateSenderId(ctx.workspaceId, pool, b.sender_id);
  if ('error' in sender) return ok({ error: sender.error }, 400);
  const q = scopedQuery(
    ctx.workspaceId,
    `UPDATE email_templates SET
       name = COALESCE($1, name),
       mjml = COALESCE($2, mjml),
       compiled_html = COALESCE($3, compiled_html),
       design = CASE WHEN $4::boolean THEN $5::jsonb ELSE design END,
       subject = CASE WHEN $7::boolean THEN $8 ELSE subject END,
       sender_id = CASE WHEN $9::boolean THEN $10 ELSE sender_id END,
       to_address = CASE WHEN $11::boolean THEN COALESCE($12, '{{customer.email}}') ELSE to_address END,
       from_selected = CASE WHEN $13::boolean THEN $14 ELSE from_selected END,
       updated_at = now()
     WHERE id = $6`,
    [
      name,
      mjml,
      compiled,
      b.design !== undefined,
      b.design === undefined || b.design === null ? null : JSON.stringify(b.design),
      id,
      b.subject !== undefined,
      b.subject !== undefined && b.subject !== null ? String(b.subject) : null,
      b.sender_id !== undefined,
      sender.senderId,
      b.to_address !== undefined,
      b.to_address !== undefined && b.to_address !== null ? String(b.to_address) : null,
      b.from_selected !== undefined,
      b.from_selected === true,
    ],
  );
  const { rowCount } = await pool.query(q.text, q.values);
  if (!rowCount) return ok({ error: 'not found' }, 404);
  return ok({ updated: rowCount });
};

/**
 * POST /templates/:id/clone — copy a template into a per-broadcast/campaign
 * WORKING COPY (kind='copy', source_template_id = the original). The copy is
 * independently editable with the same designer; the library original stays
 * pristine. Returns the new copy's id. Scoped.
 */
export const cloneTemplate: Handler = async (ctx, pool, req) => {
  const id = req.params.id!;
  const b = asObject(req.body);
  const q = scopedQuery(
    ctx.workspaceId,
    `INSERT INTO email_templates (workspace_id, name, mjml, compiled_html, design, kind, source_template_id, subject, sender_id, to_address, from_selected)
     SELECT workspace_id, COALESCE($2, name), mjml, compiled_html, design, 'copy', id, subject, sender_id, to_address, from_selected
     FROM email_templates WHERE id = $1`,
    [id, b.name !== undefined ? String(b.name) : null],
  );
  // scopedQuery scopes the SELECT; RETURNING rides after the statement text.
  const { rows } = await pool.query(`${q.text} RETURNING id, name`, q.values);
  if (!rows[0]) return ok({ error: 'not found' }, 404);
  return ok({ template: rows[0] }, 201);
};

/**
 * DELETE /templates/:id — delete a LIBRARY template. Per-broadcast/campaign
 * working copies (kind='copy') are NOT user-deletable here; they live and die
 * with their broadcast/campaign. First detach any copies that point home (so the
 * self-FK source_template_id doesn't block the delete); if some other row still
 * references it directly (FK), report it as in-use rather than 500. Scoped.
 */
export const deleteTemplate: Handler = async (ctx, pool, req) => {
  const id = req.params.id!;
  const detach = scopedQuery(
    ctx.workspaceId,
    'UPDATE email_templates SET source_template_id = NULL WHERE source_template_id = $1',
    [id],
  );
  await pool.query(detach.text, detach.values);
  const del = scopedQuery(ctx.workspaceId, "DELETE FROM email_templates WHERE id = $1 AND kind = 'library'", [id]);
  try {
    const { rowCount } = await pool.query(del.text, del.values);
    if (!rowCount) return ok({ error: 'not found' }, 404);
    return ok({ deleted: rowCount });
  } catch (e) {
    if ((e as { code?: string }).code === '23503') {
      return ok({ error: 'This template is in use and cannot be deleted.' }, 409);
    }
    throw e;
  }
};

// ---------------------------------------------------------------------------
// assets (uploaded email images; §11)
// ---------------------------------------------------------------------------

/** Max upload ~2MB of raw bytes (base64 is ~4/3 of that). */
const MAX_ASSET_BASE64 = 3_000_000;
const ALLOWED_ASSET_MIME = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/svg+xml']);

/**
 * POST /assets — upload an image (JSON {filename, mime, data_base64}); returns
 * {id, path} where path is /assets/:id (the client absolutizes against its API
 * base). Serving is public-by-uuid (GET /assets/:id in app.ts — the CloudFront
 * model); upload is capability-gated + workspace-scoped.
 */
/** Normalize a gallery folder: trim, collapse slashes, strip edges; '' = root. */
function normalizeFolder(raw: unknown): string {
  return String(raw ?? '')
    .trim()
    .replace(/\\/g, '/')
    .split('/')
    .map((seg) => seg.trim())
    .filter(Boolean)
    .join('/')
    .slice(0, 120);
}

export const uploadAsset: Handler = async (ctx, pool, req) => {
  const b = asObject(req.body);
  const filename = String(b.filename ?? 'upload');
  const mime = String(b.mime ?? '');
  const data = String(b.data_base64 ?? '');
  const folder = normalizeFolder(b.folder);
  if (!ALLOWED_ASSET_MIME.has(mime)) return ok({ error: `unsupported image type '${mime}'` }, 400);
  if (!data) return ok({ error: 'data_base64 required' }, 400);
  if (data.length > MAX_ASSET_BASE64) return ok({ error: 'image too large (max ~2MB)' }, 413);
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO assets (workspace_id, filename, mime, data, folder) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [ctx.workspaceId, filename, mime, data, folder],
  );
  return ok({ id: rows[0]!.id, path: `/assets/${rows[0]!.id}`, folder }, 201);
};

/**
 * GET /assets — the workspace's image GALLERY (every upload lands here),
 * grouped client-side by folder. Metadata only (the binary serves by uuid).
 */
export const listAssets: Handler = async (ctx, pool) => {
  const q = scopedQuery(
    ctx.workspaceId,
    // size ≈ base64 length × 3/4 (the dev harness stores base64 in-row).
    "SELECT id, filename, mime, folder, created_at, (octet_length(data) * 3 / 4)::int AS size_bytes FROM assets",
  );
  const { rows } = await pool.query(`${q.text} ORDER BY folder, created_at DESC`, q.values);
  // Folders = persisted rows (creatable while still empty) ∪ implicit (in use).
  const fq = scopedQuery(ctx.workspaceId, 'SELECT name FROM asset_folders');
  const { rows: folderRows } = await pool.query<{ name: string }>(fq.text, fq.values);
  const implicit = (rows as Array<{ folder: string }>).map((r) => r.folder).filter(Boolean);
  const folders = [...new Set([...folderRows.map((f) => f.name), ...implicit])].sort();
  return ok({
    assets: (rows as Array<{ id: string }>).map((r) => ({ ...r, path: `/assets/${r.id}` })),
    folders,
  });
};

/**
 * PATCH /assets/:id — rename and/or move an asset to another folder. Scoped.
 * (Serving stays public-by-uuid; the URL doesn't change on rename/move.)
 */
export const updateAsset: Handler = async (ctx, pool, req) => {
  const id = req.params.id!;
  const b = asObject(req.body);
  const filename = b.filename !== undefined ? String(b.filename).trim() : null;
  if (filename !== null && !filename) return ok({ error: 'filename cannot be empty' }, 400);
  const q = scopedQuery(
    ctx.workspaceId,
    `UPDATE assets SET
       filename = COALESCE($1, filename),
       folder = CASE WHEN $2::boolean THEN $3 ELSE folder END
     WHERE id = $4`,
    [filename, b.folder !== undefined, normalizeFolder(b.folder), id],
  );
  const { rowCount } = await pool.query(q.text, q.values);
  if (!rowCount) return ok({ error: 'not found' }, 404);
  return ok({ updated: rowCount });
};

/**
 * DELETE /assets/:id — remove an image from the gallery. DESTRUCTIVE: emails
 * already referencing its URL will lose the image (the UI warns before calling).
 */
export const deleteAsset: Handler = async (ctx, pool, req) => {
  const q = scopedQuery(ctx.workspaceId, 'DELETE FROM assets WHERE id = $1', [req.params.id!]);
  const { rowCount } = await pool.query(q.text, q.values);
  if (!rowCount) return ok({ error: 'not found' }, 404);
  return ok({ deleted: rowCount });
};

/**
 * PATCH /asset-folders — rename a folder path. Cascades to nested subfolders and
 * to every contained asset's folder (prefix rewrite). Body-based (paths contain
 * slashes). Scoped.
 */
export const renameAssetFolder: Handler = async (ctx, pool, req) => {
  const b = asObject(req.body);
  const from = normalizeFolder(b.from);
  const to = normalizeFolder(b.to);
  if (!from || !to) return ok({ error: 'from and to folder names required' }, 400);
  if (from === to) return ok({ renamed: 0 });
  // Rewrite the folder rows (the folder itself + descendants)…
  const f = scopedQuery(
    ctx.workspaceId,
    `UPDATE asset_folders SET name = $1 || substring(name FROM length($2) + 1)
     WHERE name = $2 OR name LIKE $2 || '/%'`,
    [to, from],
  );
  await pool.query(f.text, f.values);
  // …and every contained asset's folder path.
  const a = scopedQuery(
    ctx.workspaceId,
    `UPDATE assets SET folder = $1 || substring(folder FROM length($2) + 1)
     WHERE folder = $2 OR folder LIKE $2 || '/%'`,
    [to, from],
  );
  await pool.query(a.text, a.values);
  // The rename may have merged into an existing folder — dedupe rows (direct
  // query; scopedQuery's unqualified workspace_id would be ambiguous here).
  await pool.query(
    `DELETE FROM asset_folders a USING asset_folders b
     WHERE a.workspace_id = $1 AND b.workspace_id = $1
       AND a.name = b.name AND a.id > b.id`,
    [ctx.workspaceId],
  );
  return ok({ renamed: 1, name: to });
};

/**
 * DELETE /asset-folders — remove a folder. NON-DESTRUCTIVE for images: contained
 * assets (incl. nested) are re-parented to the folder's parent; only the folder
 * rows are removed. Body-based (paths contain slashes). Scoped.
 */
export const deleteAssetFolder: Handler = async (ctx, pool, req) => {
  const name = normalizeFolder(asObject(req.body).name);
  if (!name) return ok({ error: 'folder name required' }, 400);
  const parent = name.includes('/') ? name.slice(0, name.lastIndexOf('/')) : '';
  // Re-parent contained assets: the deleted folder's own assets go to `parent`;
  // nested ones keep their sub-path under `parent` ('a/b/x' − 'a' → 'b/x').
  const a = scopedQuery(
    ctx.workspaceId,
    `UPDATE assets
     SET folder = CASE
       WHEN folder = $1 THEN $2
       WHEN $2 = '' THEN substring(folder FROM length($1) + 2)
       ELSE $2 || '/' || substring(folder FROM length($1) + 2)
     END
     WHERE folder = $1 OR folder LIKE $1 || '/%'`,
    [name, parent],
  );
  await pool.query(a.text, a.values);
  const f = scopedQuery(
    ctx.workspaceId,
    `DELETE FROM asset_folders WHERE name = $1 OR name LIKE $1 || '/%'`,
    [name],
  );
  await pool.query(f.text, f.values);
  return ok({ deleted: 1 });
};

/** POST /asset-folders — create a (possibly still empty) gallery folder. */
export const createAssetFolder: Handler = async (ctx, pool, req) => {
  const name = normalizeFolder(asObject(req.body).name);
  if (!name) return ok({ error: 'folder name required' }, 400);
  await pool.query(
    `INSERT INTO asset_folders (workspace_id, name) VALUES ($1, $2)
     ON CONFLICT (workspace_id, name) DO NOTHING`,
    [ctx.workspaceId, name],
  );
  return ok({ name }, 201);
};

// ---------------------------------------------------------------------------
// broadcasts (manage_content)
// ---------------------------------------------------------------------------

export const listBroadcasts: Handler = async (ctx, pool) => {
  // ORDER BY is appended AFTER scopedQuery builds the WHERE (scopedQuery would
  // otherwise inject its WHERE after the ORDER BY → invalid SQL).
  const q = scopedQuery(
    ctx.workspaceId,
    'SELECT id, name, status, medium, audience_kind, audience_ref, template_id, scheduled_at, scheduled_tz, sent_at, updated_at FROM broadcasts',
  );
  const { rows } = await pool.query<Record<string, unknown>>(`${q.text} ORDER BY created_at DESC`, q.values);

  // Per-broadcast metrics. Delivered/Failed come from SES feedback (email_events
  // joined to messages_log by ses_message_id); Clicked sums our tracked-link hits.
  // count(distinct m.id) avoids over-counting when a message has several events.
  // (Workspace-scoped explicitly — scopedQuery can't wrap a GROUP BY/JOIN. At
  // scale these would be denormalized counters; a grouped query is fine for now.)
  const { rows: statRows } = await pool.query<{
    broadcast_id: string;
    sent: number;
    delivered: number;
    failed: number;
  }>(
    `SELECT m.broadcast_id,
            count(DISTINCT m.id)::int AS sent,
            count(DISTINCT m.id) FILTER (WHERE ev.type = 'delivery')::int AS delivered,
            count(DISTINCT m.id) FILTER (WHERE ev.type IN ('bounce','complaint'))::int AS failed
       FROM messages_log m
       LEFT JOIN email_events ev
         ON ev.workspace_id = m.workspace_id AND ev.ses_message_id = m.ses_message_id
      WHERE m.workspace_id = $1 AND m.broadcast_id IS NOT NULL
      GROUP BY m.broadcast_id`,
    [ctx.workspaceId],
  );
  const { rows: clickRows } = await pool.query<{ broadcast_id: string; clicked: number }>(
    `SELECT broadcast_id, sum(clicks)::int AS clicked
       FROM tracked_links
      WHERE workspace_id = $1 AND broadcast_id IS NOT NULL
      GROUP BY broadcast_id`,
    [ctx.workspaceId],
  );
  // Opened = DISTINCT profiles that loaded the open pixel (opens > 0); the pixel
  // row is pre-created at send (opens=0) so an unopened send doesn't count. One
  // tracked_opens row per (broadcast, profile) ⇒ counting rows = distinct opens.
  const { rows: openRows } = await pool.query<{ broadcast_id: string; opened: number }>(
    `SELECT broadcast_id, count(*)::int AS opened
       FROM tracked_opens
      WHERE workspace_id = $1 AND broadcast_id IS NOT NULL AND opens > 0
      GROUP BY broadcast_id`,
    [ctx.workspaceId],
  );
  // Unsubscribed = email_events 'unsubscribe' rows attributed to the broadcast
  // (written by the unsubscribe POST when the link carried the broadcast id).
  const { rows: unsubRows } = await pool.query<{ broadcast_id: string; unsubscribed: number }>(
    `SELECT broadcast_id, count(*)::int AS unsubscribed
       FROM email_events
      WHERE workspace_id = $1 AND broadcast_id IS NOT NULL AND type = 'unsubscribe'
      GROUP BY broadcast_id`,
    [ctx.workspaceId],
  );
  const statBy = new Map(statRows.map((s) => [s.broadcast_id, s]));
  const clickBy = new Map(clickRows.map((c) => [c.broadcast_id, c.clicked]));
  const openBy = new Map(openRows.map((o) => [o.broadcast_id, o.opened]));
  const unsubBy = new Map(unsubRows.map((u) => [u.broadcast_id, u.unsubscribed]));

  const broadcasts = rows.map((b) => {
    const s = statBy.get(b.id as string);
    return {
      ...b,
      stats: {
        sent: s?.sent ?? 0,
        delivered: s?.delivered ?? 0,
        failed: s?.failed ?? 0,
        clicked: clickBy.get(b.id as string) ?? 0,
        opened: openBy.get(b.id as string) ?? 0,
        unsubscribed: unsubBy.get(b.id as string) ?? 0,
      },
    };
  });
  return ok({ broadcasts });
};

/** GET /broadcasts/:id — one broadcast for the editor (scoped). */
export const getBroadcast: Handler = async (ctx, pool, req) => {
  const id = req.params.id!;
  const q = scopedQuery(
    ctx.workspaceId,
    'SELECT id, name, status, medium, text_body, topic_id, audience_kind, audience_ref, template_id, scheduled_at, scheduled_tz FROM broadcasts WHERE id = $1',
    [id],
  );
  const { rows } = await pool.query(q.text, q.values);
  if (!rows[0]) return ok({ error: 'not found' }, 404);
  return ok({ broadcast: rows[0] });
};

/**
 * GET /broadcasts/:id/preview — a READ-ONLY view of the email that was (or will
 * be) sent: the envelope (resolved From / To / Subject), the audience name, and
 * the compiled HTML body. The From is resolved exactly as the dispatcher does —
 * a named sender if the template has one, else `no-reply@<verified domain>`.
 */
export const previewBroadcast: Handler = async (ctx, pool, req) => {
  const id = req.params.id!;
  const bq = scopedQuery(
    ctx.workspaceId,
    'SELECT name, status, sent_at, scheduled_at, scheduled_tz, audience_kind, audience_ref, template_id FROM broadcasts WHERE id = $1',
    [id],
  );
  const b = (await pool.query(bq.text, bq.values)).rows[0] as
    | {
        name: string;
        status: string;
        sent_at: string | null;
        scheduled_at: string | null;
        scheduled_tz: string | null;
        audience_kind: string;
        audience_ref: string | null;
        template_id: string | null;
      }
    | undefined;
  if (!b) return ok({ error: 'not found' }, 404);

  let subject = '';
  let html = '';
  let toAddress = '';
  let senderId: string | null = null;
  if (b.template_id) {
    const tq = scopedQuery(
      ctx.workspaceId,
      'SELECT subject, compiled_html, to_address, sender_id FROM email_templates WHERE id = $1',
      [b.template_id],
    );
    const t = (await pool.query(tq.text, tq.values)).rows[0] as
      | { subject: string | null; compiled_html: string | null; to_address: string | null; sender_id: string | null }
      | undefined;
    if (t) {
      subject = t.subject ?? '';
      html = t.compiled_html ?? '';
      toAddress = t.to_address ?? '';
      senderId = t.sender_id ?? null;
    }
  }

  // Resolve From the way the dispatcher does: named sender → no-reply@<verified domain>.
  let from = '';
  if (senderId) {
    const sq = scopedQuery(ctx.workspaceId, 'SELECT name, email FROM domain_senders WHERE id = $1', [senderId]);
    const s = (await pool.query(sq.text, sq.values)).rows[0] as { name: string | null; email: string } | undefined;
    if (s) from = s.name ? `${s.name} <${s.email}>` : s.email;
  }
  if (!from) {
    // Explicit workspace scoping (scopedQuery wraps everything after WHERE in
    // parens, which would swallow ORDER BY/LIMIT into the condition).
    const d = (
      await pool.query<{ domain: string }>(
        'SELECT domain FROM sending_domains WHERE workspace_id = $1 AND verified = true ORDER BY domain LIMIT 1',
        [ctx.workspaceId],
      )
    ).rows[0];
    from = d ? `no-reply@${d.domain}` : 'no-reply (no verified domain)';
  }

  let audience = '—';
  if (b.audience_kind === 'segment' && b.audience_ref) {
    const segq = scopedQuery(ctx.workspaceId, 'SELECT name FROM segments WHERE id = $1', [b.audience_ref]);
    const seg = (await pool.query(segq.text, segq.values)).rows[0] as { name: string } | undefined;
    audience = seg?.name ?? '—';
  }

  return ok({
    name: b.name,
    status: b.status,
    sent_at: b.sent_at,
    scheduled_at: b.scheduled_at,
    scheduled_tz: b.scheduled_tz,
    subject,
    from,
    to_address: toAddress,
    audience,
    html,
  });
};

/** A scheduled_at present → status 'scheduled', else 'draft' (a not-yet-sent broadcast). */
function scheduleStatus(scheduledAt: string | null): 'draft' | 'scheduled' {
  return scheduledAt ? 'scheduled' : 'draft';
}

/** A scheduled send must be at least this far in the future (mirrors the wizard). */
const MIN_SCHEDULE_LEAD_MS = 5 * 60 * 1000;

/** Returns an error string when a scheduled_at is set but is invalid or sooner
 *  than the minimum lead time from now; null when absent or far enough out. */
function scheduleLeadError(scheduledAt: string | null): string | null {
  if (!scheduledAt) return null;
  const t = new Date(scheduledAt).getTime();
  if (Number.isNaN(t)) return 'scheduled_at is not a valid time';
  if (t < Date.now() + MIN_SCHEDULE_LEAD_MS) {
    return 'A broadcast must be scheduled at least 5 minutes from now.';
  }
  return null;
}

/**
 * Validate a client-supplied sender_id: it must be one of the WORKSPACE's named
 * senders (never trust a cross-workspace id — inv.2). Returns the id (or null
 * when absent/blank), or an error string when it isn't this workspace's sender.
 */
async function validateSenderId(
  workspaceId: string,
  pool: Pool,
  raw: unknown,
): Promise<{ senderId: string | null } | { error: string }> {
  if (raw === undefined || raw === null || raw === '') return { senderId: null };
  const senderId = String(raw);
  const q = scopedQuery(workspaceId, 'SELECT 1 FROM domain_senders WHERE id = $1', [senderId]);
  const { rowCount } = await pool.query(q.text, q.values);
  if (!rowCount) return { error: 'sender_id is not a sender in this workspace' };
  return { senderId };
}

export const createBroadcast: Handler = async (ctx, pool, req) => {
  const b = asObject(req.body);
  const scheduledAt = b.scheduled_at ? String(b.scheduled_at) : null;
  const leadErr = scheduleLeadError(scheduledAt);
  if (leadErr) return ok({ error: leadErr }, 400);
  // The zone is only meaningful alongside a scheduled time.
  const scheduledTz = scheduledAt && b.scheduled_tz ? String(b.scheduled_tz) : null;
  // The sending channel (email default). Email uses its template instance; the
  // text channels (sms/whatsapp) carry a plain-text body. An unknown medium falls
  // back to email (the check constraint also enforces it).
  const medium = b.medium === 'sms' || b.medium === 'whatsapp' ? String(b.medium) : 'email';
  const textBody = medium === 'email' ? null : b.text_body != null ? String(b.text_body) : null;
  // An optional TOPIC tag (subscription gating). A cross-workspace topic id is
  // rejected — workspace from the token, never trusted from the body (inv.2).
  const topicId = b.topic_id != null ? String(b.topic_id) : null;
  if (topicId && !(await topicBelongsToWorkspace(pool, ctx.workspaceId, topicId)))
    return ok({ error: 'unknown topic' }, 400);
  const { rows } = await pool.query(
    `INSERT INTO broadcasts (workspace_id, name, medium, text_body, template_id, topic_id, audience_kind, audience_ref, scheduled_at, scheduled_tz, status, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING id, name, status, medium`,
    [
      ctx.workspaceId,
      String(b.name ?? 'Untitled'),
      medium,
      textBody,
      b.template_id ?? null,
      topicId,
      String(b.audience_kind ?? 'segment'),
      b.audience_ref ?? null,
      scheduledAt,
      scheduledTz,
      scheduleStatus(scheduledAt),
      ctx.userId ?? null,
    ],
  );
  return ok({ broadcast: rows[0] }, 201);
};

/**
 * PUT /broadcasts/:id — edit a broadcast, allowed ONLY while it is draft or
 * scheduled (a sending/sent/cancelled broadcast is immutable). Scoped to the
 * token's workspace; status is recomputed from scheduled_at.
 */
export const updateBroadcast: Handler = async (ctx, pool, req) => {
  const id = req.params.id!;
  const b = asObject(req.body);
  const cur = scopedQuery(ctx.workspaceId, 'SELECT status FROM broadcasts WHERE id = $1', [id]);
  const { rows: curRows } = await pool.query<{ status: string }>(cur.text, cur.values);
  if (!curRows[0]) return ok({ error: 'not found' }, 404);
  if (curRows[0].status !== 'draft' && curRows[0].status !== 'scheduled') {
    return ok({ error: `a ${curRows[0].status} broadcast can no longer be edited` }, 409);
  }
  const scheduledAt = b.scheduled_at ? String(b.scheduled_at) : null;
  const leadErr = scheduleLeadError(scheduledAt);
  if (leadErr) return ok({ error: leadErr }, 400);
  const scheduledTz = scheduledAt && b.scheduled_tz ? String(b.scheduled_tz) : null;
  // medium/text_body are COALESCE-updated only when provided (so an email-only
  // edit can't accidentally null them); a provided medium of 'email' clears the body.
  const medium =
    b.medium === 'sms' || b.medium === 'whatsapp' || b.medium === 'email' ? String(b.medium) : null;
  const textBodyProvided = b.text_body !== undefined;
  const textBody =
    medium === 'email' ? null : textBodyProvided ? (b.text_body != null ? String(b.text_body) : null) : null;
  // topic_id is updated only when the key is present; a cross-workspace id is
  // rejected (inv.2). `topic_id: null` explicitly clears the tag.
  const topicProvided = b.topic_id !== undefined;
  const topicId = topicProvided && b.topic_id != null ? String(b.topic_id) : null;
  if (topicId && !(await topicBelongsToWorkspace(pool, ctx.workspaceId, topicId)))
    return ok({ error: 'unknown topic' }, 400);
  const upd = scopedQuery(
    ctx.workspaceId,
    `UPDATE broadcasts SET
       name = COALESCE($1, name),
       audience_kind = COALESCE($2, audience_kind),
       audience_ref = COALESCE($3, audience_ref),
       template_id = $4,
       scheduled_at = $5,
       scheduled_tz = $6,
       status = $7,
       medium = COALESCE($9, medium),
       text_body = CASE WHEN $9 = 'email' THEN NULL WHEN $10 THEN $11 ELSE text_body END,
       topic_id = CASE WHEN $12::boolean THEN $13 ELSE topic_id END,
       updated_at = now()
     WHERE id = $8`,
    [
      b.name !== undefined ? String(b.name) : null,
      b.audience_kind !== undefined ? String(b.audience_kind) : null,
      b.audience_ref ?? null,
      b.template_id ?? null,
      scheduledAt,
      scheduledTz,
      scheduleStatus(scheduledAt),
      id,
      medium,
      textBodyProvided,
      textBody,
      topicProvided,
      topicId,
    ],
  );
  const { rowCount } = await pool.query(upd.text, upd.values);
  return ok({ updated: rowCount ?? 0 });
};

/**
 * POST /broadcasts/:id/duplicate — copy a broadcast into a fresh DRAFT so you can
 * tweak + resend without touching the source. Each broadcast owns its email, so
 * we clone the source's template into a new working copy (the duplicate's edits
 * never affect the original's email). Scoped.
 */
export const duplicateBroadcast: Handler = async (ctx, pool, req) => {
  const id = req.params.id!;
  const src = scopedQuery(
    ctx.workspaceId,
    'SELECT name, template_id, audience_kind, audience_ref, medium, text_body, topic_id FROM broadcasts WHERE id = $1',
    [id],
  );
  const b = (await pool.query(src.text, src.values)).rows[0] as
    | {
        name: string;
        template_id: string | null;
        audience_kind: string;
        audience_ref: string;
        medium: string;
        text_body: string | null;
        topic_id: string | null;
      }
    | undefined;
  if (!b) return ok({ error: 'not found' }, 404);

  let templateId: string | null = null;
  if (b.template_id) {
    const cl = scopedQuery(
      ctx.workspaceId,
      `INSERT INTO email_templates (workspace_id, name, mjml, compiled_html, design, kind, source_template_id, subject, sender_id, to_address, from_selected)
       SELECT workspace_id, name, mjml, compiled_html, design, 'copy', id, subject, sender_id, to_address, from_selected
       FROM email_templates WHERE id = $1`,
      [b.template_id],
    );
    const t = (await pool.query(`${cl.text} RETURNING id`, cl.values)).rows[0] as { id: string } | undefined;
    templateId = t?.id ?? null;
  }
  const { rows } = await pool.query(
    `INSERT INTO broadcasts (workspace_id, name, template_id, audience_kind, audience_ref, medium, text_body, topic_id, status, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'draft', $9) RETURNING id, name, status, medium`,
    [
      ctx.workspaceId,
      `${b.name} (copy)`,
      templateId,
      b.audience_kind,
      b.audience_ref,
      b.medium,
      b.text_body,
      b.topic_id,
      ctx.userId ?? null,
    ],
  );
  return ok({ broadcast: rows[0] }, 201);
};

/**
 * DELETE /broadcasts/:id — delete an UNSENT broadcast (draft or scheduled ONLY; a
 * sending/sent/cancelled broadcast is history and is never deletable). Also drops
 * the broadcast's private working-copy email when nothing else references it. Scoped.
 */
export const deleteBroadcast: Handler = async (ctx, pool, req) => {
  const id = req.params.id!;
  const cur = scopedQuery(ctx.workspaceId, 'SELECT status, template_id FROM broadcasts WHERE id = $1', [id]);
  const row = (await pool.query(cur.text, cur.values)).rows[0] as
    | { status: string; template_id: string | null }
    | undefined;
  if (!row) return ok({ error: 'not found' }, 404);
  if (row.status !== 'draft' && row.status !== 'scheduled') {
    return ok({ error: `a ${row.status} broadcast can’t be deleted` }, 409);
  }
  const del = scopedQuery(ctx.workspaceId, 'DELETE FROM broadcasts WHERE id = $1', [id]);
  await pool.query(del.text, del.values);
  // Clean up the now-orphaned working copy (only if no other broadcast uses it).
  if (row.template_id) {
    await pool.query(
      `DELETE FROM email_templates t
        WHERE t.workspace_id = $1 AND t.id = $2 AND t.kind = 'copy'
          AND NOT EXISTS (SELECT 1 FROM broadcasts b WHERE b.workspace_id = $1 AND b.template_id = $2)`,
      [ctx.workspaceId, row.template_id],
    );
  }
  return ok({ deleted: 1 });
};

/** POST /broadcasts/:id/send — runs the broadcast core (SQS mocked at the boundary). */
export const sendBroadcast: Handler = async (ctx, pool, req, deps) => {
  const id = req.params.id!;
  // CRITICAL (CLAUDE.md inv.2): runBroadcast loads workspace_id FROM the broadcast
  // row, so it would happily send ANY broadcast id regardless of the caller's
  // active workspace. We MUST first confirm the target broadcast belongs to the
  // token's workspace (NEVER the body). If not, return 404 without revealing that
  // the id exists in another workspace, and never invoke the broadcast core.
  // The subject lives on the email instance (template). Join it so we can both
  // confirm the broadcast is in this workspace AND that its email has a subject.
  // (Explicit b.workspace_id scope — scopedQuery's unqualified column would be
  // ambiguous across the JOIN.)
  const { rows: guardRows } = await pool.query<{
    medium: string;
    text_body: string | null;
    template_id: string | null;
    subject: string | null;
    sender_id: string | null;
    to_address: string | null;
  }>(
    `SELECT b.medium, b.text_body, b.template_id, t.subject, t.sender_id, t.to_address FROM broadcasts b
       LEFT JOIN email_templates t ON t.id = b.template_id AND t.workspace_id = b.workspace_id
      WHERE b.workspace_id = $1 AND b.id = $2`,
    [ctx.workspaceId, id],
  );
  if (!guardRows[0]) return ok({ error: 'not found' }, 404);
  const medium = guardRows[0].medium;
  if (medium === 'sms' || medium === 'whatsapp') {
    // TEXT channels: the ONLY gate is a non-blank message body. No envelope (From/
    // To/Subject) and NO verified-domain gate — those are email-only (a verified
    // sending domain is meaningless for SMS/WhatsApp; the provider always resolves).
    if (!guardRows[0].text_body || !guardRows[0].text_body.trim()) {
      return ok({ error: 'Add a message body before sending.' }, 409);
    }
  } else {
    // EMAIL: From / To / Subject are ALL required, set on the email itself (the
    // editor). The From must be a real named sender — there is no no-reply fallback.
    if (!guardRows[0].sender_id) {
      return ok({ error: 'Choose who the email is from — open the email and pick a sender (add one under Sending domains).' }, 409);
    }
    if (!guardRows[0].to_address || !guardRows[0].to_address.trim()) {
      return ok({ error: 'Set the To field on the email before sending.' }, 409);
    }
    if (!guardRows[0].subject || !guardRows[0].subject.trim()) {
      return ok({ error: 'Add a subject line to the email before sending.' }, 409);
    }
    // Pre-send gate (§10/inv.7): refuse to send unless this workspace has a VERIFIED
    // sending domain. (Sends ultimately go through the Dispatcher, but enforce here
    // too so a broadcast is never queued/marked sent with no way to actually send.)
    // (No LIMIT in the fragment — scopedQuery wraps everything after WHERE.)
    const vq = scopedQuery(ctx.workspaceId, 'SELECT 1 FROM sending_domains WHERE verified = true');
    const verified = await pool.query(vq.text, vq.values);
    if (!verified.rowCount) {
      return ok(
        { error: 'No verified sending domain. Verify one in Workspace settings → Sending domains before sending.' },
        409,
      );
    }
  }
  const result = await runBroadcast(deps.broadcast, id);
  // Production parity: actually deliver via SES now (when the workspace has SES
  // creds). With no creds this is a no-op and the rows stay queued.
  await dispatchBroadcastNow(ctx.workspaceId, pool, deps, id);
  return ok({ result });
};

// ---------------------------------------------------------------------------
// campaigns (manage_content)
// ---------------------------------------------------------------------------

export const listCampaigns: Handler = async (ctx, pool) => {
  // ORDER BY is appended AFTER scopedQuery builds the WHERE (scopedQuery anchors
  // the workspace_id clause at the tail when the fragment has no WHERE of its own).
  // `published` (active_version_id IS NOT NULL) lets the UI choose Delete (a
  // never-published draft) vs Archive (a published campaign — history, never
  // hard-deleted). It rides the same workspace-scoped SELECT.
  // `hasDraft` mirrors getCampaign: an unsaved draft exists when draft_definition
  // is NOT NULL and differs from the live definition (a no-op draft reads as none).
  // It (and status === 'draft') drives the list's "Publish…" affordance.
  const q = scopedQuery(
    ctx.workspaceId,
    `SELECT id, name, status, (active_version_id IS NOT NULL) AS published,
            (draft_definition IS NOT NULL AND draft_definition::text IS DISTINCT FROM definition::text) AS "hasDraft"
     FROM campaigns`,
  );
  const { rows } = await pool.query<{
    id: string;
    name: string;
    status: string;
    published: boolean;
    hasDraft: boolean;
  }>(
    `${q.text} ORDER BY created_at DESC`,
    q.values,
  );
  // Per-campaign enrollment counts in ONE workspace-scoped round-trip: GROUP BY
  // (campaign_id, status) over campaign_enrollments, then fold into {active,
  // completed, exited, failed} (defaulting all-zero) via the pure shaper. Scoped
  // to ctx.workspaceId so a campaign never sums another tenant's enrollments.
  // GROUP BY is appended AFTER scopedQuery anchors the workspace_id WHERE at the
  // tail (a fragment with no WHERE of its own).
  const cq = scopedQuery(ctx.workspaceId, 'SELECT campaign_id, status, count(*)::int AS n FROM campaign_enrollments');
  const { rows: countRows } = await pool.query<CampaignCountRow>(
    `${cq.text} GROUP BY campaign_id, status`,
    cq.values,
  );
  const byCampaign = campaignCountsShape(countRows);
  const zero = { active: 0, completed: 0, exited: 0, failed: 0 };
  const campaigns = rows.map((c) => ({ ...c, counts: byCampaign[c.id] ?? zero }));
  return ok({ campaigns });
};

/**
 * POST /campaigns/:id/{pause,resume,archive} — campaign LIFECYCLE transitions
 * (§9B phase 7). Each is workspace-scoped (the campaign must resolve INSIDE
 * ctx.workspaceId — a foreign id 404s, inv.1/inv.2; workspace_id is NEVER taken
 * from the body) and capability-gated (manage_content, in routes.ts). The pure
 * `nextLifecycle` transition table decides: an illegal transition (e.g. resume a
 * non-paused campaign) is a typed 409; an idempotent no-op (pause a paused one)
 * is a 200. The runner reads campaigns.status inside its locked tick, so pausing
 * halts advancement without touching in-flight enrollment rows.
 */
function makeLifecycleHandler(action: CampaignLifecycleAction): Handler {
  return async (ctx, pool, req) => {
    const id = req.params.id!;
    const sel = scopedQuery(ctx.workspaceId, 'SELECT status FROM campaigns WHERE id = $1', [id]);
    const { rows } = await pool.query<{ status: string }>(sel.text, sel.values);
    if (rows.length === 0) return ok({ error: 'not found' }, 404);
    const decision = nextLifecycle(rows[0]!.status, action);
    if (!decision.ok) return ok({ error: decision.reason }, 409);
    if (!decision.noop) {
      const upd = scopedQuery(ctx.workspaceId, 'UPDATE campaigns SET status = $1 WHERE id = $2', [decision.next, id]);
      await pool.query(upd.text, upd.values);
    }
    return ok({ status: decision.next });
  };
}

export const pauseCampaign: Handler = makeLifecycleHandler('pause');
export const resumeCampaign: Handler = makeLifecycleHandler('resume');
export const archiveCampaign: Handler = makeLifecycleHandler('archive');

/**
 * DELETE /campaigns/:id — HARD-delete a campaign that was NEVER PUBLISHED
 * (active_version_id IS NULL: it was only ever a draft). A campaign that HAS
 * been published is history — it is never hard-deleted; archive it instead
 * (409). Workspace-scoped: the campaign must resolve INSIDE ctx.workspaceId (a
 * foreign/missing id 404s, inv.1/inv.2 — workspace_id is NEVER taken from the
 * body) and capability-gated (manage_content, routes.ts).
 *
 * The delete runs in ONE workspace-scoped tx: drop any campaign_enrollments
 * (defensive — a never-published campaign has none, and the FK is NOT NULL with
 * no cascade) then the campaign row. campaign_versions ON DELETE CASCADE handles
 * any draft-saved snapshots (there shouldn't be any since it was never published).
 */
export const deleteCampaign: Handler = async (ctx, pool, req) => {
  const id = req.params.id!;
  const sel = scopedQuery(
    ctx.workspaceId,
    'SELECT active_version_id FROM campaigns WHERE id = $1',
    [id],
  );
  const row = (await pool.query(sel.text, sel.values)).rows[0] as
    | { active_version_id: string | null }
    | undefined;
  if (!row) return ok({ error: 'not found' }, 404);
  if (row.active_version_id !== null) {
    return ok({ error: "A published campaign can't be deleted — archive it instead." }, 409);
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const delEnroll = scopedQuery(ctx.workspaceId, 'DELETE FROM campaign_enrollments WHERE campaign_id = $1', [id]);
    await client.query(delEnroll.text, delEnroll.values);
    const delCamp = scopedQuery(ctx.workspaceId, 'DELETE FROM campaigns WHERE id = $1', [id]);
    await client.query(delCamp.text, delCamp.values);
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
  return ok({ deleted: 1 });
};

/**
 * GET /campaigns/:id — the full campaign + its definition for the builder to
 * reload/round-trip (§9B phase 5). Scoped to the TOKEN's workspace
 * (ctx.workspaceId, NEVER a body/query workspace_id — inv.1/inv.2): a campaign in
 * another workspace 404s. The `definition` jsonb is returned verbatim so the
 * canvas reconstructs the same DSL graph it saved.
 */
export const getCampaign: Handler = async (ctx, pool, req) => {
  const id = req.params.id!;
  // A JOIN makes `workspace_id` ambiguous for scopedQuery's injected predicate, so
  // bind the workspace scope explicitly on the campaign (c.workspace_id at $1).
  const { rows } = await pool.query<{
    id: string;
    name: string;
    status: string;
    definition: CampaignDefinition;
    draft_definition: CampaignDefinition | null;
    trigger_segment_id: string | null;
    draft_trigger_segment_id: string | null;
    trigger_on: string | null;
    keep_while_in_segment: string | null;
    active_version_id: string | null;
    active_version: number | null;
    active_version_name: string | null;
  }>(
    `SELECT c.id, c.name, c.status, c.definition, c.draft_definition, c.trigger_segment_id,
            c.draft_trigger_segment_id, c.trigger_on, c.keep_while_in_segment, c.active_version_id,
            av.version AS active_version, av.name AS active_version_name
     FROM campaigns c
     LEFT JOIN campaign_versions av ON av.id = c.active_version_id AND av.workspace_id = c.workspace_id
     WHERE c.workspace_id = $1 AND c.id = $2`,
    [ctx.workspaceId, id],
  );
  if (rows.length === 0) return ok({ error: 'campaign not found' }, 404);
  // The workspace timezone (§9B clock) is needed by the wait-until / hour-window
  // editors, which run under manage_content (GET /workspace/settings is gated on
  // manage_workspace_users a marketer lacks) — surface it here, workspace-scoped.
  const tzRow = await pool.query<{ settings: Record<string, unknown> | null }>(
    'SELECT settings FROM workspaces WHERE id = $1',
    [ctx.workspaceId],
  );
  const settings = tzRow.rows[0]?.settings ?? {};
  const timezone = typeof settings.timezone === 'string' && settings.timezone ? settings.timezone : 'UTC';

  // The builder edits the DRAFT (the in-progress working copy); when there's no
  // unsaved draft the draft IS the live definition. hasDraft is true only when a
  // draft exists AND differs from live (a no-op draft surfaces as "no draft").
  const r = rows[0]!;
  const hasDraft =
    r.draft_definition !== null &&
    JSON.stringify(r.draft_definition) !== JSON.stringify(r.definition);
  const definition = r.draft_definition ?? r.definition;
  const triggerSegmentId = r.draft_definition !== null ? r.draft_trigger_segment_id : r.trigger_segment_id;
  const activeVersion =
    r.active_version_id !== null && r.active_version !== null
      ? { version: r.active_version, name: r.active_version_name }
      : null;

  const campaign = {
    id: r.id,
    name: r.name,
    status: r.status,
    definition, // the draft to EDIT (draft ?? live)
    liveDefinition: r.definition, // the active definition the runner reads
    hasDraft,
    activeVersion,
    trigger_segment_id: triggerSegmentId, // draft trigger ?? live trigger
    trigger_on: r.trigger_on,
    keep_while_in_segment: r.keep_while_in_segment,
  };
  return ok({ campaign, timezone });
};

/**
 * Map a validateCampaignDefinition throw to a TYPED 400 (the structural gate is
 * USER input, not a server fault — a malformed graph must never be a 500). Returns
 * the 400 HandlerResponse on a validation error, or null when the definition is
 * structurally valid (the caller proceeds). §9B phase-6 follow-up.
 */
function validateDefinitionOr400(definition: unknown): HandlerResponse | null {
  try {
    validateCampaignDefinition(definition);
    return null;
  } catch (e) {
    return ok({ error: e instanceof Error ? e.message : 'invalid campaign definition' }, 400);
  }
}

export const createCampaign: Handler = async (ctx, pool, req) => {
  const b = asObject(req.body);
  const name = String(b.name ?? '');
  const definition = b.definition;
  if (!name) return ok({ error: 'name required' }, 400);
  const invalid = validateDefinitionOr400(definition); // reject malformed graphs (§9B) as a TYPED 400
  if (invalid) return invalid;
  // A client-supplied trigger_segment_id must resolve INSIDE the token's workspace
  // (inv.2) — a foreign segment id is rejected, never silently stored.
  const triggerSegmentId = await resolveTriggerSegmentId(pool, ctx.workspaceId, b.trigger_segment_id);
  if (triggerSegmentId === REJECT) return ok({ error: 'trigger_segment_id not found in this workspace' }, 400);
  // trigger_on: fire on segment ENTER (default) or EXIT. keep_while_in_segment:
  // optional gate that exits the enrollment when the profile leaves that segment.
  const triggerOn = b.trigger_on === 'exit' ? 'exit' : 'enter';
  const { rows } = await pool.query(
    `INSERT INTO campaigns (workspace_id, name, definition, trigger_segment_id, trigger_on, keep_while_in_segment)
     VALUES ($1, $2, $3::jsonb, $4, $5, $6) RETURNING id, name, status, trigger_on, keep_while_in_segment`,
    [
      ctx.workspaceId,
      name,
      JSON.stringify(definition),
      triggerSegmentId,
      triggerOn,
      b.keep_while_in_segment ?? null,
    ],
  );
  return ok({ campaign: rows[0] }, 201);
};

/** Sentinel: a supplied trigger_segment_id did not resolve in the workspace. */
const REJECT = Symbol('reject-trigger-segment');

/**
 * Resolve a client-supplied trigger_segment_id to a value safe to store. `undefined`
 * (not in the body) → null (no change intent on create / leave as-is downstream).
 * `null` → null (explicit clear). A non-empty id MUST belong to ctx.workspaceId
 * (inv.2) — a foreign/unknown id returns the REJECT sentinel so the caller 400s.
 */
async function resolveTriggerSegmentId(
  pool: Pool,
  workspaceId: string,
  raw: unknown,
): Promise<string | null | typeof REJECT> {
  if (raw === undefined || raw === null || raw === '') return null;
  if (typeof raw !== 'string') return REJECT;
  const q = scopedQuery(workspaceId, 'SELECT 1 FROM segments WHERE id = $1', [raw]);
  const { rowCount } = await pool.query(q.text, q.values);
  return (rowCount ?? 0) > 0 ? raw : REJECT;
}

export const updateCampaign: Handler = async (ctx, pool, req) => {
  const b = asObject(req.body);
  const id = req.params.id!;
  if (b.definition !== undefined) {
    const invalid = validateDefinitionOr400(b.definition); // typed 400, never a 500
    if (invalid) return invalid;
  }
  // The segment_entry trigger's segment is a CAMPAIGN-ROW field. When the body
  // supplies trigger_segment_id it MUST resolve inside the token's workspace (inv.2)
  // — a foreign id is a 400, never silently stored. Absent → leave the column as-is.
  const setTriggerSegment = b.trigger_segment_id !== undefined;
  let triggerSegmentId: string | null = null;
  if (setTriggerSegment) {
    const resolved = await resolveTriggerSegmentId(pool, ctx.workspaceId, b.trigger_segment_id);
    if (resolved === REJECT) return ok({ error: 'trigger_segment_id not found in this workspace' }, 400);
    triggerSegmentId = resolved;
  }
  const q = scopedQuery(
    ctx.workspaceId,
    `UPDATE campaigns SET
       name = COALESCE($1, name),
       definition = CASE WHEN $3::boolean THEN $2::jsonb ELSE definition END,
       status = COALESCE($4, status),
       trigger_on = COALESCE($6, trigger_on),
       keep_while_in_segment = CASE WHEN $7::boolean THEN $8 ELSE keep_while_in_segment END,
       trigger_segment_id = CASE WHEN $9::boolean THEN $10 ELSE trigger_segment_id END
     WHERE id = $5`,
    [
      b.name !== undefined ? String(b.name) : null,
      b.definition !== undefined ? JSON.stringify(b.definition) : null,
      b.definition !== undefined,
      b.status !== undefined ? String(b.status) : null,
      id,
      b.trigger_on === 'enter' || b.trigger_on === 'exit' ? b.trigger_on : null,
      b.keep_while_in_segment !== undefined,
      (b.keep_while_in_segment ?? null) as string | null,
      setTriggerSegment,
      triggerSegmentId,
    ],
  );
  const { rowCount } = await pool.query(q.text, q.values);
  return ok({ updated: rowCount ?? 0 });
};

/**
 * POST /campaigns/:id/send-nodes/:nodeId/attach-template — attach an email to a
 * campaign SEND node by CLONING a library template into the node's own working copy
 * (kind='copy', source_template_id), exactly like the broadcast instance flow. The
 * clone copies the design + envelope columns (subject/sender_id/to_address/
 * from_selected) so a configured library template yields a sendable copy, and the
 * send node's `template_id` is repointed at the copy. Everything is scoped to the
 * TOKEN's workspace (ctx.workspaceId, NEVER the body — inv.2): the campaign, the
 * node, and the SOURCE template must each resolve inside the workspace or it's a
 * 404 — a foreign template can never be cloned into this workspace.
 */
export const attachCampaignSendTemplate: Handler = async (ctx, pool, req) => {
  const id = req.params.id!;
  const nodeId = req.params.nodeId!;
  const b = asObject(req.body);
  const templateId = typeof b.template_id === 'string' ? b.template_id.trim() : '';
  if (!templateId) return ok({ error: 'template_id required' }, 400);

  // The campaign must belong to the token's workspace (else 404 — inv.2). Attach is
  // a DRAFT-TIME edit: it operates on the working-copy draft when one exists (the
  // builder persists a draft before opening a send node's editor), else on the live
  // definition (backward-compatible for never-drafted campaigns). Writing the
  // repointed node back into the DRAFT keeps the attached template in the copy the
  // publish gate reads (draft ?? live) — a stale template-less draft used to shadow
  // a live-only write and silently drop the attachment.
  const campRows = await pool.query<{ definition: CampaignDefinition; draft_definition: CampaignDefinition | null }>(
    'SELECT definition, draft_definition FROM campaigns WHERE workspace_id = $1 AND id = $2',
    [ctx.workspaceId, id],
  );
  if (!campRows.rows[0]) return ok({ error: 'not found' }, 404);
  const onDraft = campRows.rows[0].draft_definition !== null;
  const def = campRows.rows[0].draft_definition ?? campRows.rows[0].definition;
  const node = def.nodes?.[nodeId] as { type?: string; kind?: string } | undefined;
  if (!node || node.type !== 'action' || node.kind !== 'send') {
    return ok({ error: 'not found' }, 404);
  }

  // Clone the SOURCE template (scoped to this workspace → cross-workspace refusal)
  // into a working copy, mirroring cloneTemplate's INSERT...SELECT (kind='copy').
  const cq = scopedQuery(
    ctx.workspaceId,
    `INSERT INTO email_templates (workspace_id, name, mjml, compiled_html, design, kind, source_template_id, subject, sender_id, to_address, from_selected)
     SELECT workspace_id, name, mjml, compiled_html, design, 'copy', id, subject, sender_id, to_address, from_selected
     FROM email_templates WHERE id = $1`,
    [templateId],
  );
  const cloned = await pool.query<{ id: string }>(`${cq.text} RETURNING id`, cq.values);
  if (!cloned.rows[0]) return ok({ error: 'not found' }, 404); // source not in this workspace
  const copyId = cloned.rows[0].id;

  // Repoint the send node's template_id at the copy and persist the definition.
  const nextDef: CampaignDefinition = {
    ...def,
    nodes: { ...def.nodes, [nodeId]: { ...def.nodes[nodeId], template_id: copyId } as never },
  };
  const uq = scopedQuery(
    ctx.workspaceId,
    onDraft
      ? 'UPDATE campaigns SET draft_definition = $1::jsonb WHERE id = $2'
      : 'UPDATE campaigns SET definition = $1::jsonb WHERE id = $2',
    [JSON.stringify(nextDef), id],
  );
  await pool.query(uq.text, uq.values);
  return ok({ template: { id: copyId } }, 201);
};

/**
 * The shared PUBLISH GATE (§9B/§10) over a campaign DEFINITION: validate the graph
 * (typed 400), then mirror sendBroadcast's ORDERED per-send-node 409s (sender_id →
 * to_address → subject) naming the offending node, THEN the verified-domain gate.
 * A campaign with no send node is ungated. Returns a HandlerResponse to short-
 * circuit on the FIRST failure, or null when the definition is publishable.
 * Workspace-scoped: each referenced copy must resolve inside ctx.workspaceId
 * (a foreign copy never satisfies the gate — inv.2). Reused by BOTH activate and
 * publish so the two flows gate identically.
 */
async function runCampaignPublishGate(
  workspaceId: string,
  pool: Pool,
  def: CampaignDefinition,
): Promise<HandlerResponse | null> {
  // The stored/draft definition must be structurally valid (and the trigger
  // complete — an event trigger missing eventType is rejected here) BEFORE the
  // envelope gate. A malformed graph is a TYPED 400 (never a 500).
  const invalid = validateDefinitionOr400(def);
  if (invalid) return invalid;

  // Load each send node's copy envelope (scoped) → compute the ordered gaps. A copy
  // from another workspace never resolves here, so it can never satisfy the gate.
  const sendTemplateIds = Object.values(def.nodes ?? {})
    .map((n) => n as { type?: string; kind?: string; template_id?: string })
    .filter((n) => n.type === 'action' && n.kind === 'send')
    .map((n) => n.template_id)
    .filter((t): t is string => typeof t === 'string' && t.length > 0);

  const envelopes: Record<string, { sender_id: string | null; to_address: string | null; subject: string | null }> = {};
  if (sendTemplateIds.length > 0) {
    const eq = scopedQuery(
      workspaceId,
      'SELECT id, sender_id, to_address, subject FROM email_templates WHERE id = ANY($1::uuid[])',
      [sendTemplateIds],
    );
    const { rows } = await pool.query<{ id: string; sender_id: string | null; to_address: string | null; subject: string | null }>(eq.text, eq.values);
    for (const r of rows) envelopes[r.id] = { sender_id: r.sender_id, to_address: r.to_address, subject: r.subject };
  }

  const gaps = collectSendNodeEnvelopeGaps(def, envelopes);
  if (gaps.length > 0) {
    const g = gaps[0]!; // the FIRST incomplete send node (BFS order)
    const msg =
      g.missing === 'sender'
        ? `Choose who the email is from on the "${g.nodeId}" send step — open its email and pick a sender (add one under Sending domains).`
        : g.missing === 'to'
          ? `Set the To field on the "${g.nodeId}" send step's email before activating.`
          : `Add a subject line to the "${g.nodeId}" send step's email before activating.`;
    // Machine-usable shape so the SPA renders the reason against the offending node.
    return ok({ error: msg, node: g.nodeId, missing: g.missing }, 409);
  }

  // Verified-domain gate runs AFTER the per-node envelope checks (sendBroadcast
  // parity). Only required when the campaign actually sends.
  if (sendTemplateIds.length > 0) {
    const vq = scopedQuery(workspaceId, 'SELECT 1 FROM sending_domains WHERE verified = true');
    const verified = await pool.query(vq.text, vq.values);
    if (!verified.rowCount) {
      return ok(
        { error: 'No verified sending domain. Verify one in Workspace settings → Sending domains before activating.', missing: 'verified_domain' },
        409,
      );
    }
  }
  return null;
}

/**
 * POST /campaigns/:id/activate — re-activate a campaign IN PLACE (status →
 * 'active') with the shared SEND-NODE gate (§9B/§10), gating the campaign's
 * current LIVE definition. Publishing (POST /campaigns/:id/publish) is the
 * draft→live flow; this remains a no-change re-activate (e.g. a paused campaign
 * whose live definition is already complete). Everything is scoped to the token's
 * workspace (the campaign + every referenced copy resolve inside ctx.workspaceId,
 * NEVER the body — inv.2).
 */
export const activateCampaign: Handler = async (ctx, pool, req) => {
  const id = req.params.id!;
  const campRows = await pool.query<{ definition: CampaignDefinition }>(
    'SELECT definition FROM campaigns WHERE workspace_id = $1 AND id = $2',
    [ctx.workspaceId, id],
  );
  if (!campRows.rows[0]) return ok({ error: 'not found' }, 404);

  const gate = await runCampaignPublishGate(ctx.workspaceId, pool, campRows.rows[0].definition);
  if (gate) return gate;

  const uq = scopedQuery(ctx.workspaceId, "UPDATE campaigns SET status = 'active' WHERE id = $1", [id]);
  const { rowCount } = await pool.query(uq.text, uq.values);
  return ok({ activated: rowCount ?? 0, status: 'active' });
};

/**
 * PUT /campaigns/:id/draft — the builder's AUTOSAVE target. Writes ONLY the
 * working-copy draft (draft_definition + draft_trigger_segment_id); it NEVER
 * touches the live definition / trigger_segment_id / status the runner reads.
 * Validates the draft graph (typed 400, no write). Workspace-scoped (the campaign
 * must resolve inside ctx.workspaceId — a foreign id 404s; trigger_segment_id, if
 * supplied, must resolve inside the workspace too — inv.2).
 */
export const saveCampaignDraft: Handler = async (ctx, pool, req) => {
  const id = req.params.id!;
  const b = asObject(req.body);
  const invalid = validateDefinitionOr400(b.definition); // a malformed draft is a TYPED 400
  if (invalid) return invalid;

  // A supplied draft trigger segment MUST resolve in the workspace (inv.2). Absent
  // → clear the draft trigger (the draft is a complete working copy of the trigger).
  const resolved = await resolveTriggerSegmentId(pool, ctx.workspaceId, b.trigger_segment_id);
  if (resolved === REJECT) return ok({ error: 'trigger_segment_id not found in this workspace' }, 400);

  const q = scopedQuery(
    ctx.workspaceId,
    `UPDATE campaigns SET draft_definition = $1::jsonb, draft_trigger_segment_id = $2 WHERE id = $3`,
    [JSON.stringify(b.definition), resolved, id],
  );
  const { rowCount } = await pool.query(q.text, q.values);
  if (!rowCount) return ok({ error: 'not found' }, 404); // foreign / missing id (inv.2)
  return ok({ updated: rowCount });
};

/**
 * POST /campaigns/:id/publish — promote the DRAFT to LIVE as an append-only
 * version snapshot (§9B builder). In ONE workspace-scoped tx: (a) take the draft
 * (draft_definition ?? definition) + draft trigger; (b) run the shared publish
 * gate on it (ordered per-node 409 / invalid-def 400); (c) compute the next
 * version number; INSERT a campaign_versions snapshot (created_by=ctx.userId);
 * (d) set campaigns.definition/trigger_segment_id = the published values,
 * active_version_id = the new version, status = 'active', and CLEAR the draft;
 * (e) if scope==='backfill' AND the published trigger is segment_entry with a
 * trigger_segment_id, enroll the CURRENT segment members (reuse
 * enrollSegmentSnapshot, ON CONFLICT 'once', workspace-scoped) on the SAME client
 * so the freshly-set status='active' is visible. Returns { version, name, enrolled }.
 * Workspace-scoped: the campaign must resolve inside ctx.workspaceId (inv.2).
 */
export const publishCampaign: Handler = async (ctx, pool, req) => {
  const id = req.params.id!;
  const b = asObject(req.body);
  const name = typeof b.name === 'string' ? b.name.trim() : '';
  if (!name) return ok({ error: 'name required' }, 400);
  const scope = b.scope === 'backfill' ? 'backfill' : 'forward';

  // Read the campaign + its draft (scoped → a foreign id 404s, inv.2).
  const sel = scopedQuery(
    ctx.workspaceId,
    `SELECT definition, draft_definition, trigger_segment_id, draft_trigger_segment_id
     FROM campaigns WHERE id = $1`,
    [id],
  );
  const { rows } = await pool.query<{
    definition: CampaignDefinition;
    draft_definition: CampaignDefinition | null;
    trigger_segment_id: string | null;
    draft_trigger_segment_id: string | null;
  }>(sel.text, sel.values);
  if (!rows[0]) return ok({ error: 'not found' }, 404);

  // The DRAFT is the source of truth to publish (falls back to live when there is
  // no unsaved draft → an idempotent re-publish of the current live definition).
  const hasDraft = rows[0].draft_definition !== null;
  const def = hasDraft ? (rows[0].draft_definition as CampaignDefinition) : rows[0].definition;
  const triggerSegmentId = hasDraft ? rows[0].draft_trigger_segment_id : rows[0].trigger_segment_id;

  // Gate BEFORE mutating anything (a failed gate leaves the draft + status intact).
  const gate = await runCampaignPublishGate(ctx.workspaceId, pool, def);
  if (gate) return gate;

  // Whether this publish backfills: scope=backfill AND a segment_entry trigger with
  // a segment. Forward / event / manual triggers never backfill.
  const startNode = (def.nodes ?? {})[def.startNode] as { type?: string; kind?: string } | undefined;
  const isSegmentEntry = startNode?.type === 'trigger' && startNode.kind === 'segment_entry';
  const shouldBackfill = scope === 'backfill' && isSegmentEntry && !!triggerSegmentId;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // (c) next version number for THIS campaign (workspace-scoped).
    const verSel = await client.query<{ next: number }>(
      'SELECT COALESCE(MAX(version), 0) + 1 AS next FROM campaign_versions WHERE workspace_id = $1 AND campaign_id = $2',
      [ctx.workspaceId, id],
    );
    const version = verSel.rows[0]!.next;
    const ins = await client.query<{ id: string }>(
      `INSERT INTO campaign_versions (workspace_id, campaign_id, version, name, definition, trigger_segment_id, created_by)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7) RETURNING id`,
      [ctx.workspaceId, id, version, name, JSON.stringify(def), triggerSegmentId, ctx.userId ?? null],
    );
    const versionId = ins.rows[0]!.id;

    // (d) promote draft→live, point active_version_id, activate, CLEAR the draft.
    await client.query(
      `UPDATE campaigns SET
         definition = $1::jsonb,
         trigger_segment_id = $2,
         active_version_id = $3,
         status = 'active',
         draft_definition = NULL,
         draft_trigger_segment_id = NULL
       WHERE workspace_id = $4 AND id = $5`,
      [JSON.stringify(def), triggerSegmentId, versionId, ctx.workspaceId, id],
    );

    // (e) backfill on the SAME client so the just-set status='active' is visible to
    // enrollSegmentSnapshot's loadStartNode (which requires status='active').
    let enrolled = 0;
    if (shouldBackfill) {
      const res = await enrollSegmentSnapshot(enrollDepsOnClient(client), {
        workspaceId: ctx.workspaceId,
        campaignId: id,
        segmentId: triggerSegmentId,
      });
      enrolled = res.enrolled;
    }

    await client.query('COMMIT');
    return ok({ version, name, enrolled });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
};

/**
 * GET /campaigns/:id/versions — the campaign's append-only published-version
 * history, newest first, with is_active (== campaigns.active_version_id).
 * Workspace-scoped: a foreign campaign id 404s (inv.2).
 */
export const listCampaignVersions: Handler = async (ctx, pool, req) => {
  const id = req.params.id!;
  const cSel = scopedQuery(ctx.workspaceId, 'SELECT active_version_id FROM campaigns WHERE id = $1', [id]);
  const camp = await pool.query<{ active_version_id: string | null }>(cSel.text, cSel.values);
  if (!camp.rows[0]) return ok({ error: 'not found' }, 404);
  const activeId = camp.rows[0].active_version_id;

  // ORDER BY is appended AFTER scopedQuery builds the WHERE (scopedQuery wraps the
  // fragment's WHERE in parens, so an inline ORDER BY would land inside them).
  const q = scopedQuery(
    ctx.workspaceId,
    `SELECT id, version, name, created_at, created_by
     FROM campaign_versions WHERE campaign_id = $1`,
    [id],
  );
  const { rows } = await pool.query<{ id: string; version: number; name: string; created_at: string; created_by: string | null }>(
    `${q.text} ORDER BY version DESC`,
    q.values,
  );
  const versions = rows.map((r) => ({ ...r, is_active: r.id === activeId }));
  return ok({ versions });
};

/**
 * POST /campaigns/:id/revert — load a prior version's snapshot INTO the draft
 * (append-only history: revert NEVER destroys; the user then Saves/publishes to
 * make it live). Sets draft_definition + draft_trigger_segment_id from the version;
 * the LIVE definition is UNTOUCHED. The version must belong to THIS campaign in the
 * token's workspace (else 404 — inv.2; workspace_id never from the body). Returns
 * the loaded draft.
 */
export const revertCampaign: Handler = async (ctx, pool, req) => {
  const id = req.params.id!;
  const b = asObject(req.body);
  const versionId = typeof b.version_id === 'string' ? b.version_id.trim() : '';
  if (!versionId) return ok({ error: 'version_id required' }, 400);

  // The version must belong to THIS campaign AND this workspace (inv.2).
  const vSel = scopedQuery(
    ctx.workspaceId,
    'SELECT definition, trigger_segment_id FROM campaign_versions WHERE id = $1 AND campaign_id = $2',
    [versionId, id],
  );
  const v = await pool.query<{ definition: CampaignDefinition; trigger_segment_id: string | null }>(vSel.text, vSel.values);
  if (!v.rows[0]) return ok({ error: 'not found' }, 404);

  // Reverting to the version that is ALREADY live is a no-op (the UI hides Revert
  // on the active row; this is defense-in-depth). 409 rather than silently writing.
  const cSel = scopedQuery(ctx.workspaceId, 'SELECT active_version_id FROM campaigns WHERE id = $1', [id]);
  const camp = await pool.query<{ active_version_id: string | null }>(cSel.text, cSel.values);
  if (!camp.rows[0]) return ok({ error: 'not found' }, 404); // foreign campaign id (inv.2)
  if (camp.rows[0].active_version_id === versionId) {
    return ok({ error: "That version is already live — there's nothing to revert to." }, 409);
  }

  const upd = scopedQuery(
    ctx.workspaceId,
    'UPDATE campaigns SET draft_definition = $1::jsonb, draft_trigger_segment_id = $2 WHERE id = $3',
    [JSON.stringify(v.rows[0].definition), v.rows[0].trigger_segment_id, id],
  );
  const { rowCount } = await pool.query(upd.text, upd.values);
  if (!rowCount) return ok({ error: 'not found' }, 404); // foreign campaign id (inv.2)
  return ok({ definition: v.rows[0].definition, trigger_segment_id: v.rows[0].trigger_segment_id });
};

/**
 * POST /campaigns/:id/enroll — MANUAL/API enrollment (§9B). Enrolls EITHER a
 * single profile (`profile_id`) OR a point-in-time SEGMENT SNAPSHOT (`segment_id`)
 * at the campaign's start node. Exactly one target is required. Everything is
 * scoped to the TOKEN's workspace (ctx.workspaceId, NEVER the body — inv.2): the
 * campaign, the profile, and the segment must each resolve INSIDE ctx.workspaceId
 * or it's a 404 (a foreign id never enrolls another tenant). Idempotent — the
 * 'once' policy (ON CONFLICT (campaign_id, profile_id) DO NOTHING) makes a re-run
 * insert no duplicates. Reuses the campaign-runner enroll cores.
 */
export const enrollIntoCampaign: Handler = async (ctx, pool, req) => {
  const id = req.params.id!;
  const b = asObject(req.body);
  const profileId = typeof b.profile_id === 'string' ? b.profile_id.trim() : '';
  const segmentId = typeof b.segment_id === 'string' ? b.segment_id.trim() : '';
  const hasProfile = b.profile_id !== undefined && b.profile_id !== null;
  const hasSegment = b.segment_id !== undefined && b.segment_id !== null;

  // Input contract: exactly ONE target, well-formed — rejected BEFORE any DB op.
  if (hasProfile === hasSegment) {
    return ok({ error: 'exactly one of profile_id or segment_id is required' }, 400);
  }
  if (hasProfile && !profileId) return ok({ error: 'profile_id must be a non-empty string' }, 400);
  if (hasSegment && !segmentId) return ok({ error: 'segment_id must be a non-empty string' }, 400);

  // The campaign must belong to the token's workspace (else 404 — inv.2).
  if (!(await ownsResource(pool, ctx.workspaceId, 'campaigns', id))) {
    return ok({ error: 'not found' }, 404);
  }

  const deps = enrollDepsOnPool(pool);
  if (hasProfile) {
    // The profile must exist in THIS workspace (mirrors sendProfileEvent).
    const present = await pool.query('SELECT 1 FROM profiles WHERE workspace_id = $1 AND id = $2', [ctx.workspaceId, profileId]);
    if (!present.rowCount) return ok({ error: 'not found' }, 404);
    const res = await enrollProfileManually(deps, {
      workspaceId: ctx.workspaceId,
      campaignId: id,
      profileId,
    });
    return ok({ enrolled: res.enrolled });
  }

  // segment snapshot: the segment must exist in THIS workspace.
  const seg = await pool.query('SELECT 1 FROM segments WHERE workspace_id = $1 AND id = $2', [ctx.workspaceId, segmentId]);
  if (!seg.rowCount) return ok({ error: 'not found' }, 404);
  const res = await enrollSegmentSnapshot(deps, {
    workspaceId: ctx.workspaceId,
    campaignId: id,
    segmentId,
  });
  return ok({ enrolled: res.enrolled });
};

/**
 * GET /campaigns/:id/enrollments — the profiles that have passed through THIS
 * campaign (the Journeys tab). Joins campaign_enrollments → profiles for the
 * email, newest-enrolled first, capped to 200. Everything is scoped to the
 * TOKEN's workspace (ctx.workspaceId, NEVER a body/query workspace_id — inv.1/
 * inv.2): a campaign in another workspace 404s and the enrollment + profile rows
 * are both bound to ctx.workspaceId so a foreign id never surfaces another
 * tenant's people. Capability-gated (manage_content, routes.ts).
 */
export const listCampaignEnrollments: Handler = async (ctx, pool, req) => {
  const id = req.params.id!;
  // The campaign must belong to the token's workspace (else 404 — inv.2).
  if (!(await ownsResource(pool, ctx.workspaceId, 'campaigns', id))) {
    return ok({ error: 'not found' }, 404);
  }
  // Both the enrollment and the joined profile are pinned to ctx.workspaceId so a
  // cross-tenant profile can never appear (the FK is intra-workspace, but scope it
  // explicitly — RLS is bypassed by the service role, inv.1).
  const { rows } = await pool.query<{
    profile_id: string;
    email: string | null;
    status: string;
    current_node: string;
    enrolled_at: string;
    updated_at: string;
  }>(
    `SELECT e.profile_id, p.email, e.status, e.current_node, e.enrolled_at, e.updated_at
     FROM campaign_enrollments e
     JOIN profiles p ON p.id = e.profile_id AND p.workspace_id = e.workspace_id
     WHERE e.workspace_id = $1 AND e.campaign_id = $2
     ORDER BY e.enrolled_at DESC
     LIMIT 200`,
    [ctx.workspaceId, id],
  );
  return ok({ enrollments: rows });
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
  // Surface the creation in the workspace Activity log.
  await pool.query(
    `INSERT INTO activity_log (workspace_id, profile_id, source, type, outcome, detail)
     VALUES ($1, $2, 'profile', 'profile_created', 'info', 'created manually')`,
    [ctx.workspaceId, profileId],
  );
  // PROFILE-TRIGGER ENROLLMENT (§9B): enroll this new profile into active
  // profile-trigger campaigns whose profileChange is created/any. Idempotent (ON
  // CONFLICT 'once'). Workspace-scoped; never trusts a body workspace_id.
  await enrollFromProfileChange(enrollDepsOnPool(pool), {
    workspace_id: ctx.workspaceId,
    profile_id: profileId,
    change: 'created',
  });
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
  const createdIds: string[] = [];
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
        createdIds.push(row.id);
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
  // One summary row in the Activity log (a per-profile row would flood it on a
  // bulk import). Only when something actually landed.
  if (created > 0 || updated > 0) {
    await pool.query(
      `INSERT INTO activity_log (workspace_id, profile_id, source, type, outcome, detail)
       VALUES ($1, NULL, 'import', 'profiles_imported', 'info', $2)`,
      [ctx.workspaceId, `CSV import — ${created} created, ${updated} updated`],
    );
  }
  // PROFILE-TRIGGER ENROLLMENT (§9B): each IMPORTED (created) profile enrolls into
  // active profile-trigger campaigns whose profileChange is created/any. Idempotent
  // (ON CONFLICT 'once'). Workspace-scoped; per-profile so a slow campaign-set read
  // per row is bounded by the import cap. (Updates via CSV merge are NOT treated as
  // an 'updated' profile-trigger event here — only first-time creation enrolls.)
  if (createdIds.length > 0) {
    const enrollDeps = enrollDepsOnPool(pool);
    for (const pid of createdIds) {
      await enrollFromProfileChange(enrollDeps, {
        workspace_id: ctx.workspaceId,
        profile_id: pid,
        change: 'created',
      });
    }
  }
  return ok({ created, updated, skipped: errors.length, total: rows.length, errors: errors.slice(0, 50) });
};

/**
 * GET /profiles/attribute-values?key=&q= — DISTINCT values for one attribute key
 * across the workspace's profiles, optionally filtered by a substring (q). Powers
 * the segment editor's value autosuggest. Workspace-scoped; capped at 30.
 */
export const listAttributeValues: Handler = async (ctx, pool, req) => {
  const key = String(req.query.key ?? '').trim();
  const q = String(req.query.q ?? '').trim();
  if (!key) return ok({ values: [] });
  const { rows } = await pool.query<{ v: string | null }>(
    `SELECT DISTINCT attributes ->> $2 AS v
       FROM profiles
      WHERE workspace_id = $1 AND attributes ->> $2 ILIKE $3
      ORDER BY v
      LIMIT 30`,
    [ctx.workspaceId, key, `%${q}%`],
  );
  return ok({ values: rows.map((r) => r.v).filter((v): v is string => v != null) });
};

/** GET /events/types?q= — DISTINCT event type names (workspace-scoped, cap 30). */
export const listEventTypes: Handler = async (ctx, pool, req) => {
  const q = String(req.query.q ?? '').trim();
  const { rows } = await pool.query<{ type: string }>(
    `SELECT DISTINCT type FROM events WHERE workspace_id = $1 AND type ILIKE $2 ORDER BY type LIMIT 30`,
    [ctx.workspaceId, `%${q}%`],
  );
  return ok({ values: rows.map((r) => r.type) });
};

/** GET /events/payload-keys?type=&q= — DISTINCT payload keys (optionally for one event type). */
export const listEventPayloadKeys: Handler = async (ctx, pool, req) => {
  const type = String(req.query.type ?? '').trim();
  const q = String(req.query.q ?? '').trim();
  const params: unknown[] = [ctx.workspaceId, `%${q}%`];
  let typeClause = '';
  if (type) {
    params.push(type);
    typeClause = `AND e.type = $${params.length}`;
  }
  const { rows } = await pool.query<{ k: string }>(
    `SELECT DISTINCT k FROM events e, jsonb_object_keys(e.payload) AS k
       WHERE e.workspace_id = $1 AND k ILIKE $2 ${typeClause}
       ORDER BY k LIMIT 30`,
    params,
  );
  return ok({ values: rows.map((r) => r.k) });
};

/** GET /events/payload-values?type=&key=&q= — DISTINCT values of one payload key. */
export const listEventPayloadValues: Handler = async (ctx, pool, req) => {
  const type = String(req.query.type ?? '').trim();
  const key = String(req.query.key ?? '').trim();
  const q = String(req.query.q ?? '').trim();
  if (!key) return ok({ values: [] });
  const params: unknown[] = [ctx.workspaceId, key, `%${q}%`];
  let typeClause = '';
  if (type) {
    params.push(type);
    typeClause = `AND type = $${params.length}`;
  }
  const { rows } = await pool.query<{ v: string | null }>(
    `SELECT DISTINCT payload ->> $2 AS v FROM events
       WHERE workspace_id = $1 AND payload ->> $2 ILIKE $3 ${typeClause}
       ORDER BY v LIMIT 30`,
    params,
  );
  return ok({ values: rows.map((r) => r.v).filter((v): v is string => v != null) });
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
      // Subscribed + deliverable again → lift the consent (unsubscribe) suppression
      // REGARDLESS of source — it may have been written by the recipient's own
      // unsubscribe link (source='one-click'), not just a manual edit — plus any
      // manual suppression. A pipeline-written bounce/complaint (reason not
      // 'unsubscribe', source not 'manual') is preserved.
      await pool.query(
        `DELETE FROM suppressions WHERE workspace_id = $1 AND email = $2 AND (reason = 'unsubscribe' OR source = 'manual')`,
        [ctx.workspaceId, updated.email],
      );
    }
  }
  // Record the edit in the workspace Activity log (NOT the behavioral `events`
  // table — that's producer-ingested + feeds segments). Names the changed fields.
  const changed: string[] = [];
  if (b.email !== undefined) changed.push('email');
  if (b.external_id !== undefined) changed.push('external_id');
  if (emailStatus !== null) changed.push('email_status');
  if (hasAttrs) changed.push('attributes');
  await pool.query(
    `INSERT INTO activity_log (workspace_id, profile_id, source, type, outcome, detail)
     VALUES ($1, $2, 'profile', 'profile_updated', 'info', $3)`,
    [ctx.workspaceId, id, changed.length ? `edited ${changed.join(', ')}` : 'edited'],
  );
  // PROFILE-TRIGGER ENROLLMENT (§9B): enroll into active profile-trigger campaigns
  // whose profileChange is updated/any. Idempotent (ON CONFLICT 'once'). Scoped.
  await enrollFromProfileChange(enrollDepsOnPool(pool), {
    workspace_id: ctx.workspaceId,
    profile_id: id,
    change: 'updated',
  });
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
    await reassign('activity_log'); // the merged-away profile's activity follows the survivor
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

    // Remove the secondary (features first — FK) BEFORE recompute/re-eval.
    await client.query('DELETE FROM profile_features WHERE workspace_id = $1 AND profile_id = $2', [ws, secondary]);
    await client.query('DELETE FROM profiles WHERE workspace_id = $1 AND id = $2', [ws, secondary]);

    // Recompute the lead's rolling features from ALL its (now-merged) events and
    // re-evaluate its realtime segments, in the SAME tx.
    await recomputeFeaturesAndSegments(client, ws, lead);

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

/**
 * Recompute a profile's rolling features from its events (mirrors the processor's
 * aggregates, §6) and re-evaluate its dynamic_realtime segments — both on the
 * given client so callers compose it into their OWN transaction. Shared by the
 * merge and the manual "send event" paths.
 */
async function recomputeFeaturesAndSegments(client: PoolClient, ws: string, profileId: string): Promise<void> {
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
    [ws, profileId, OPEN_EVENT_TYPES as readonly string[], PURCHASE_EVENT_TYPES as readonly string[]],
  );
  const evalRes = await evaluateRealtimeSegmentsForProfile(
    {
      reader: { query: (text, values) => client.query(text, values) },
      runInWorkspaceTx: async (_w, statements) => {
        for (const s of statements) await client.query(s.text, s.values);
      },
    },
    ws,
    profileId,
  );
  // SEGMENT-ENTRY ENROLLMENT (§9B): the membership change_log rows just written
  // above drive campaign enrollment — fire enrollFromSegmentChange for each
  // entered/exited delta on the SAME tx client (no nested BEGIN/COMMIT). This is
  // the live hook: entering a campaign's trigger segment really enrolls the
  // profile. Workspace-scoped; idempotent (ON CONFLICT 'once').
  const enrollDeps = enrollDepsOnClient(client);
  for (const delta of evalRes.deltas) {
    if (delta.action !== 'entered' && delta.action !== 'exited') continue;
    await enrollFromSegmentChange(enrollDeps, {
      workspace_id: ws,
      segment_id: delta.segmentId,
      profile_id: profileId,
      action: delta.action,
    });
  }
}

/**
 * Build EnrollDeps bound to a single tx client — so an enrollment write composes
 * into the CALLER's open transaction (no nested BEGIN/COMMIT) and every read/write
 * runs on the same connection. workspace_id scoping is in-code (every statement
 * binds workspace_id at $1; the asserted-scope tx runner lives in the campaign-
 * runner — here we run on the open client directly).
 */
function enrollDepsOnClient(client: PoolClient): EnrollDeps {
  return {
    reader: { query: (text, values) => client.query(text, values as unknown[]) as never },
    runInWorkspaceTx: async (_w, statements) => {
      for (const s of statements) await client.query(s.text, s.values);
    },
  };
}

/** Build EnrollDeps bound to the request POOL (own tx per statement-list). */
function enrollDepsOnPool(pool: Pool): EnrollDeps {
  return {
    reader: { query: (text, values) => pool.query(text, values as unknown[]) as never },
    runInWorkspaceTx: async (workspaceId, statements) => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        for (const s of statements) {
          // Defensive in-code scoping guard (service role bypasses RLS): every
          // statement must bind workspace_id at $1 (CLAUDE.md inv.1/2).
          if (s.values[0] !== workspaceId) throw new Error('enroll: statement not scoped to workspace');
          await client.query(s.text, s.values);
        }
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        throw e;
      } finally {
        client.release();
      }
    },
  };
}

/**
 * POST /profiles/:id/events — manually record a SINGLE behavioral event "on the
 * profile's behalf": a caller-supplied `type` + JSON `payload`. It lands in the
 * same `events` table as ingested events, so it feeds segment rules, the profile
 * timeline, and the rolling features (recomputed + segments re-evaluated in one
 * workspace-scoped tx — exactly like ingestion). Scoped to the token's workspace.
 */
export const sendProfileEvent: Handler = async (ctx, pool, req) => {
  const id = req.params.id!;
  const b = asObject(req.body);
  const type = typeof b.type === 'string' ? b.type.trim() : '';
  if (!type) return ok({ error: 'an event type is required' }, 400);
  // payload defaults to {}; reject a non-object (arrays included) so it stays a
  // JSON document we can index/merge on.
  let payload: Record<string, unknown> = {};
  if (b.payload !== undefined && b.payload !== null) {
    if (typeof b.payload !== 'object' || Array.isArray(b.payload)) {
      return ok({ error: 'payload must be a JSON object' }, 400);
    }
    payload = b.payload as Record<string, unknown>;
  }

  const ws = ctx.workspaceId;
  const client = await pool.connect();
  let eventId = '';
  try {
    // The profile must exist in THIS workspace (never another tenant's id).
    const present = await client.query('SELECT 1 FROM profiles WHERE workspace_id = $1 AND id = $2', [ws, id]);
    if (!present.rowCount) {
      client.release();
      return ok({ error: 'not found' }, 404);
    }
    await client.query('BEGIN');
    const ins = await client.query<{ event_id: string }>(
      `INSERT INTO events (event_id, workspace_id, profile_id, type, occurred_at, payload)
       VALUES (gen_random_uuid(), $1, $2, $3, now(), $4::jsonb) RETURNING event_id`,
      [ws, id, type, JSON.stringify(payload)],
    );
    eventId = ins.rows[0]!.event_id;
    await recomputeFeaturesAndSegments(client, ws, id);
    // EVENT-TRIGGER ENROLLMENT (§9B): the dev mirror of the processor hook — fires
    // at the SAME point segment re-eval does, on the SAME tx client (no nested
    // BEGIN/COMMIT). Enrolls the profile into active event-trigger campaigns whose
    // eventType (+ optional payload filter) matches this event; idempotent (ON
    // CONFLICT 'once'). Workspace-scoped; never trusts a body workspace_id.
    await enrollFromEvent(enrollDepsOnClient(client), {
      workspace_id: ws,
      profile_id: id,
      type,
      payload,
      event_id: eventId,
    });
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
    throw e;
  }
  client.release();
  return ok({ event: { event_id: eventId, type, payload } }, 201);
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

/**
 * GET /profiles/:id/delivery — deliverability health for a profile (scoped):
 * email_status, current suppression (if any), the distinct-day soft-bounce count
 * since the last delivery, and recent delivery events (delivery/bounce/complaint).
 */
export const getProfileDelivery: Handler = async (ctx, pool, req) => {
  const id = req.params.id!;
  const p = await pool.query<{ email: string | null; email_status: string }>(
    'SELECT email, email_status FROM profiles WHERE workspace_id = $1 AND id = $2',
    [ctx.workspaceId, id],
  );
  if (!p.rows[0]) return ok({ error: 'not found' }, 404);
  const email = p.rows[0].email;

  const supp = email
    ? await pool.query<{ reason: string; source: string | null; created_at: string }>(
        'SELECT reason, source, created_at FROM suppressions WHERE workspace_id = $1 AND email = $2',
        [ctx.workspaceId, email],
      )
    : { rows: [] as Array<{ reason: string; source: string | null; created_at: string }> };

  // Distinct UTC days with a soft bounce since the last successful delivery.
  const days = email
    ? await pool.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM (
           SELECT DISTINCT (occurred_at AT TIME ZONE 'UTC')::date
             FROM email_events
            WHERE workspace_id = $1 AND type = 'bounce' AND sub_type = 'Transient'
              AND raw->>'recipient' = $2
              AND occurred_at > COALESCE(
                (SELECT max(occurred_at) FROM email_events
                  WHERE workspace_id = $1 AND type = 'delivery' AND raw->>'recipient' = $2),
                '-infinity'::timestamptz)
         ) t`,
        [ctx.workspaceId, email],
      )
    : { rows: [{ n: 0 }] };

  const events = await pool.query<{ type: string; sub_type: string | null; occurred_at: string }>(
    `SELECT type, sub_type, occurred_at
       FROM email_events
      WHERE workspace_id = $1 AND (profile_id = $2 OR raw->>'recipient' = $3)
      ORDER BY occurred_at DESC
      LIMIT 20`,
    [ctx.workspaceId, id, email],
  );

  return ok({
    email_status: p.rows[0].email_status,
    suppressed: supp.rows[0] ?? null,
    soft_bounce_days: days.rows[0]?.n ?? 0,
    events: events.rows,
  });
};

/**
 * GET /profiles/:id/segments — segments this profile belongs to (scoped).
 *
 * Manual segments come from the `segment_memberships` rows (the source of truth
 * for hand-curated lists). Dynamic segments are evaluated LIVE — the rule run
 * against this one profile at now() — so time-windowed membership is always
 * current and never depends on a possibly-stale materialized cache (which the
 * scheduled sweep maintains for sends/enrollment, not for this read).
 */
export const listProfileSegments: Handler = async (ctx, pool, req) => {
  const id = req.params.id!;

  // Manual memberships (truth for kind='manual').
  const manual = await pool.query<{
    id: string;
    name: string;
    kind: string;
    source: string;
    entered_at: string | null;
  }>(
    `SELECT s.id, s.name, s.kind, sm.source, sm.entered_at
       FROM segment_memberships sm
       JOIN segments s ON s.id = sm.segment_id
      WHERE sm.workspace_id = $1 AND sm.profile_id = $2 AND s.kind = 'manual'
      ORDER BY sm.entered_at DESC`,
    [ctx.workspaceId, id],
  );

  // Active dynamic segments → does this profile match the rule RIGHT NOW?
  const active = await pool.query<{ id: string; name: string; kind: string; definition: AstNode | null }>(
    `SELECT id, name, kind, definition
       FROM segments
      WHERE workspace_id = $1 AND status = 'active' AND kind = 'dynamic_realtime'
      ORDER BY name`,
    [ctx.workspaceId],
  );
  const live: Array<{ id: string; name: string; kind: string; source: string; entered_at: null }> = [];
  for (const s of active.rows) {
    const m = buildSegmentMatch(ctx.workspaceId, s.definition ?? null, id);
    const r = await pool.query(m.text, m.values);
    if ((r.rowCount ?? 0) > 0) {
      live.push({ id: s.id, name: s.name, kind: s.kind, source: 'live', entered_at: null });
    }
  }

  return ok({ segments: [...manual.rows, ...live] });
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
         UNION ALL
         SELECT at, source, type, outcome, profile_id, detail
           FROM activity_log WHERE workspace_id = $1
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

/**
 * GET /dashboards/delivery-health?days=N — workspace-level deliverability over a
 * rolling window (default 30d, clamped 1..365): send/delivery/bounce/complaint
 * counts + rates (for SES reputation), the current suppression-list size by
 * reason, and a per-day sends/deliveries trend for a sparkline. All scoped to
 * the token's workspace. Counts are 0 in local dev (the SES feedback pipeline
 * that writes email_events doesn't run) — they populate in a deployed pipeline.
 */
export const dashboardDeliveryHealth: Handler = async (ctx, pool, req) => {
  const ws = ctx.workspaceId;
  const days = Math.min(365, Math.max(1, Math.floor(Number(req.query.days ?? '30')) || 30));
  const since = `now() - ($2::numeric * interval '1 day')`;

  // Outcomes over the window: sends from messages_log, delivery/bounce/complaint
  // from email_events (each message has at most one of these terminal events).
  const [sentRes, evRes, suppRes, trendRes] = await Promise.all([
    pool.query<{ c: number }>(
      // EMAIL-only: this dashboard is about SES deliverability/reputation (bounce +
      // complaint rates from email_events). SMS/WhatsApp are a separate channel and
      // don't have an email feedback pipeline, so they're excluded from the count.
      `SELECT count(*)::int AS c FROM messages_log WHERE workspace_id = $1 AND medium = 'email' AND sent_at >= ${since}`,
      [ws, days],
    ),
    pool.query<{ type: string; c: number }>(
      `SELECT type, count(*)::int AS c FROM email_events
        WHERE workspace_id = $1 AND occurred_at >= ${since} AND type IN ('delivery','bounce','complaint')
        GROUP BY type`,
      [ws, days],
    ),
    pool.query<{ reason: string; c: number }>(
      `SELECT reason, count(*)::int AS c FROM suppressions WHERE workspace_id = $1 GROUP BY reason`,
      [ws],
    ),
    pool.query<{ day: string; sent: number; delivered: number }>(
      // One row per day in the window (gap-filled via generate_series) so the
      // sparkline has a continuous series even on days with no activity.
      `WITH days AS (
         SELECT generate_series(
           date_trunc('day', now()) - (($2::int - 1) * interval '1 day'),
           date_trunc('day', now()),
           interval '1 day'
         ) AS day
       )
       SELECT to_char(d.day, 'YYYY-MM-DD') AS day,
              coalesce(m.sent, 0)::int AS sent,
              coalesce(e.delivered, 0)::int AS delivered
         FROM days d
         LEFT JOIN (
           SELECT date_trunc('day', sent_at) AS day, count(*) AS sent
             FROM messages_log WHERE workspace_id = $1 AND medium = 'email' AND sent_at >= ${since}
            GROUP BY 1
         ) m ON m.day = d.day
         LEFT JOIN (
           SELECT date_trunc('day', occurred_at) AS day, count(*) AS delivered
             FROM email_events
            WHERE workspace_id = $1 AND occurred_at >= ${since} AND type = 'delivery'
            GROUP BY 1
         ) e ON e.day = d.day
        ORDER BY d.day`,
      [ws, days],
    ),
  ]);

  const evBy = new Map(evRes.rows.map((r) => [r.type, r.c]));
  const delivered = evBy.get('delivery') ?? 0;
  const bounced = evBy.get('bounce') ?? 0;
  const complained = evBy.get('complaint') ?? 0;
  const sent = sentRes.rows[0]?.c ?? 0;
  // Rates are over delivery attempts (delivered + bounced) — the standard SES
  // denominator; complaints are measured against delivered mail.
  const attempts = delivered + bounced;
  const bounceRate = attempts > 0 ? bounced / attempts : 0;
  const complaintRate = delivered > 0 ? complained / delivered : 0;

  const suppBy = new Map(suppRes.rows.map((r) => [r.reason, r.c]));
  const suppression = {
    total: suppRes.rows.reduce((n, r) => n + r.c, 0),
    hard_bounce: suppBy.get('hard_bounce') ?? 0,
    complaint: suppBy.get('complaint') ?? 0,
    unsubscribe: suppBy.get('unsubscribe') ?? 0,
    manual: suppBy.get('manual') ?? 0,
  };

  return ok({
    window_days: days,
    outcomes: { sent, delivered, bounced, complained },
    rates: { bounce: bounceRate, complaint: complaintRate },
    suppression,
    trend: trendRes.rows,
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

/**
 * DELETE /admin/companies/:id — delete a company (platform admin; audited). Guard:
 * only an EMPTY company (no workspaces) can be deleted, so no tenant data is ever
 * orphaned. Move/delete its workspaces first.
 */
export const adminDeleteCompany: Handler = async (ctx, pool, req) => {
  const id = req.params.id!;
  const confirm = typeof asObject(req.body).confirm_name === 'string' ? String(asObject(req.body).confirm_name) : '';
  const c = await pool.query<{ name: string }>('SELECT name FROM companies WHERE id = $1', [id]);
  if (!c.rows[0]) return ok({ error: 'not found' }, 404);
  if (confirm.trim() !== c.rows[0].name) {
    return ok({ error: 'company name confirmation does not match' }, 400);
  }
  const w = await pool.query('SELECT 1 FROM workspaces WHERE company_id = $1 LIMIT 1', [id]);
  if ((w.rowCount ?? 0) > 0) return ok({ error: 'company still has workspaces' }, 409);
  await pool.query('DELETE FROM companies WHERE id = $1', [id]);
  await writeAuditEntry(
    recordCrossTenantAccess(ctx.userId ?? '', null, 'admin.delete_company', { company_id: id, name: c.rows[0].name }),
  );
  return ok({ deleted: true });
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
 * PATCH /admin/workspaces/:id — platform admin renames a workspace (audited). A
 * workspace's company is fixed once created (no moving between companies).
 */
export const adminUpdateWorkspace: Handler = async (ctx, pool, req) => {
  const id = req.params.id!;
  const name = typeof asObject(req.body).name === 'string' ? String(asObject(req.body).name).trim() : '';
  if (!name) return ok({ error: 'name required' }, 400);
  const { rows } = await pool.query('UPDATE workspaces SET name = $2 WHERE id = $1 RETURNING id, name, company_id', [
    id,
    name,
  ]);
  if (!rows[0]) return ok({ error: 'workspace not found' }, 404);
  await handleAdminAccess(ctx, id, 'admin.update_workspace', { workspace_id: id, name }, writeAuditEntry);
  return ok({ workspace: rows[0] });
};

// Tenant tables to purge when deleting a workspace, ordered children → parents so
// foreign keys are satisfied. admin_audit_log is intentionally NOT here (keep the
// audit trail; its workspace_id has no FK).
const WORKSPACE_CHILD_TABLES = [
  'segment_change_log',
  'segment_memberships',
  'campaign_enrollments',
  'messages_log',
  'email_events',
  'outbox',
  'events',
  'profile_features',
  'usage_counters',
  'broadcasts',
  'campaigns',
  'segments',
  'email_templates',
  'suppressions',
  'profiles',
  'workspace_users',
  'workspace_api_keys',
] as const;

/** Purge a workspace and ALL its tenant data in FK order, in one transaction. */
async function purgeWorkspace(pool: Pool, id: string): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const t of WORKSPACE_CHILD_TABLES) {
      await client.query(`DELETE FROM ${t} WHERE workspace_id = $1`, [id]);
    }
    await client.query('DELETE FROM workspaces WHERE id = $1', [id]);
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
    throw e;
  }
  client.release();
}

/** PATCH /company — an OWNER renames their OWN company (derived from the active workspace). */
export const renameCompany: Handler = async (ctx, pool, req) => {
  const name = typeof asObject(req.body).name === 'string' ? String(asObject(req.body).name).trim() : '';
  if (!name) return ok({ error: 'name required' }, 400);
  const c = await pool.query<{ company_id: string }>('SELECT company_id FROM workspaces WHERE id = $1', [
    ctx.workspaceId,
  ]);
  const companyId = c.rows[0]?.company_id;
  if (!companyId) return ok({ error: 'no active company' }, 400);
  const { rows } = await pool.query('UPDATE companies SET name = $2 WHERE id = $1 RETURNING id, name, status', [
    companyId,
    name,
  ]);
  return ok({ company: rows[0] });
};

/**
 * PATCH /workspaces/:id — an OWNER renames a workspace IN THEIR OWN company.
 */
export const renameWorkspace: Handler = async (ctx, pool, req) => {
  const id = req.params.id!;
  const name = typeof asObject(req.body).name === 'string' ? String(asObject(req.body).name).trim() : '';
  if (!name) return ok({ error: 'name required' }, 400);
  const w = await pool.query<{ same_company: boolean }>(
    `SELECT (company_id = (SELECT company_id FROM workspaces WHERE id = $2)) AS same_company
       FROM workspaces WHERE id = $1`,
    [id, ctx.workspaceId],
  );
  if (!w.rows[0] || !w.rows[0].same_company) return ok({ error: 'not found' }, 404);
  const { rows } = await pool.query('UPDATE workspaces SET name = $2 WHERE id = $1 RETURNING id, name, status', [
    id,
    name,
  ]);
  return ok({ workspace: rows[0] });
};

/**
 * DELETE /workspaces/:id — an OWNER (company admin) permanently deletes a
 * workspace IN THEIR OWN company and ALL its data. Destructive + irreversible, so
 * the body must carry `confirm_name` matching the workspace's exact name. You
 * cannot delete the workspace you're currently in (switch away first).
 */
export const deleteWorkspace: Handler = async (ctx, pool, req) => {
  const id = req.params.id!;
  const confirm = typeof asObject(req.body).confirm_name === 'string' ? String(asObject(req.body).confirm_name) : '';
  // Target must belong to the SAME company as the caller's active workspace.
  const w = await pool.query<{ name: string; same_company: boolean }>(
    `SELECT w.name,
            (w.company_id = (SELECT company_id FROM workspaces WHERE id = $2)) AS same_company
       FROM workspaces w WHERE w.id = $1`,
    [id, ctx.workspaceId],
  );
  if (!w.rows[0] || !w.rows[0].same_company) return ok({ error: 'not found' }, 404);
  if (id === ctx.workspaceId) {
    return ok({ error: 'switch to another workspace before deleting this one' }, 400);
  }
  if (confirm.trim() !== w.rows[0].name) {
    return ok({ error: 'workspace name confirmation does not match' }, 400);
  }
  await purgeWorkspace(pool, id);
  return ok({ deleted: true });
};

/**
 * DELETE /admin/workspaces/:id — a PLATFORM admin deletes ANY workspace and ALL
 * its data (audited). Same name-confirmation guard; cross-tenant, so no company
 * scoping.
 */
export const adminDeleteWorkspace: Handler = async (ctx, pool, req) => {
  const id = req.params.id!;
  const confirm = typeof asObject(req.body).confirm_name === 'string' ? String(asObject(req.body).confirm_name) : '';
  const w = await pool.query<{ name: string }>('SELECT name FROM workspaces WHERE id = $1', [id]);
  if (!w.rows[0]) return ok({ error: 'not found' }, 404);
  const name = w.rows[0].name;
  if (confirm.trim() !== name) {
    return ok({ error: 'workspace name confirmation does not match' }, 400);
  }
  await purgeWorkspace(pool, id);
  await writeAuditEntry(
    recordCrossTenantAccess(ctx.userId ?? '', id, 'admin.delete_workspace', { workspace_id: id, name }),
  );
  return ok({ deleted: true });
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
  'PATCH /me': updateMe,
  'GET /workspace/members': listMembers,
  'POST /workspaces': createWorkspace,
  'PATCH /company': renameCompany,
  'PATCH /workspaces/:id': renameWorkspace,
  'DELETE /workspaces/:id': deleteWorkspace,
  'POST /workspace/members': addMember,
  'PATCH /workspace/members': updateMember,
  'GET /workspace/settings': getWorkspaceSettings,
  'PUT /workspace/settings': updateWorkspaceSettings,
  'GET /company/ses-config': getCompanySesConfig,
  'PUT /company/ses-config': putCompanySesConfig,
  'DELETE /company/ses-config': deleteCompanySesConfig,
  'GET /sending-domains': listSendingDomains,
  'POST /sending-domains': createSendingDomain,
  'GET /sending-domains/:id': getSendingDomain,
  'POST /sending-domains/:id/check': checkSendingDomain,
  'DELETE /sending-domains/:id': deleteSendingDomain,
  'GET /domain-senders': listDomainSenders,
  'POST /domain-senders': createDomainSender,
  'DELETE /domain-senders/:id': deleteDomainSender,
  'GET /topics': listTopics,
  'POST /topics': createTopic,
  'PATCH /topics/:id': updateTopic,
  'DELETE /topics/:id': deleteTopic,
  'GET /segments': listSegments,
  'GET /segments/:id': getSegment,
  'POST /segments': createSegment,
  'PUT /segments/:id': updateSegment,
  'POST /segments/preview': previewSegment,
  'GET /segments/:id/members': getSegmentMembers,
  'POST /segments/:id/members': addSegmentMembers,
  'DELETE /segments/:id/members': removeSegmentMembers,
  'POST /segments/:id/import-csv': importCsvMembers,
  'GET /templates': listTemplates,
  'POST /templates': createTemplate,
  'GET /templates/:id': getTemplate,
  'PUT /templates/:id': updateTemplate,
  'DELETE /templates/:id': deleteTemplate,
  'POST /templates/:id/clone': cloneTemplate,
  'POST /assets': uploadAsset,
  'GET /assets': listAssets,
  'POST /asset-folders': createAssetFolder,
  'PATCH /assets/:id': updateAsset,
  'DELETE /assets/:id': deleteAsset,
  'PATCH /asset-folders': renameAssetFolder,
  'DELETE /asset-folders': deleteAssetFolder,
  'GET /broadcasts': listBroadcasts,
  'POST /broadcasts': createBroadcast,
  'GET /broadcasts/:id': getBroadcast,
  'GET /broadcasts/:id/preview': previewBroadcast,
  'PUT /broadcasts/:id': updateBroadcast,
  'DELETE /broadcasts/:id': deleteBroadcast,
  'POST /broadcasts/:id/duplicate': duplicateBroadcast,
  'POST /broadcasts/:id/send': sendBroadcast,
  'GET /campaigns': listCampaigns,
  'GET /campaigns/:id': getCampaign,
  'GET /campaigns/:id/versions': listCampaignVersions,
  'GET /campaigns/:id/enrollments': listCampaignEnrollments,
  'POST /campaigns': createCampaign,
  'DELETE /campaigns/:id': deleteCampaign,
  'PUT /campaigns/:id': updateCampaign,
  'PUT /campaigns/:id/draft': saveCampaignDraft,
  'POST /campaigns/:id/publish': publishCampaign,
  'POST /campaigns/:id/revert': revertCampaign,
  'POST /campaigns/:id/activate': activateCampaign,
  'POST /campaigns/:id/pause': pauseCampaign,
  'POST /campaigns/:id/resume': resumeCampaign,
  'POST /campaigns/:id/archive': archiveCampaign,
  'POST /campaigns/:id/send-nodes/:nodeId/attach-template': attachCampaignSendTemplate,
  'POST /campaigns/:id/enroll': enrollIntoCampaign,
  'GET /profiles': listProfiles,
  'POST /profiles': createProfile,
  'POST /profiles/import-csv': importProfilesCsv,
  'GET /profiles/attribute-keys': listAttributeKeys,
  'GET /profiles/attribute-values': listAttributeValues,
  'GET /events/types': listEventTypes,
  'GET /events/payload-keys': listEventPayloadKeys,
  'GET /events/payload-values': listEventPayloadValues,
  'GET /profiles/:id': getProfile,
  'PATCH /profiles/:id': updateProfile,
  'POST /profiles/:id/merge': mergeProfiles,
  'GET /profiles/:id/events': listProfileEvents,
  'POST /profiles/:id/events': sendProfileEvent,
  'GET /profiles/:id/delivery': getProfileDelivery,
  'GET /profiles/:id/segments': listProfileSegments,
  'GET /activity': listActivity,
  'GET /dashboards/summary': dashboardSummary,
  'GET /dashboards/delivery-health': dashboardDeliveryHealth,
  'GET /suppressions': listSuppressions,
  'GET /billing/usage': billingUsage,
  'GET /admin/companies': adminListCompanies,
  'POST /admin/companies': adminCreateCompany,
  'PATCH /admin/companies/:id': adminRenameCompany,
  'DELETE /admin/companies/:id': adminDeleteCompany,
  'PATCH /admin/workspaces/:id': adminUpdateWorkspace,
  'DELETE /admin/workspaces/:id': adminDeleteWorkspace,
  'GET /admin/workspaces': adminListWorkspaces,
  'GET /admin/workspaces/:id': adminGetWorkspace,
};
