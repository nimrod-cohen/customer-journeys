// Metering orchestrators (§20 usage rollups + cost attribution; §10 IP advisor).
// Pure planning + injected I/O, mirroring the batch-eval/dispatcher deps pattern
// (reader + runStatementsInWorkspaceTx + listActiveWorkspaceIds). Each
// workspace's writes run in their OWN workspace-scoped tx so one workspace's
// failure never blocks the rest of the scheduled sweep.
//
// Service role bypasses RLS → every read/write binds workspace_id at $1
// (in-code tenancy guard). SES is injected (mocked in tests). Postgres is real
// in the integration tier.
import type { SesEmailClient, SqlStatement } from '@cdp/email';
import {
  monthBucket,
  buildEmailsSentRollup,
  buildEventsIngestedRollup,
} from './usage.js';
import { planUpgradeIp } from './ip-upgrade.js';
import {
  decideIpRecommendation,
  buildIpRecommendationUpdate,
  type IpThresholds,
  type MonthSeries,
  type IpRecommendation,
} from './advisor.js';
import {
  computeAllWorkspaceCosts,
  type Prices,
  type WorkspaceUsage,
  type AllWorkspaceCosts,
} from './cost.js';

/** A read that returns rows (SELECT). */
export interface QueryFn {
  query(text: string, values: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

/** Run a set of statements inside ONE workspace-scoped transaction. */
export type RunInWorkspaceTx = (
  workspaceId: string,
  statements: readonly SqlStatement[],
) => Promise<void>;

/** Injected dependencies for the metering orchestrators. */
export interface MeteringDeps {
  readonly reader: QueryFn;
  readonly runInWorkspaceTx: RunInWorkspaceTx;
}

// ── usage rollups (§20) ──────────────────────────────────────────────────────

/** Plan the two SET-to-truth rollups for one workspace + period. PURE. */
export function planRollups(workspaceId: string, period: string): SqlStatement[] {
  return [
    buildEmailsSentRollup(workspaceId, period),
    buildEventsIngestedRollup(workspaceId, period),
  ];
}

/**
 * Run the monthly rollups (emails_sent + events_ingested) for one workspace in a
 * single workspace-scoped tx. SET-to-truth → idempotent (re-running reconciles
 * to the authoritative count).
 */
export async function runRollupForWorkspace(
  deps: MeteringDeps,
  workspaceId: string,
  now: Date,
): Promise<void> {
  const period = monthBucket(now);
  await deps.runInWorkspaceTx(workspaceId, planRollups(workspaceId, period));
}

// ── cost view (§20) ──────────────────────────────────────────────────────────

/**
 * Read one workspace's metered usage for `period` (the direct-cost inputs):
 * emails_sent + image bytes from usage_counters, and ipUpgraded from
 * sending_identity.ip_mode. workspace_id bound at $1. PURE statement.
 */
export function buildWorkspaceUsageRead(workspaceId: string, period: string): SqlStatement {
  if (!workspaceId) throw new Error('buildWorkspaceUsageRead: workspaceId is required');
  return {
    text: `SELECT
              w.id AS workspace_id,
              COALESCE((SELECT value FROM usage_counters
                         WHERE workspace_id = $1 AND period = $2::date AND metric = 'emails_sent'), 0) AS emails_sent,
              COALESCE((SELECT value FROM usage_counters
                         WHERE workspace_id = $1 AND period = $2::date AND metric = 'image_storage_bytes'), 0) AS image_storage_bytes,
              COALESCE((SELECT value FROM usage_counters
                         WHERE workspace_id = $1 AND period = $2::date AND metric = 'image_egress_bytes'), 0) AS image_egress_bytes,
              COALESCE(w.sending_identity ->> 'ip_mode', 'shared') AS ip_mode
            FROM workspaces w
           WHERE w.id = $1`,
    values: [workspaceId, period],
  };
}

/** Map a usage row → the cost-input shape. PURE. */
export function usageRowToWorkspaceUsage(row: Record<string, unknown>): WorkspaceUsage {
  const ipMode = String(row.ip_mode ?? 'shared');
  return {
    workspaceId: String(row.workspace_id),
    emails_sent: Number(row.emails_sent ?? 0),
    ipUpgraded: ipMode === 'dedicated' || ipMode === 'warming',
    imageStorageBytes: Number(row.image_storage_bytes ?? 0),
    imageEgressBytes: Number(row.image_egress_bytes ?? 0),
  };
}

/**
 * Compute the full cost view for `period` across the given ACTIVE workspaces.
 * Reads each workspace's usage, then applies the §20 hybrid model. The SAME
 * active set is both the even-split denominator and the iterated rows, so the
 * sum-to-total invariant holds.
 */
export async function computeCostViewForWorkspaces(
  deps: MeteringDeps,
  workspaceIds: readonly string[],
  period: string,
  fixedTotal: number,
  prices: Prices,
): Promise<AllWorkspaceCosts> {
  const usages: WorkspaceUsage[] = [];
  for (const ws of workspaceIds) {
    const q = buildWorkspaceUsageRead(ws, period);
    const { rows } = await deps.reader.query(q.text, q.values);
    if (rows[0]) usages.push(usageRowToWorkspaceUsage(rows[0]));
  }
  return computeAllWorkspaceCosts(usages, fixedTotal, prices);
}

// ── IP advisor (§10) ─────────────────────────────────────────────────────────

/**
 * Read the trailing `months` of a workspace's sending series for the advisor:
 * volume from usage_counters (emails_sent), cadence (distinct send-days) from
 * messages_log, and reputation (bounce/complaint counts) from email_events —
 * all per month, workspace_id bound at $1. Ordered oldest → newest. PURE.
 */
export function buildAdvisorSeriesRead(
  workspaceId: string,
  asOf: Date,
  months: number,
): SqlStatement {
  if (!workspaceId) throw new Error('buildAdvisorSeriesRead: workspaceId is required');
  const asOfMonth = monthBucket(asOf);
  return {
    text: `WITH months AS (
             SELECT generate_series(
                      date_trunc('month', $2::date) - make_interval(months => $3::int - 1),
                      date_trunc('month', $2::date),
                      interval '1 month'
                    )::date AS period
           )
           SELECT
             m.period,
             COALESCE((SELECT value FROM usage_counters uc
                        WHERE uc.workspace_id = $1 AND uc.period = m.period AND uc.metric = 'emails_sent'), 0) AS emails_sent,
             COALESCE((SELECT count(DISTINCT date_trunc('day', ml.sent_at)) FROM messages_log ml
                        WHERE ml.workspace_id = $1 AND ml.status = 'sent'
                          AND date_trunc('month', ml.sent_at) = m.period), 0) AS active_days,
             EXTRACT(DAY FROM (m.period + interval '1 month' - interval '1 day'))::int AS days_in_month,
             COALESCE((SELECT count(*) FROM email_events ee
                        WHERE ee.workspace_id = $1 AND ee.type = 'bounce'
                          AND date_trunc('month', ee.occurred_at) = m.period), 0) AS bounces,
             COALESCE((SELECT count(*) FROM email_events ee
                        WHERE ee.workspace_id = $1 AND ee.type = 'complaint'
                          AND date_trunc('month', ee.occurred_at) = m.period), 0) AS complaints,
             COALESCE((SELECT count(*) FROM email_events ee
                        WHERE ee.workspace_id = $1 AND ee.type = 'delivery'
                          AND date_trunc('month', ee.occurred_at) = m.period), 0) AS delivered
           FROM months m
           ORDER BY m.period ASC`,
    values: [workspaceId, asOfMonth, months],
  };
}

/** Map an advisor-series row → MonthSeries. PURE. */
export function rowToMonthSeries(row: Record<string, unknown>): MonthSeries {
  const period = row.period instanceof Date ? monthBucket(row.period) : String(row.period).slice(0, 10);
  return {
    period,
    emailsSent: Number(row.emails_sent ?? 0),
    activeDays: Number(row.active_days ?? 0),
    daysInMonth: Number(row.days_in_month ?? 30),
    bounces: Number(row.bounces ?? 0),
    complaints: Number(row.complaints ?? 0),
    delivered: Number(row.delivered ?? 0),
  };
}

/**
 * Evaluate one workspace and PERSIST its recommendation (never upgrades). Reads
 * the trailing series, decides via the all-criteria-AND gate, then writes
 * ip_recommendation into sending_identity in a workspace-scoped tx. Returns the
 * verdict for logging/tests.
 */
export async function runAdvisorForWorkspace(
  deps: MeteringDeps,
  workspaceId: string,
  asOf: Date,
  thresholds: IpThresholds,
): Promise<IpRecommendation> {
  const q = buildAdvisorSeriesRead(workspaceId, asOf, thresholds.consecutiveMonths);
  const { rows } = await deps.reader.query(q.text, q.values);
  const series = rows.map(rowToMonthSeries);
  const recommendation = decideIpRecommendation(series, thresholds);
  await deps.runInWorkspaceTx(workspaceId, [
    buildIpRecommendationUpdate(workspaceId, recommendation),
  ]);
  return recommendation;
}

// ── owner-triggered IP upgrade orchestration (§10) ───────────────────────────

/**
 * Orchestrate an owner-triggered dedicated-IP upgrade (§10): provision the SES
 * dedicated IP pool FIRST, and only on success write the ip_mode transition
 * (shared → warming) in a workspace-scoped tx. If SES provisioning throws, the
 * error propagates and NO DB write happens, so the workspace stays on the shared
 * pool (ip_mode unchanged). Never automatic — invoked by the owner via the API.
 */
export async function upgradeIp(
  deps: MeteringDeps,
  ses: SesEmailClient,
  workspaceId: string,
  poolName: string,
  now: Date,
): Promise<void> {
  if (!workspaceId) throw new Error('upgradeIp: workspaceId is required');
  // SES FIRST — if this throws, we never touch the DB (ip_mode stays shared).
  await ses.provisionDedicatedIp(poolName);
  await deps.runInWorkspaceTx(workspaceId, [planUpgradeIp(workspaceId, poolName, now)]);
}
