// Consolidated §18 acceptance gate (phase 14 "Hardening", §17).
//
// ONE it() per §18 bullet, each LABELED with the bullet text, each COMPOSING the
// REAL production cores (it does NOT re-implement any logic):
//   ingest (resolveWorkspaceId/buildProfileUpsert/buildSqsMessage)
//   processor handler (makeProcessorHandler — the real DLQ/idempotency path)
//   processor tx (planProcessing/runPlanInWorkspaceTx — incl. realtime segments)
//   dispatcher (dispatchOutbox — gate/suppression/cap/quiet-hours/SES)
//   feedback (handleNotification — suppression + reputation auto-suspend)
//   unsubscribe (parse + suppression write)
//   onboarding (startDomain/activate — SES+DNS mocked)
//   broadcast (runBroadcast — resolve audience → outbox → dispatch, dedupe)
//   campaign-runner (enrollFromSegmentChange/runEnrollment — advance, idempotent)
//   metering (computeAllWorkspaceCosts — cost attribution to the cent)
//   service-api (contextFromAuthorizer/enforceRoute/handleAdminAccess) + tenancy
//   RLS backstop (TEST_APP_ROLE / setSessionClaims) for the user-context path
//
// SES/SNS/S3 are mocked at the boundary; Postgres is REAL and NEVER mocked.
// Gated on DATABASE_URL; skips cleanly when no Postgres is reachable.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  adminPool,
  applyMigrations,
  hasDatabaseUrl,
  ensureTestAppRole,
  setSessionClaims,
  TEST_APP_ROLE,
} from '@cdp/db';
import type { EventEnvelope } from '@cdp/shared';

type Pool = ReturnType<typeof adminPool>;

import { resolveWorkspaceId, buildProfileUpsert, buildSqsMessage } from '@cdp/service-ingest';
import {
  parseProcessorMessage,
  planProcessing,
  runPlanInWorkspaceTx,
  makeProcessorHandler,
} from '@cdp/service-processor';
import {
  dispatchOutbox,
  parseOutboxIdFromSqsRecord,
  runStatementsInWorkspaceTx as dispatcherTx,
  type DispatchDeps,
} from '@cdp/service-dispatcher';
import { handleNotification, runFeedbackStatementsInTx, type FeedbackDeps } from '@cdp/service-feedback';
import {
  parseUnsubscribeRequest,
  buildUnsubscribeSuppression,
  runUnsubscribeInWorkspaceTx,
} from '@cdp/service-unsubscribe';
import {
  startDomain,
  activate,
  makeWorkspaceTxRunner,
  makeSendingIdentityReader,
  configSetNameFor,
  buildDnsRecordSet,
  type ActivateDeps,
  type DnsResolver,
  type DnsRecordType,
} from '@cdp/service-onboarding';
import {
  runBroadcast,
  runStatementsInWorkspaceTx as broadcastTx,
  type BroadcastDeps,
} from '@cdp/service-broadcast';
import {
  enrollFromSegmentChange,
  runEnrollment,
  runStatementsInWorkspaceTx as campaignTx,
  type EnrollDeps,
  type RunDeps,
  type SegmentChangeLogRow,
  type CampaignDefinition,
} from '@cdp/service-campaign-runner';
import {
  computeAllWorkspaceCosts,
  DEFAULT_PRICES,
  type WorkspaceUsage,
  decideIpRecommendation,
  DEFAULT_IP_THRESHOLDS,
  computeDirectCost,
  upgradeIp,
  planCompleteUpgrade,
  runStatementsInWorkspaceTx as meteringTx,
  type MeteringDeps,
  type MonthSeries,
} from '@cdp/service-metering';
import { switchActiveWorkspace } from '@cdp/tenancy';
import type { Membership } from '@cdp/shared';
import {
  evaluateRealtimeSegmentsForProfile,
  addManualMembers,
  resolveAudience,
  type EvaluateDeps,
} from '@cdp/segments';
import {
  contextFromAuthorizer,
  enforceRoute,
  handleAdminAccess,
  RouteForbiddenError,
  type RequestLike,
} from '@cdp/service-api';
import type { SesEmailClient, SendEmailInput, SendEmailResult, DkimStatus } from '@cdp/email';

const describeMaybe = hasDatabaseUrl() ? describe : describe.skip;

// ── File-local namespace (unique workspace UUIDs for parallel safety) ─────────
const WS_A = 'acc18000-0000-4000-8000-000000000001';
const WS_B = 'acc18000-0000-4000-8000-000000000002';
const WS_ONB = 'acc18000-0000-4000-8000-000000000003';
const WS_GATE = 'acc18000-0000-4000-8000-000000000004';
const WS_REP = 'acc18000-0000-4000-8000-000000000005';
const ALL_WS = [WS_A, WS_B, WS_ONB, WS_GATE, WS_REP];
const KEY_A = 'acc18-key-A';
const KEY_B = 'acc18-key-B';
const SEG_FEW = 'acc18000-0000-4000-8000-0000000000a1'; // "<3 events" realtime segment (WS_A)
const SEG_CAMP = 'acc18000-0000-4000-8000-0000000000a2'; // campaign trigger segment (WS_A)
const CAMP = 'acc18000-0000-4000-8000-0000000000c1';
const TPL_A = 'acc18000-0000-4000-8000-0000000000e1';
const ADMIN_USER = 'acc18000-0000-4000-8000-0000000000f1';

const REGION = 'us-east-1';
const DKIM_TOKENS = ['acc18tok1', 'acc18tok2', 'acc18tok3'];
const DOMAIN_ONB = 'mail.acc18-onb.test';
const UNSUB_BASE = 'https://api.cdp.example/unsubscribe';

const KEY_ROWS: Record<string, { api_key_id: string; workspace_id: string }> = {
  [KEY_A]: { api_key_id: KEY_A, workspace_id: WS_A },
  [KEY_B]: { api_key_id: KEY_B, workspace_id: WS_B },
};

let evSeq = 0;
const evId = () => `acc18000-0000-4000-8000-${String(++evSeq).padStart(12, '0')}`;
let sesSeq = 0;
const nextSesId = () => `acc18-ses-${String(++sesSeq).padStart(6, '0')}`;

const CAMP_DEF: CampaignDefinition = {
  startNode: 'trig',
  nodes: {
    trig: { type: 'trigger', kind: 'segment_entry', next: 'wait1' },
    wait1: { type: 'wait', delay: { seconds: 86400 }, next: 'cond' },
    cond: {
      type: 'condition',
      ast: { field: 'features.counters.purchase', operator: '>=', value: 1 },
      onTrue: 'send',
      onFalse: 'done',
    },
    send: { type: 'action', kind: 'send', template_id: TPL_A, next: 'done' },
    done: { type: 'exit' },
  },
};

