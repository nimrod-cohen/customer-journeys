// §10 dedicated-IP upgrade — PURE state transition, warm-up ramp, and send-pool
// routing (§16A). The owner triggers the upgrade; the orchestrator provisions
// SES first (deps.ts/core.ts) then writes this DB transition. Migration is a
// gradual warm-up (~2–4 weeks): an increasing share of sends route to the new
// dedicated IP while the rest stay on the shared pool, until fully cut over.
import type { SqlStatement } from '@cdp/email';

/** ip_mode lifecycle stored in sending_identity.ip_mode (§10A). */
export type IpMode = 'shared' | 'warming' | 'dedicated';

/** Warm-up tracking persisted in sending_identity.warmup_status (§10). */
export interface WarmupStatus {
  /** ISO timestamp the warm-up began. */
  readonly startedAt: string;
  /** Length of the warm-up window in days (~14–28). */
  readonly durationDays: number;
}

/** Which pool a single send is routed to during/after warm-up. */
export type SendPool = 'shared' | 'dedicated';

/** Default warm-up window length (3 weeks, within the §10 2–4 week range). */
export const DEFAULT_WARMUP_DAYS = 21;

/**
 * Plan the DB transition for an IP upgrade: ip_mode 'shared' → 'warming', set
 * the ip_pool name and a fresh warmup_status, MERGED into the existing
 * sending_identity jsonb (so DKIM/config_set/etc. are preserved). The merge is
 * `sending_identity || $2::jsonb` and the workspace is bound at $1. Stays in
 * 'warming' until the ramp completes and the orchestrator flips it to
 * 'dedicated'. PURE.
 */
export function planUpgradeIp(
  workspaceId: string,
  poolName: string,
  now: Date,
  durationDays: number = DEFAULT_WARMUP_DAYS,
): SqlStatement {
  if (!workspaceId) throw new Error('planUpgradeIp: workspaceId is required');
  const patch = JSON.stringify({
    ip_mode: 'warming' as IpMode,
    ip_pool: poolName,
    dedicated_ip: poolName,
    warmup_status: { startedAt: now.toISOString(), durationDays } satisfies WarmupStatus,
  });
  return {
    text: `UPDATE workspaces
              SET sending_identity = sending_identity || $2::jsonb
            WHERE id = $1`,
    values: [workspaceId, patch],
  };
}

/**
 * Plan the final cut-over: ip_mode 'warming' → 'dedicated', warm-up complete.
 * Merged into sending_identity; workspace bound at $1. PURE.
 */
export function planCompleteUpgrade(workspaceId: string): SqlStatement {
  if (!workspaceId) throw new Error('planCompleteUpgrade: workspaceId is required');
  const patch = JSON.stringify({ ip_mode: 'dedicated' as IpMode });
  return {
    text: `UPDATE workspaces
              SET sending_identity = sending_identity || $2::jsonb
            WHERE id = $1`,
    values: [workspaceId, patch],
  };
}

/**
 * The fraction of this workspace's sends that should route to the dedicated IP
 * at `now`, given its warm-up status (§10). A monotonic linear ramp from a small
 * positive initial share at start to exactly 1.0 once the window completes;
 * clamped to [initial, 1]. PURE.
 */
export function warmupSplit(status: WarmupStatus, now: Date): number {
  const started = Date.parse(status.startedAt);
  const totalMs = Math.max(1, status.durationDays) * 86_400_000;
  const elapsed = now.getTime() - started;
  // Begin routing a small but non-trivial share immediately so the IP gets
  // traffic from day one; ramp linearly to 1.0.
  const initial = 0.05;
  if (elapsed <= 0) return initial;
  if (elapsed >= totalMs) return 1;
  const linear = initial + (1 - initial) * (elapsed / totalMs);
  return Math.min(1, Math.max(initial, linear));
}

/**
 * Stable 32-bit FNV-1a hash of a string → [0, 1). Deterministic so a given
 * profile_id always maps to the same bucket (retry-safe routing).
 */
function hashToUnitInterval(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  // >>> 0 makes it unsigned; divide by 2^32.
  return (h >>> 0) / 0x100000000;
}

/**
 * Choose which pool a send routes to, DETERMINISTICALLY by profile_id, so a
 * retry of the same message always picks the SAME pool (§10 split routing). A
 * profile whose stable hash is below `dedicatedShare` goes to the dedicated IP;
 * the rest stay on the shared pool. PURE.
 */
export function chooseSendPool(dedicatedShare: number, profileId: string): SendPool {
  if (dedicatedShare <= 0) return 'shared';
  if (dedicatedShare >= 1) return 'dedicated';
  return hashToUnitInterval(profileId) < dedicatedShare ? 'dedicated' : 'shared';
}
