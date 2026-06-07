// §10 dedicated-IP recommendation engine — PURE decision logic + a persist
// builder (§16A). A scheduled IP-advisor job (EventBridge, monthly) evaluates
// each workspace from existing data and flags a recommendation in the UI.
//
// CRITICAL: the advisor only RECOMMENDS. It NEVER auto-upgrades. The owner
// triggers the migration. `decideIpRecommendation` is a strict ALL-criteria-AND
// gate; `buildIpRecommendationUpdate` persists `ip_recommendation` into
// sending_identity WITHOUT touching ip_mode.
import type { SqlStatement } from '@cdp/email';

/** One month of a workspace's sending series (the advisor's inputs, §10). */
export interface MonthSeries {
  /** The month bucket (YYYY-MM-01). */
  readonly period: string;
  /** Total emails sent that month (from usage_counters / messages_log). */
  readonly emailsSent: number;
  /** Distinct days the workspace sent on (cadence signal, from messages_log). */
  readonly activeDays: number;
  /** Days in the month (cadence denominator). */
  readonly daysInMonth: number;
  /** Hard+soft bounces that month (reputation, from email_events). */
  readonly bounces: number;
  /** Complaints that month (reputation, from email_events). */
  readonly complaints: number;
  /** Delivered / total volume baseline for the reputation rates. */
  readonly delivered: number;
}

/** Tunable thresholds for the recommendation gate (§10, §22 item 2). */
export interface IpThresholds {
  /** Minimum sustained monthly volume (≈100k). */
  readonly minMonthlyVolume: number;
  /** How many consecutive recent months must clear the volume bar (2–3). */
  readonly consecutiveMonths: number;
  /** Minimum fraction of days with a send (cadence: "most days"). */
  readonly minActiveDayFraction: number;
  /** Max bounce rate (bounces / volume) to be "healthy". */
  readonly maxBounceRate: number;
  /** Max complaint rate (complaints / volume) to be "healthy". */
  readonly maxComplaintRate: number;
}

/** Defaults per §10 (≥~100k/mo, 2–3 months, cadence, reputation ceiling). */
export const DEFAULT_IP_THRESHOLDS: IpThresholds = {
  minMonthlyVolume: 100_000,
  consecutiveMonths: 3,
  minActiveDayFraction: 0.5, // sends on most days, not a single monthly blast
  maxBounceRate: 0.03, // SES warns ≥3%
  maxComplaintRate: 0.001, // SES warns ≥0.1%
};

/** The advisor's verdict: recommend (or not) + human-readable rationale. */
export interface IpRecommendation {
  readonly recommend: boolean;
  readonly reasons: string[];
}

function ratePerVolume(n: number, volume: number): number {
  return volume > 0 ? n / volume : 0;
}

/**
 * Decide whether to recommend a dedicated IP for a workspace (§10). Strict
 * all-criteria-AND gate over the MOST RECENT `consecutiveMonths` months:
 *   1. sustained volume — every recent month ≥ minMonthlyVolume (spikes rejected),
 *   2. consistent cadence — every recent month sends on ≥ minActiveDayFraction
 *      of its days (a single monthly blast is rejected),
 *   3. healthy reputation — every recent month's bounce/complaint rate is below
 *      the ceiling.
 * Pure. Never mutates input; never upgrades.
 */
export function decideIpRecommendation(
  series: readonly MonthSeries[],
  thresholds: IpThresholds,
): IpRecommendation {
  const reasons: string[] = [];

  if (series.length < thresholds.consecutiveMonths) {
    reasons.push(
      `insufficient history: need ${thresholds.consecutiveMonths} consecutive months, have ${series.length}`,
    );
    return { recommend: false, reasons };
  }

  // The most recent N months, in chronological order, are the window we judge.
  const recent = series.slice(-thresholds.consecutiveMonths);

  const sustained = recent.every((m) => m.emailsSent >= thresholds.minMonthlyVolume);
  if (!sustained) {
    reasons.push(
      `not sustained: ${thresholds.consecutiveMonths} consecutive months ≥ ${thresholds.minMonthlyVolume} required (one-off spikes don't count)`,
    );
  } else {
    reasons.push(`sustained volume ≥ ${thresholds.minMonthlyVolume}/mo for ${recent.length} months`);
  }

  const goodCadence = recent.every(
    (m) => m.daysInMonth > 0 && m.activeDays / m.daysInMonth >= thresholds.minActiveDayFraction,
  );
  if (!goodCadence) {
    reasons.push('inconsistent cadence: not sending on most days (a dedicated IP needs regular traffic)');
  } else {
    reasons.push('consistent cadence: sending on most days');
  }

  const healthy = recent.every(
    (m) =>
      ratePerVolume(m.bounces, m.emailsSent) <= thresholds.maxBounceRate &&
      ratePerVolume(m.complaints, m.emailsSent) <= thresholds.maxComplaintRate,
  );
  if (!healthy) {
    reasons.push('unhealthy reputation: bounce/complaint rate above the ceiling (don\'t move a problematic sender)');
  } else {
    reasons.push('healthy reputation: low bounce/complaint');
  }

  return { recommend: sustained && goodCadence && healthy, reasons };
}

/**
 * Build the statement that PERSISTS the recommendation into
 * `workspaces.sending_identity.ip_recommendation` (§10) — merging the jsonb so
 * other keys (ip_mode, dkim, etc.) are preserved. It explicitly does NOT change
 * ip_mode: recommending is not upgrading. workspace_id bound at $1.
 */
export function buildIpRecommendationUpdate(
  workspaceId: string,
  recommendation: IpRecommendation,
): SqlStatement {
  if (!workspaceId) throw new Error('buildIpRecommendationUpdate: workspaceId is required');
  const payload = JSON.stringify({
    recommend: recommendation.recommend,
    reasons: recommendation.reasons,
    decided_at: new Date().toISOString(),
  });
  return {
    text: `UPDATE workspaces
              SET sending_identity =
                    sending_identity || jsonb_build_object('ip_recommendation', $2::jsonb)
            WHERE id = $1`,
    values: [workspaceId, payload],
  };
}