// ── Mocked boundaries ─────────────────────────────────────────────────────────
class CountingSes implements SesEmailClient {
  public sends: SendEmailInput[] = [];
  async sendEmail(input: SendEmailInput): Promise<SendEmailResult> {
    this.sends.push(input);
    return { sesMessageId: nextSesId() };
  }
  async createDomainIdentity(domain: string) {
    return { identity: domain, dkimTokens: DKIM_TOKENS };
  }
  async getIdentityVerificationAttributes() {
    return { dkimStatus: 'SUCCESS' as const, signingEnabled: true, dkimTokens: DKIM_TOKENS };
  }
  async createConfigurationSet() {
    /* no-op */
  }
  async provisionDedicatedIp() {
    /* no-op */
  }
}
class CapturingSqs {
  public bodies: string[] = [];
  async send(c: { input?: { MessageBody?: string } }) {
    this.bodies.push(c.input?.MessageBody ?? '');
    return {};
  }
}
function onboardingSes(status: DkimStatus): SesEmailClient {
  return {
    async createDomainIdentity(d: string) {
      return { identity: d, dkimTokens: DKIM_TOKENS };
    },
    async getIdentityVerificationAttributes() {
      return { dkimStatus: status, signingEnabled: status === 'SUCCESS', dkimTokens: DKIM_TOKENS };
    },
    async createConfigurationSet() {},
    async sendEmail() {
      return { sesMessageId: nextSesId() };
    },
    async provisionDedicatedIp() {},
  } as unknown as SesEmailClient;
}
function dnsRequiredFound(fromDomain: string, mailFrom: string): DnsResolver {
  const set = buildDnsRecordSet(fromDomain, DKIM_TOKENS, mailFrom, REGION);
  const m = new Map<string, string[]>();
  for (const r of set.records) {
    if (r.required && r.role !== 'dkim') m.set(`${r.name}|${r.type}`, [r.value]);
  }
  return {
    async resolve(name: string, type: DnsRecordType) {
      return m.get(`${name}|${type}`) ?? [];
    },
  };
}

// ── Dependency wiring (real tx paths against real Postgres) ───────────────────
function dispatchDeps(pool: Pool, ses: CountingSes, now: Date): DispatchDeps {
  return {
    reader: { query: (text, values) => pool.query(text, values as unknown[]) as never },
    ses,
    runInWorkspaceTx: (ws, statements) => dispatcherTx(pool, ws, statements),
    now: () => now,
    unsubscribeBaseUrl: UNSUB_BASE,
  };
}
function feedbackDeps(pool: Pool): FeedbackDeps {
  return {
    reader: {
      async query<T>(text: string, values?: readonly unknown[]): Promise<{ rows: T[] }> {
        const res = await pool.query(text, values as unknown[]);
        return { rows: res.rows as T[] };
      },
    },
    runInWorkspaceTx: (w, s) => runFeedbackStatementsInTx(pool, w, s),
  };
}
function enrollDeps(pool: Pool): EnrollDeps {
  return {
    reader: { query: (t, v) => pool.query(t, v as unknown[]) as never },
    runInWorkspaceTx: (w, s) => campaignTx(pool, w, s),
  };
}
function runDeps(pool: Pool, now: Date, sqs: CapturingSqs): RunDeps {
  return {
    reader: { query: (t, v) => pool.query(t, v as unknown[]) as never },
    sqs: sqs as never,
    runInWorkspaceTx: (w, s) => campaignTx(pool, w, s),
    now: () => now,
    dispatchQueueUrl: 'https://sqs/dispatch',
  };
}
function meteringDeps(pool: Pool): MeteringDeps {
  return {
    reader: { query: (text, values) => pool.query(text, values as unknown[]) as never },
    runInWorkspaceTx: (w, s) => meteringTx(pool, w, s),
  };
}
function evaluateDeps(pool: Pool): EvaluateDeps {
  return {
    reader: { query: (text, values) => pool.query(text, values as unknown[]) as never },
    runInWorkspaceTx: (w, s) =>
      campaignTx(pool, w, s) as unknown as Promise<void>, // reuse the real workspace-scoped tx runner
  };
}
function broadcastDeps(pool: Pool, sqs: CapturingSqs, now: Date): BroadcastDeps {
  return {
    reader: {
      async query<T = Record<string, unknown>>(text: string, values?: readonly unknown[]) {
        const r = await pool.query(text, values ? [...values] : undefined);
        return { rows: r.rows as T[] };
      },
    },
    sqs: sqs as never,
    runInWorkspaceTx: (w, s) => broadcastTx(pool, w, s),
    now: () => now,
    dispatchQueueUrl: 'https://sqs/dispatch',
  };
}

// ── DB helpers ────────────────────────────────────────────────────────────────
async function ingestThenProcess(
  pool: Pool,
  apiKeyId: string,
  externalId: string,
  type: string,
  occurredAt: string,
  attributes: Record<string, unknown> = {},
  eventId = evId(),
): Promise<void> {
  const envelope: EventEnvelope = { event_id: eventId, external_id: externalId, type, occurred_at: occurredAt, attributes };
  const workspaceId = resolveWorkspaceId(apiKeyId, KEY_ROWS[apiKeyId]);
  const upsert = buildProfileUpsert(workspaceId, externalId, type === 'profile_created' ? attributes : {});
  const { rows } = await pool.query(upsert.text, upsert.values);
  const profileId = rows[0].id as string;
  const sqs = buildSqsMessage(workspaceId, profileId, envelope, 'https://sqs.local/q.fifo');
  const body = sqs.input.MessageBody as string;
  const msg = parseProcessorMessage(body);
  await runPlanInWorkspaceTx(pool, msg.workspace_id, planProcessing(msg));
}

