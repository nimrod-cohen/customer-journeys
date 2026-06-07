// §20 usage rollups — pure SQL-statement builders (§16A). A scheduled metering
// job runs these monthly, per workspace, to keep usage_counters authoritative.
//
// RECONCILIATION (CLAUDE.md / §18): emails_sent is ALREADY incremented per-send
// by the Dispatcher. The rollup does NOT add to that — it DERIVES the true
// monthly total straight from messages_log and writes it SET-to-truth
// (ON CONFLICT DO UPDATE SET value = EXCLUDED.value). Re-running is therefore
// idempotent and always equals the real count, healing any drift from
// double-counted or missed per-send increments.
//
// Service role bypasses RLS → workspace_id is bound at $1 in every statement
// (in-code tenancy guard). The period is the UTC first-of-month bucket.
import type { SqlStatement } from '@cdp/email';

/** The UTC first-of-month bucket (YYYY-MM-01) for a date — the usage period. */
export function monthBucket(when: Date): string {
  const y = when.getUTCFullYear();
  const m = String(when.getUTCMonth() + 1).padStart(2, '0');
  return `${y}-${m}-01`;
}

/** Alias: the usage `period` (a month bucket) for a given date. */
export function periodForDate(when: Date): string {
  return monthBucket(when);
}

/**
 * Build the emails_sent rollup for one workspace + period (§20). Counts the
 * `sent` rows in messages_log whose sent_at falls in the period's month and
 * upserts the total SET-to-truth (NOT additive) so re-runs are idempotent and
 * reconcile to the authoritative count. workspace_id bound at $1.
 */
export function buildEmailsSentRollup(workspaceId: string, period: string): SqlStatement {
  if (!workspaceId) throw new Error('buildEmailsSentRollup: workspaceId is required');
  return {
    text: `INSERT INTO usage_counters (workspace_id, period, metric, value)
           SELECT $1::uuid, $2::date, $3,
                  (SELECT count(*) FROM messages_log
                    WHERE workspace_id = $1
                      AND status = 'sent'
                      AND date_trunc('month', sent_at) = $2::date)
           ON CONFLICT (workspace_id, period, metric)
           DO UPDATE SET value = EXCLUDED.value`,
    values: [workspaceId, period, 'emails_sent'],
  };
}

/**
 * Build the events_ingested rollup for one workspace + period (§20). Counts the
 * rows in `events` whose received_at falls in the period's month and upserts the
 * total SET-to-truth. workspace_id bound at $1.
 */
export function buildEventsIngestedRollup(workspaceId: string, period: string): SqlStatement {
  if (!workspaceId) throw new Error('buildEventsIngestedRollup: workspaceId is required');
  return {
    text: `INSERT INTO usage_counters (workspace_id, period, metric, value)
           SELECT $1::uuid, $2::date, $3,
                  (SELECT count(*) FROM events
                    WHERE workspace_id = $1
                      AND date_trunc('month', received_at) = $2::date)
           ON CONFLICT (workspace_id, period, metric)
           DO UPDATE SET value = EXCLUDED.value`,
    values: [workspaceId, period, 'events_ingested'],
  };
}