async function profileId(pool: Pool, ws: string, email: string): Promise<string> {
  const { rows } = await pool.query('SELECT id FROM profiles WHERE workspace_id=$1 AND email=$2', [ws, email]);
  return rows[0].id as string;
}
// outbox.dedupe_key is GLOBALLY unique — namespace every manual key with a
// per-run token so an interrupted prior run can never collide.
const RUN = `acc18-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
async function enqueueOutbox(
  pool: Pool,
  ws: string,
  pid: string,
  tpl: string,
  dedupe: string,
  payloadExtra: Record<string, unknown> = {},
): Promise<string> {
  const o = await pool.query(
    `INSERT INTO outbox (workspace_id, profile_id, template_id, dedupe_key, status, payload)
     VALUES ($1,$2,$3,$4,'pending',$5::jsonb) RETURNING id`,
    [ws, pid, tpl, `${RUN}-${dedupe}`, JSON.stringify({ subject: 'Hi', merge: { first_name: 'Ada' }, ...payloadExtra })],
  );
  return o.rows[0].id as string;
}
async function statusOf(pool: Pool, ws: string): Promise<string> {
  const { rows } = await pool.query('SELECT status FROM workspaces WHERE id=$1', [ws]);
  return rows[0].status as string;
}
async function changeLog(pool: Pool, ws: string, ext: string, segmentId?: string): Promise<string[]> {
  const { rows } = await pool.query(
    `SELECT scl.action FROM segment_change_log scl JOIN profiles p ON p.id=scl.profile_id
      WHERE scl.workspace_id=$1 AND p.external_id=$2 ${segmentId ? 'AND scl.segment_id=$3' : ''}
      ORDER BY scl.occurred_at, scl.id`,
    segmentId ? [ws, ext, segmentId] : [ws, ext],
  );
  return rows.map((r: { action: string }) => r.action);
}

async function cleanup(pool: Pool): Promise<void> {
  for (const t of [
    'segment_change_log',
    'segment_memberships',
    'messages_log',
    'usage_counters',
    'outbox', // FK → campaigns; delete before campaigns
    'campaign_enrollments',
    'campaigns',
    'broadcasts',
    'email_events',
    'suppressions',
    'email_templates',
    'segments',
    'profile_features',
    'events',
    'profiles',
    'workspace_api_keys',
    'admin_audit_log',
    'workspace_users',
  ]) {
    if (t === 'admin_audit_log') {
      await pool.query('DELETE FROM admin_audit_log WHERE user_id = $1', [ADMIN_USER]);
    } else if (t === 'workspace_users') {
      await pool.query('DELETE FROM workspace_users WHERE workspace_id = ANY($1)', [ALL_WS]);
    } else {
      await pool.query(`DELETE FROM ${t} WHERE workspace_id = ANY($1)`, [ALL_WS]);
    }
  }
  await pool.query("DELETE FROM global_hard_bounces WHERE email LIKE '%@acc18.example'");
  await pool.query('DELETE FROM workspaces WHERE id = ANY($1)', [ALL_WS]);
}

describeMaybe('§18 acceptance gate — composing the real cores', () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = adminPool();
    const { rows } = await pool.query("SELECT to_regclass('public.workspaces') IS NOT NULL AS exists");
    if (!rows[0].exists) await applyMigrations(pool);
    await ensureTestAppRole(pool); // for the RLS backstop bullet
    await cleanup(pool);

    // Active verified senders.
    for (const ws of [WS_A, WS_B, WS_REP]) {
      await pool.query(
        `INSERT INTO workspaces (id, name, status, sending_identity) VALUES ($1,'W','active',$2::jsonb)`,
        [ws, JSON.stringify({ verified: true, from_domain: `mail.${ws}.acc18`, config_set: configSetNameFor(ws) })],
      );
    }
    await pool.query("INSERT INTO workspaces (id, name, status) VALUES ($1,'ONB','onboarding')", [WS_ONB]);
    await pool.query("INSERT INTO workspaces (id, name, status) VALUES ($1,'GATE','onboarding')", [WS_GATE]);
    await pool.query("INSERT INTO workspace_api_keys (api_key_id, workspace_id) VALUES ($1,$2),($3,$4)", [
      KEY_A, WS_A, KEY_B, WS_B,
    ]);
    // Realtime segment "<3 events" in WS_A only.
    await pool.query(
      `INSERT INTO segments (id, workspace_id, name, definition, kind, status)
       VALUES ($1,$2,'few-events',$3::jsonb,'dynamic_realtime','active')`,
      [SEG_FEW, WS_A, JSON.stringify({ op: 'and', conditions: [{ field: 'total_events', operator: '<', value: 3 }] })],
    );
    // Campaign trigger segment + an active campaign in WS_A.
    // Draft status → the realtime evaluator skips it (it only selects active
    // realtime segments), so its null definition cannot match-all and churn
    // memberships. The campaign still references it as its trigger segment.
    await pool.query("INSERT INTO segments (id, workspace_id, name, kind, status) VALUES ($1,$2,'camp-seg','dynamic_realtime','draft')", [SEG_CAMP, WS_A]);
    await pool.query("INSERT INTO email_templates (id, workspace_id, name, mjml, compiled_html) VALUES ($1,$2,'t','<m/>','<html>Hi {{first_name}}</html>')", [TPL_A, WS_A]);
    await pool.query(
      "INSERT INTO campaigns (id, workspace_id, name, definition, trigger_segment_id, status) VALUES ($1,$2,'C',$3::jsonb,$4,'active')",
      [CAMP, WS_A, JSON.stringify(CAMP_DEF), SEG_CAMP],
    );
  });

  afterAll(async () => {
    await cleanup(pool);
    await pool.end();
  });

  it('§18 Tenant isolation: ingest+processor keep two workspaces separate; service-role scopes by workspace_id in code', async () => {
    const ext = 'iso-shared';
    const t = '2026-01-01T00:00:00.000Z';
    await ingestThenProcess(pool, KEY_A, ext, 'profile_created', t, { email: 'iso@acc18.example', plan: 'gold' });
    await ingestThenProcess(pool, KEY_B, ext, 'profile_created', t, { email: 'iso@acc18.example', plan: 'silver' });
    await ingestThenProcess(pool, KEY_A, ext, 'progress', '2026-01-01T01:00:00Z');

    const a = await pool.query("SELECT total_events, (SELECT attributes->>'plan' FROM profiles p WHERE p.id=pf.profile_id) plan FROM profile_features pf JOIN profiles p ON p.id=pf.profile_id WHERE p.workspace_id=$1 AND p.external_id=$2", [WS_A, ext]);
    const b = await pool.query("SELECT total_events, (SELECT attributes->>'plan' FROM profiles p WHERE p.id=pf.profile_id) plan FROM profile_features pf JOIN profiles p ON p.id=pf.profile_id WHERE p.workspace_id=$1 AND p.external_id=$2", [WS_B, ext]);
    expect(a.rows[0].total_events).toBe(2);
    expect(b.rows[0].total_events).toBe(1);
    expect(a.rows[0].plan).toBe('gold');
    expect(b.rows[0].plan).toBe('silver');
  });

  it('§18 Tenant isolation (RLS backstop): a Workspace-A user-context (TEST_APP_ROLE) cannot read Workspace-B rows', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SET LOCAL ROLE ${TEST_APP_ROLE}`); // non-BYPASSRLS
      await setSessionClaims(client, { workspace_id: WS_A, sub: 'user-a', is_platform_admin: false }, true);
      // Under RLS the WS_A claim sees ONLY WS_A profiles, never WS_B's.
      const seen = await client.query('SELECT workspace_id FROM profiles');
      const others = seen.rows.filter((r: { workspace_id: string }) => r.workspace_id !== WS_A);
      expect(others).toHaveLength(0);
      expect(seen.rows.length).toBeGreaterThan(0); // not vacuous — WS_A rows ARE visible
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  });

  it('§18 Roles (system-admin audited exception): a cross-tenant access writes an admin_audit_log row', async () => {
    await pool.query('INSERT INTO platform_admins (user_id) VALUES ($1) ON CONFLICT DO NOTHING', [ADMIN_USER]);
    // Admin's active claim is WS_A; the operation TOUCHES WS_B → cross-tenant.
    const event: RequestLike = {
      requestContext: { authorizer: { sub: ADMIN_USER, workspace_id: WS_A, is_platform_admin: 'true' } },
    };
    const ctx = contextFromAuthorizer(event);
    enforceRoute(ctx, 'view_all_workspaces'); // system-admin only — must not throw
    const writes: { user_id: string; workspace_id: string | null; action: string }[] = [];
    await handleAdminAccess(ctx, WS_B, 'admin.read_workspace', { id: WS_B }, async (e) => {
      await pool.query('INSERT INTO admin_audit_log (user_id, workspace_id, action, detail) VALUES ($1,$2,$3,$4)', [
        e.user_id, e.workspace_id, e.action, JSON.stringify(e.detail ?? {}),
      ]);
      writes.push({ user_id: e.user_id, workspace_id: e.workspace_id, action: e.action });
    });
    expect(writes).toHaveLength(1);
    const audit = await pool.query('SELECT action, workspace_id FROM admin_audit_log WHERE user_id=$1 ORDER BY id DESC LIMIT 1', [ADMIN_USER]);
    expect(audit.rows[0].action).toBe('admin.read_workspace');
    expect(audit.rows[0].workspace_id).toBe(WS_B);
    await pool.query('DELETE FROM platform_admins WHERE user_id=$1', [ADMIN_USER]);
  });

  it('§18 Roles (§3A): marketer cannot manage users/domains/billing; accounting can read billing not edit content; owner can both', () => {
    const mk = (role: 'owner' | 'marketer' | 'accounting'): RequestLike => ({
      requestContext: { authorizer: { sub: 'u', workspace_id: WS_A, role, is_platform_admin: 'false' } },
    });
    const marketer = contextFromAuthorizer(mk('marketer'));
    expect(() => enforceRoute(marketer, 'manage_content')).not.toThrow();
    expect(() => enforceRoute(marketer, 'manage_workspace_users')).toThrow(RouteForbiddenError);
    expect(() => enforceRoute(marketer, 'manage_sending_domain')).toThrow(RouteForbiddenError);
    expect(() => enforceRoute(marketer, 'view_billing')).toThrow(RouteForbiddenError);

    const accounting = contextFromAuthorizer(mk('accounting'));
    expect(() => enforceRoute(accounting, 'view_billing')).not.toThrow();
    expect(() => enforceRoute(accounting, 'manage_content')).toThrow(RouteForbiddenError);

    const owner = contextFromAuthorizer(mk('owner'));
    expect(() => enforceRoute(owner, 'manage_workspace_users')).not.toThrow();
    expect(() => enforceRoute(owner, 'manage_content')).not.toThrow();
    expect(() => enforceRoute(owner, 'view_billing')).not.toThrow();
  });

  it('§18 Ordering: profile_created→progress AND progress-first both converge to one profile, in order', async () => {
    const e1 = 'ord-created-first';
    await ingestThenProcess(pool, KEY_A, e1, 'profile_created', '2026-02-01T00:00:00Z', { email: 'o1@acc18.example' });
    await ingestThenProcess(pool, KEY_A, e1, 'progress', '2026-02-01T01:00:00Z');
    const c1 = await pool.query('SELECT count(*)::int n FROM profiles WHERE workspace_id=$1 AND external_id=$2', [WS_A, e1]);
    expect(c1.rows[0].n).toBe(1);

    const e2 = 'ord-progress-first';
    await ingestThenProcess(pool, KEY_A, e2, 'progress', '2026-02-02T01:00:00Z');
    await ingestThenProcess(pool, KEY_A, e2, 'profile_created', '2026-02-02T00:00:00Z', { email: 'o2@acc18.example', k: 'late' });
    const c2 = await pool.query("SELECT count(*)::int n, max(attributes->>'k') k FROM profiles WHERE workspace_id=$1 AND external_id=$2", [WS_A, e2]);
    expect(c2.rows[0].n).toBe(1);
    expect(c2.rows[0].k).toBe('late');
  });

  it('§18 No loss: a forced processor failure routes to the DLQ path (batchItemFailures), then replay processes it', async () => {
    const ext = 'noloss-cust';
    const eventId = evId();
    const wsId = resolveWorkspaceId(KEY_A, KEY_ROWS[KEY_A]);
    const upsert = buildProfileUpsert(wsId, ext, {});
    const { rows } = await pool.query(upsert.text, upsert.values);
    const sqs = buildSqsMessage(wsId, rows[0].id as string, { event_id: eventId, external_id: ext, type: 'purchase', occurred_at: '2026-03-01T00:00:00Z', attributes: { amount: 10 } }, 'https://sqs.local/q.fifo');
    const body = sqs.input.MessageBody as string;

    // Real processor handler with an injected tx that FAILS once → record is NOT
    // acked → it goes to batchItemFailures (the DLQ/redrive path).
    let fail = true;
    const failingHandler = makeProcessorHandler({
      runInWorkspaceTx: async (ws, plan) => {
        if (fail) throw new Error('forced failure');
        await runPlanInWorkspaceTx(pool, ws, plan);
      },
    });
    const res1 = await failingHandler({ Records: [{ messageId: 'm1', body }] });
    expect(res1.batchItemFailures).toEqual([{ itemIdentifier: 'm1' }]);
    const mid = await pool.query('SELECT count(*)::int n FROM events WHERE workspace_id=$1 AND event_id=$2', [wsId, eventId]);
    expect(mid.rows[0].n).toBe(0); // nothing committed yet — but not lost

    // Replay (SQS redelivery) with the tx now succeeding → fully processed, none vanished.
    fail = false;
    const res2 = await failingHandler({ Records: [{ messageId: 'm1', body }] });
    expect(res2.batchItemFailures).toEqual([]);
    const after = await pool.query('SELECT count(*)::int n FROM events WHERE workspace_id=$1 AND event_id=$2', [wsId, eventId]);
    expect(after.rows[0].n).toBe(1);
  });

  it('§18 Idempotency: replaying the same event_id is applied exactly once', async () => {
    const ext = 'idem-cust';
    const fixed = evId();
    await ingestThenProcess(pool, KEY_A, ext, 'purchase', '2026-03-02T00:00:00Z', { amount: 40 }, fixed);
    await ingestThenProcess(pool, KEY_A, ext, 'purchase', '2026-03-02T00:00:00Z', { amount: 40 }, fixed);
    const ev = await pool.query('SELECT count(*)::int n FROM events WHERE workspace_id=$1 AND event_id=$2', [WS_A, fixed]);
    expect(ev.rows[0].n).toBe(1);
    const pf = await pool.query('SELECT pf.total_events, pf.monetary_total FROM profile_features pf JOIN profiles p ON p.id=pf.profile_id WHERE p.workspace_id=$1 AND p.external_id=$2', [WS_A, ext]);
    expect(pf.rows[0].total_events).toBe(1);
    expect(Number(pf.rows[0].monetary_total)).toBe(40);
  });

  it('§18 Segmentation enter/exit: crossing a predicate fires exactly one entered then one exited, never another workspace', async () => {
    const ext = 'seg-cust';
    await ingestThenProcess(pool, KEY_A, ext, 'progress', '2026-04-01T00:00:00Z'); // total=1 (<3) enter
    await ingestThenProcess(pool, KEY_A, ext, 'progress', '2026-04-01T01:00:00Z'); // total=2 (<3) no change
    await ingestThenProcess(pool, KEY_A, ext, 'progress', '2026-04-01T02:00:00Z'); // total=3 exit
    expect(await changeLog(pool, WS_A, ext, SEG_FEW)).toEqual(['entered', 'exited']);
    // WS_B has the same external_id + matching count but NO segment → never enters A's.
    await ingestThenProcess(pool, KEY_B, ext, 'progress', '2026-04-01T00:00:00Z');
    expect(await changeLog(pool, WS_B, ext, SEG_FEW)).toEqual([]);
  });

  it('§18 Sending gated on verification: onboarding startDomain→activate flips active; then the workspace can send', async () => {
    const txRunner = makeWorkspaceTxRunner(pool);
    await startDomain({ ses: onboardingSes('PENDING'), region: REGION, runInWorkspaceTx: txRunner }, { workspaceId: WS_ONB, fromDomain: DOMAIN_ONB });
    expect(await statusOf(pool, WS_ONB)).toBe('onboarding');
    const deps: ActivateDeps = {
      ses: onboardingSes('SUCCESS'),
      dns: dnsRequiredFound(DOMAIN_ONB, `mail.${DOMAIN_ONB}`),
      identity: makeSendingIdentityReader(pool),
      region: REGION,
      runInWorkspaceTx: txRunner,
      configSetName: configSetNameFor,
    };
    const out = await activate(deps, { workspaceId: WS_ONB });
    expect(out.decision.allowed).toBe(true);
    expect(await statusOf(pool, WS_ONB)).toBe('active');

    const ses = new CountingSes();
    await pool.query("INSERT INTO profiles (workspace_id, external_id, email) VALUES ($1,'onb-c','onb@acc18.example')", [WS_ONB]);
    await pool.query("INSERT INTO email_templates (id, workspace_id, name, mjml, compiled_html) VALUES ($1,$2,'t','<m/>','<html>Hi {{first_name}}</html>')", ['acc18000-0000-4000-8000-0000000000e2', WS_ONB]);
    const pid = await profileId(pool, WS_ONB, 'onb@acc18.example');
    const ob = await enqueueOutbox(pool, WS_ONB, pid, 'acc18000-0000-4000-8000-0000000000e2', 'onb-send-1');
    const r = await dispatchOutbox(dispatchDeps(pool, ses, new Date('2026-06-10T12:00:00Z')), ob);
    expect(r.result).toBe('send');
    expect(ses.sends[0]!.configurationSetName).toBe(configSetNameFor(WS_ONB));
  });

  it('§18 Sending gated on verification (gate): a NOT-active workspace dispatch is refused, SES never called', async () => {
    const ses = new CountingSes();
    await pool.query("INSERT INTO profiles (workspace_id, external_id, email) VALUES ($1,'gate-c','gate@acc18.example')", [WS_GATE]);
    await pool.query("INSERT INTO email_templates (id, workspace_id, name, mjml, compiled_html) VALUES ($1,$2,'t','<m/>','<html/>')", ['acc18000-0000-4000-8000-0000000000e3', WS_GATE]);
    const pid = await profileId(pool, WS_GATE, 'gate@acc18.example');
    const ob = await enqueueOutbox(pool, WS_GATE, pid, 'acc18000-0000-4000-8000-0000000000e3', 'gate-send-1');
    const r = await dispatchOutbox(dispatchDeps(pool, ses, new Date('2026-06-10T12:00:00Z')), ob);
    expect(r.result).toBe('refuse');
    expect(ses.sends).toHaveLength(0);
  });

  it('§18 Suppression scoping: unsubscribe in A does not suppress the same email in B; hard bounce suppresses in-workspace + globally', async () => {
    const shared = 'sup-shared@acc18.example';
    await pool.query("INSERT INTO profiles (workspace_id, external_id, email, email_status) VALUES ($1,'sup-a',$2,'active')", [WS_A, shared]);
    const bPid = (await pool.query("INSERT INTO profiles (workspace_id, external_id, email, email_status) VALUES ($1,'sup-b',$2,'active') RETURNING id", [WS_B, shared])).rows[0].id;
    await pool.query("INSERT INTO email_templates (id, workspace_id, name, mjml, compiled_html) VALUES ($1,$2,'t','<m/>','<html/>')", ['acc18000-0000-4000-8000-0000000000e4', WS_B]);

    const link = `${UNSUB_BASE}?workspace_id=${WS_A}&email=${encodeURIComponent(shared)}`;
    const parsed = parseUnsubscribeRequest('POST', link, 'List-Unsubscribe=One-Click');
    expect(parsed.valid).toBe(true);
    if (!parsed.valid) throw new Error('unreachable');
    await runUnsubscribeInWorkspaceTx(pool, parsed.workspaceId, [buildUnsubscribeSuppression(parsed.workspaceId, parsed.email, 'one-click')]);
    const supA = await pool.query('SELECT 1 FROM suppressions WHERE workspace_id=$1 AND email=$2', [WS_A, shared]);
    const supB = await pool.query('SELECT 1 FROM suppressions WHERE workspace_id=$1 AND email=$2', [WS_B, shared]);
    expect(supA.rowCount).toBe(1);
    expect(supB.rowCount).toBe(0); // B unaffected

    // B can still send to the shared email (positive control).
    const ses = new CountingSes();
    const ob = await enqueueOutbox(pool, WS_B, bPid, 'acc18000-0000-4000-8000-0000000000e4', 'sup-b-send');
    const r = await dispatchOutbox(dispatchDeps(pool, ses, new Date('2026-06-10T12:00:00Z')), ob);
    expect(r.result).toBe('send');

    // Hard bounce in A → suppressed in-workspace + globally.
    const fb = await handleNotification(feedbackDeps(pool), {
      eventType: 'Bounce',
      bounce: { bounceType: 'Permanent', bouncedRecipients: [{ emailAddress: 'bounce@acc18.example' }] },
      mail: { messageId: nextSesId(), tags: { workspace_id: [WS_A] } },
    });
    expect(fb.status).toBe('ok');
    const glob = await pool.query('SELECT 1 FROM global_hard_bounces WHERE email=$1', ['bounce@acc18.example']);
    expect(glob.rowCount).toBe(1);
  });

  it('§18 Reputation auto-suspend: a workspace breaching bounce thresholds is suspended; peers stay active', async () => {
    const deps = feedbackDeps(pool);
    const offender = 'rep-bouncer@acc18.example';
    await pool.query("INSERT INTO profiles (workspace_id, external_id, email) VALUES ($1,'rep-1',$2)", [WS_REP, offender]);
    for (let i = 0; i < 60; i++) {
      await pool.query(
        `INSERT INTO messages_log (workspace_id, profile_id, ses_message_id, status)
         SELECT $1, id, $2, 'sent' FROM profiles WHERE workspace_id=$1 AND email=$3`,
        [WS_REP, nextSesId(), offender],
      );
    }
    let last;
    for (let i = 0; i < 4; i++) {
      last = await handleNotification(deps, {
        eventType: 'Bounce',
        bounce: { bounceType: 'Permanent', bouncedRecipients: [{ emailAddress: offender }] },
        mail: { messageId: nextSesId(), tags: { workspace_id: [WS_REP] } },
      });
    }
    expect(last?.status === 'ok' && last.suspended).toBe(true);
    expect(await statusOf(pool, WS_REP)).toBe('suspended');
    expect(await statusOf(pool, WS_A)).toBe('active'); // peer untouched
  });

  it('§18 Broadcasts send-once (dedupe): runBroadcast resolves the audience to outbox once; a replay does not double-enqueue', async () => {
    const SEG_B = 'acc18000-0000-4000-8000-0000000000b1';
    const BCAST = 'acc18000-0000-4000-8000-0000000000b2';
    await pool.query("INSERT INTO segments (id, workspace_id, name, kind) VALUES ($1,$2,'manual','manual')", [SEG_B, WS_A]);
    const bpid = (await pool.query("INSERT INTO profiles (workspace_id, external_id, email) VALUES ($1,'bcast-1','bcast@acc18.example') RETURNING id", [WS_A])).rows[0].id;
    await pool.query("INSERT INTO segment_memberships (segment_id, profile_id, workspace_id, source) VALUES ($1,$2,$3,'manual')", [SEG_B, bpid, WS_A]);
    await pool.query(
      "INSERT INTO broadcasts (id, workspace_id, name, template_id, audience_kind, audience_ref, status) VALUES ($1,$2,'B',$3,'segment',$4,'draft')",
      [BCAST, WS_A, TPL_A, SEG_B],
    );
    const sqs = new CapturingSqs();
    const r1 = await runBroadcast(broadcastDeps(pool, sqs, new Date('2026-06-10T12:00:00Z')), BCAST);
    expect(r1.result).toBe('sent');
    const ob1 = await pool.query('SELECT count(*)::int n FROM outbox WHERE workspace_id=$1 AND profile_id=$2', [WS_A, bpid]);
    expect(ob1.rows[0].n).toBe(1);
    // Replay: status already 'sent' → skipped, no second outbox row (dedupe per (broadcast_id, profile_id)).
    const r2 = await runBroadcast(broadcastDeps(pool, new CapturingSqs(), new Date('2026-06-10T13:00:00Z')), BCAST);
    expect(r2.result).toBe('skipped');
    const ob2 = await pool.query('SELECT count(*)::int n FROM outbox WHERE workspace_id=$1 AND profile_id=$2', [WS_A, bpid]);
    expect(ob2.rows[0].n).toBe(1);
  });

  it('§18 Campaigns advance (idempotent runner): enroll→wait→branch→action(send)→exit through the real dispatcher', async () => {
    const cpid = (await pool.query("INSERT INTO profiles (workspace_id, external_id, email) VALUES ($1,'camp-1','journey@acc18.example') RETURNING id", [WS_A])).rows[0].id;
    await pool.query("INSERT INTO profile_features (profile_id, workspace_id, counters) VALUES ($1,$2,$3::jsonb)", [cpid, WS_A, JSON.stringify({ purchase: 2 })]);

    const change: SegmentChangeLogRow = { workspace_id: WS_A, segment_id: SEG_CAMP, profile_id: cpid, action: 'entered' };
    const enrolled = await enrollFromSegmentChange(enrollDeps(pool), change);
    expect(enrolled.enrolled).toBe(1);
    // A second identical enrollment is idempotent ('once' policy) — the structural
    // ON CONFLICT (campaign_id, profile_id) DO NOTHING means at most ONE row.
    await enrollFromSegmentChange(enrollDeps(pool), change);
    const rowCount = await pool.query('SELECT count(*)::int n FROM campaign_enrollments WHERE workspace_id=$1 AND campaign_id=$2 AND profile_id=$3', [WS_A, CAMP, cpid]);
    expect(rowCount.rows[0].n).toBe(1);

    const enr = await pool.query('SELECT id FROM campaign_enrollments WHERE workspace_id=$1 AND campaign_id=$2 AND profile_id=$3', [WS_A, CAMP, cpid]);
    const enrollmentId = enr.rows[0].id;

    const t0 = new Date('2026-06-07T12:00:00Z');
    const r1 = await runEnrollment(runDeps(pool, t0, new CapturingSqs()), enrollmentId);
    expect(r1.result).toBe('parked'); // trigger→wait→park
    const t2 = new Date('2026-06-08T12:00:01Z');
    const sqs = new CapturingSqs();
    const r2 = await runEnrollment(runDeps(pool, t2, sqs), enrollmentId);
    expect(r2.result).toBe('completed'); // condition(true)→action(send)→exit
    expect(sqs.bodies).toHaveLength(1);

    const ses = new CountingSes();
    const outcome = await dispatchOutbox(dispatchDeps(pool, ses, t2), parseOutboxIdFromSqsRecord(sqs.bodies[0]!));
    expect(outcome.result).toBe('send');
    expect(ses.sends[0]!.to).toBe('journey@acc18.example');

    // Idempotent: re-running the now-terminal enrollment does NOT advance or send
    // again (the runner skips a non-active enrollment).
    const sqs3 = new CapturingSqs();
    const r3 = await runEnrollment(runDeps(pool, t2, sqs3), enrollmentId);
    expect(r3.result).toBe('skipped');
    expect(sqs3.bodies).toHaveLength(0);
    const ml = await pool.query('SELECT count(*)::int n FROM messages_log WHERE workspace_id=$1 AND campaign_id=$2', [WS_A, CAMP]);
    expect(ml.rows[0].n).toBe(1);
  });

  it('§18 Cost attribution: Σ per-workspace cost === direct + fixed to the cent (computeAllWorkspaceCosts)', () => {
    const usages: WorkspaceUsage[] = [
      { workspaceId: WS_A, emails_sent: 10_000, ipUpgraded: false, imageStorageBytes: 0, imageEgressBytes: 0 },
      { workspaceId: WS_B, emails_sent: 300_000, ipUpgraded: true, imageStorageBytes: 0, imageEgressBytes: 0 },
      { workspaceId: WS_REP, emails_sent: 7, ipUpgraded: false, imageStorageBytes: 12_345, imageEgressBytes: 67_890 },
    ];
    const fixedTotal = 40; // §20 worked example
    const view = computeAllWorkspaceCosts(usages, fixedTotal, DEFAULT_PRICES);

    // Σ per-workspace total === directTotal + fixedTotal, penny-exact.
    const sumCents = view.workspaces.reduce((acc, w) => acc + Math.round(w.total * 100), 0);
    const expectedCents = Math.round(view.directTotal * 100) + Math.round(view.fixedTotal * 100);
    expect(sumCents).toBe(expectedCents);
    // Fixed pool split exactly across the active workspaces.
    expect(Math.round(view.fixedTotal * 100)).toBe(Math.round(fixedTotal * 100));
    expect(view.activeWorkspaceCount).toBe(3);
    // The IP fee lands only on the upgraded workspace (§20).
    const wsB = view.workspaces.find((w) => w.workspaceId === WS_B)!;
    const wsA = view.workspaces.find((w) => w.workspaceId === WS_A)!;
    expect(wsB.directCost).toBeGreaterThan(wsA.directCost + DEFAULT_PRICES.dedicatedIpMonthly - 0.01);
  });

  it('§18 IP strategy: shared by default; advisor recommends only on sustained volume+cadence+reputation; upgrade-ip warms + tracks ip_mode/warmup_status; $24.95 only on upgraded', async () => {
    // (a) Shared by default — a freshly-created workspace's effective ip_mode is 'shared'.
    const si0 = await pool.query("SELECT COALESCE(sending_identity->>'ip_mode','shared') AS m FROM workspaces WHERE id=$1", [WS_A]);
    expect(si0.rows[0].m).toBe('shared');

    // (b) Advisor RECOMMENDS only when ALL criteria hold (sustained volume + cadence + reputation).
    const goodMonth = (period: string): MonthSeries => ({
      period, emailsSent: 150_000, activeDays: 25, daysInMonth: 30, bounces: 100, complaints: 1, delivered: 149_000,
    });
    const recommend = decideIpRecommendation(
      [goodMonth('2026-03-01'), goodMonth('2026-04-01'), goodMonth('2026-05-01')],
      DEFAULT_IP_THRESHOLDS,
    );
    expect(recommend.recommend).toBe(true);
    // A single spike (volume only one month, poor cadence) does NOT recommend.
    const noRec = decideIpRecommendation(
      [
        { period: '2026-03-01', emailsSent: 500, activeDays: 1, daysInMonth: 31, bounces: 0, complaints: 0, delivered: 500 },
        { period: '2026-04-01', emailsSent: 500, activeDays: 1, daysInMonth: 30, bounces: 0, complaints: 0, delivered: 500 },
        { period: '2026-05-01', emailsSent: 200_000, activeDays: 1, daysInMonth: 31, bounces: 0, complaints: 0, delivered: 200_000 },
      ],
      DEFAULT_IP_THRESHOLDS,
    );
    expect(noRec.recommend).toBe(false);

    // (c) upgrade-ip provisions (SES) + warms gradually + tracks ip_mode/warmup_status (REAL Postgres write path).
    const upgradeSes = new CountingSes();
    const start = new Date('2026-06-01T00:00:00.000Z');
    await upgradeIp(meteringDeps(pool), upgradeSes, WS_B, 'cdp-pool-acc18-B', start);
    const warming = await pool.query('SELECT sending_identity FROM workspaces WHERE id=$1', [WS_B]);
    const siB = warming.rows[0].sending_identity as Record<string, unknown>;
    expect(siB.ip_mode).toBe('warming');
    expect(siB.ip_pool).toBe('cdp-pool-acc18-B');
    expect((siB.warmup_status as { startedAt: string }).startedAt).toBe(start.toISOString());
    expect(siB.verified).toBe(true); // jsonb merge preserved the verified identity
    // Cut over warming → dedicated.
    await meteringTx(pool, WS_B, [planCompleteUpgrade(WS_B)]);
    const ded = await pool.query("SELECT sending_identity->>'ip_mode' AS m FROM workspaces WHERE id=$1", [WS_B]);
    expect(ded.rows[0].m).toBe('dedicated');

    // (d) The $24.95 dedicated-IP fee lands ONLY on the upgraded workspace.
    const sharedCost = computeDirectCost(
      { emails_sent: 10_000, ipUpgraded: false, imageStorageBytes: 0, imageEgressBytes: 0 },
      DEFAULT_PRICES,
    );
    const upgradedCost = computeDirectCost(
      { emails_sent: 10_000, ipUpgraded: true, imageStorageBytes: 0, imageEgressBytes: 0 },
      DEFAULT_PRICES,
    );
    expect(Math.round((upgradedCost - sharedCost) * 100) / 100).toBe(DEFAULT_PRICES.dedicatedIpMonthly);
  });

  it('§18 Multi-workspace switching: a user in two workspaces re-scopes reads when the active workspace_id claim switches; no cross-bleed', async () => {
    // A user who is a member of BOTH WS_A and WS_B (tenancy switchActiveWorkspace
    // is the REAL claim resolver). Seed one profile per workspace, then prove a
    // workspace_id-scoped read returns ONLY the active workspace's row.
    const memberships: Membership[] = [
      { workspaceId: WS_A, role: 'owner' },
      { workspaceId: WS_B, role: 'marketer' },
    ];
    await pool.query("INSERT INTO profiles (workspace_id, external_id, email) VALUES ($1,'sw-a','sw-a@acc18.example')", [WS_A]);
    await pool.query("INSERT INTO profiles (workspace_id, external_id, email) VALUES ($1,'sw-b','sw-b@acc18.example')", [WS_B]);

    // Switch active → WS_A: the claim's workspace_id is WS_A; a scoped read sees only WS_A.
    const ctxA = switchActiveWorkspace(memberships, WS_A, false);
    expect(ctxA.workspaceId).toBe(WS_A);
    expect(ctxA.role).toBe('owner');
    const readA = await pool.query('SELECT external_id FROM profiles WHERE workspace_id=$1 AND external_id IN ($2,$3)', [
      ctxA.workspaceId, 'sw-a', 'sw-b',
    ]);
    expect(readA.rows.map((r: { external_id: string }) => r.external_id)).toEqual(['sw-a']);

    // Switch active → WS_B: the SAME read re-scopes; A's row is gone, B's appears. No cross-bleed.
    const ctxB = switchActiveWorkspace(memberships, WS_B, false);
    expect(ctxB.workspaceId).toBe(WS_B);
    expect(ctxB.role).toBe('marketer');
    const readB = await pool.query('SELECT external_id FROM profiles WHERE workspace_id=$1 AND external_id IN ($2,$3)', [
      ctxB.workspaceId, 'sw-a', 'sw-b',
    ]);
    expect(readB.rows.map((r: { external_id: string }) => r.external_id)).toEqual(['sw-b']);

    // A non-member cannot switch to a workspace they don't belong to.
    expect(() => switchActiveWorkspace(memberships, WS_REP, false)).toThrow();
  });

  it('§18 Segments: dynamic segments auto-update on events/attributes; manual segments are untouched by the evaluator; both usable as audiences', async () => {
    const SEG_DYN = 'acc18000-0000-4000-8000-0000000000d1'; // "<3 events" dynamic_realtime
    const SEG_MAN = 'acc18000-0000-4000-8000-0000000000d2'; // manual
    await pool.query(
      `INSERT INTO segments (id, workspace_id, name, definition, kind, status)
       VALUES ($1,$2,'dyn-few',$3::jsonb,'dynamic_realtime','active')`,
      [SEG_DYN, WS_A, JSON.stringify({ op: 'and', conditions: [{ field: 'total_events', operator: '<', value: 3 }] })],
    );
    await pool.query("INSERT INTO segments (id, workspace_id, name, kind, status) VALUES ($1,$2,'man-vip','manual','active')", [SEG_MAN, WS_A]);

    // Two profiles: one for the dynamic path, one hand-picked into the manual segment.
    const dynPid = (await pool.query("INSERT INTO profiles (workspace_id, external_id, email) VALUES ($1,'seg-dyn','sd@acc18.example') RETURNING id", [WS_A])).rows[0].id;
    const manPid = (await pool.query("INSERT INTO profiles (workspace_id, external_id, email) VALUES ($1,'seg-man','sm@acc18.example') RETURNING id", [WS_A])).rows[0].id;
    await pool.query('INSERT INTO profile_features (profile_id, workspace_id, total_events) VALUES ($1,$2,1)', [dynPid, WS_A]);
    await pool.query('INSERT INTO profile_features (profile_id, workspace_id, total_events) VALUES ($1,$2,0)', [manPid, WS_A]);

    // Manual segment: membership ONLY via the user edit (addManualMembers).
    await meteringTx(pool, WS_A, [addManualMembers(WS_A, SEG_MAN, [manPid])]);

    // Dynamic segment auto-updates: evaluate the dynamic profile (total=1 < 3 → enters).
    await evaluateRealtimeSegmentsForProfile(evaluateDeps(pool), WS_A, dynPid);
    const audDyn1 = await pool.query(resolveAudience(WS_A, SEG_DYN).text, resolveAudience(WS_A, SEG_DYN).values);
    expect(audDyn1.rows.map((r: { profile_id: string }) => r.profile_id)).toContain(dynPid);

    // The evaluator must NOT touch the manual segment's membership.
    const audManBefore = await pool.query(resolveAudience(WS_A, SEG_MAN).text, resolveAudience(WS_A, SEG_MAN).values);
    await evaluateRealtimeSegmentsForProfile(evaluateDeps(pool), WS_A, manPid); // would not match dyn anyway
    const audManAfter = await pool.query(resolveAudience(WS_A, SEG_MAN).text, resolveAudience(WS_A, SEG_MAN).values);
    expect(audManAfter.rows.map((r: { profile_id: string }) => r.profile_id)).toEqual(
      audManBefore.rows.map((r: { profile_id: string }) => r.profile_id),
    );
    expect(audManAfter.rows.map((r: { profile_id: string }) => r.profile_id)).toContain(manPid);

    // Attribute/event change re-scopes dynamic membership: push total to 3 → exits.
    await pool.query('UPDATE profile_features SET total_events=3 WHERE profile_id=$1 AND workspace_id=$2', [dynPid, WS_A]);
    await evaluateRealtimeSegmentsForProfile(evaluateDeps(pool), WS_A, dynPid);
    const audDyn2 = await pool.query(resolveAudience(WS_A, SEG_DYN).text, resolveAudience(WS_A, SEG_DYN).values);
    expect(audDyn2.rows.map((r: { profile_id: string }) => r.profile_id)).not.toContain(dynPid);

    // BOTH kinds are usable as audiences (resolveAudience returns rows for each).
    expect((await pool.query(resolveAudience(WS_A, SEG_MAN).text, resolveAudience(WS_A, SEG_MAN).values)).rows.length).toBeGreaterThan(0);
  });

  it('§18 Compliance: frequency cap (skip), quiet hours (defer), and one-click unsubscribe (suppress) all hold through the dispatcher core', async () => {
    const ext = 'comp-cust';
    const email = 'comp@acc18.example';
    const pid = (await pool.query("INSERT INTO profiles (workspace_id, external_id, email, email_status) VALUES ($1,$2,$3,'active') RETURNING id", [WS_A, ext, email])).rows[0].id;

    // (1) FREQUENCY CAP: with cap=1/day and a prior send inside the rolling
    // window (relative to the injected dispatch clock), the next send is skipped
    // (SES not called). sent_at must fall within [now-1d, now].
    const capNow = new Date('2026-06-10T15:00:00Z');
    await pool.query("INSERT INTO messages_log (workspace_id, profile_id, ses_message_id, status, sent_at) VALUES ($1,$2,$3,'sent',$4::timestamptz)", [
      WS_A, pid, nextSesId(), new Date(capNow.getTime() - 3_600_000).toISOString(),
    ]);
    const sesCap = new CountingSes();
    const obCap = await enqueueOutbox(pool, WS_A, pid, TPL_A, 'comp-cap', { frequency_cap_per_days: 1 });
    const rCap = await dispatchOutbox(dispatchDeps(pool, sesCap, capNow), obCap);
    expect(rCap.result).toBe('skip');
    expect(sesCap.sends).toHaveLength(0);

    // (2) QUIET HOURS: within a 22:00–06:00 UTC window the send is deferred (SES not called).
    const sesQuiet = new CountingSes();
    const obQuiet = await enqueueOutbox(pool, WS_A, pid, TPL_A, 'comp-quiet', { quiet_hours: { startHour: 22, endHour: 6 } });
    const rQuiet = await dispatchOutbox(dispatchDeps(pool, sesQuiet, new Date('2026-06-11T23:30:00Z')), obQuiet);
    expect(rQuiet.result).toBe('defer');
    expect(sesQuiet.sends).toHaveLength(0);

    // (3) ONE-CLICK UNSUBSCRIBE: the RFC 8058 POST suppresses the recipient in-workspace,
    // and a subsequent dispatch is skipped by the suppression guard (SES not called).
    const link = `${UNSUB_BASE}?workspace_id=${WS_A}&email=${encodeURIComponent(email)}`;
    const parsed = parseUnsubscribeRequest('POST', link, 'List-Unsubscribe=One-Click');
    expect(parsed.valid).toBe(true);
    if (!parsed.valid) throw new Error('unreachable');
    await runUnsubscribeInWorkspaceTx(pool, parsed.workspaceId, [buildUnsubscribeSuppression(parsed.workspaceId, parsed.email, 'one-click')]);
    const sup = await pool.query('SELECT 1 FROM suppressions WHERE workspace_id=$1 AND email=$2', [WS_A, email]);
    expect(sup.rowCount).toBe(1);
    const sesUnsub = new CountingSes();
    const obUnsub = await enqueueOutbox(pool, WS_A, pid, TPL_A, 'comp-unsub', {});
    const rUnsub = await dispatchOutbox(dispatchDeps(pool, sesUnsub, new Date('2026-06-12T12:00:00Z')), obUnsub);
    expect(rUnsub.result).toBe('skip'); // suppressed
    expect(sesUnsub.sends).toHaveLength(0);
  });
});
