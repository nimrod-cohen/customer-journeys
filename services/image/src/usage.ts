// Image usage metering (§11, §20). When the variant Lambda writes processed
// bytes, it records them into usage_counters for per-workspace cost attribution.
// The upsert is ADDITIVE so concurrent/repeated writes accumulate, keyed on
// (workspace_id, period, metric); workspace_id is bound at $1 (in-code scoping —
// the variant Lambda runs as the service role and bypasses RLS). Pure builders.

/** A parameterized statement ready for `pool.query(text, values)`. */
export interface SqlStatement {
  readonly text: string;
  readonly values: unknown[];
}

/** The metric name for image storage bytes (§20). */
export const IMAGE_STORAGE_BYTES = 'image_storage_bytes' as const;

/** First-of-month bucket (UTC, `YYYY-MM-01`) for a usage_counters period. */
export function monthBucket(now: Date): string {
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, '0');
  return `${y}-${m}-01`;
}

/**
 * Build the additive upsert that records image storage bytes for a workspace's
 * month bucket. ON CONFLICT (workspace_id, period, metric) accumulates
 * (value = value + EXCLUDED.value). workspace_id is bound at $1.
 */
export function buildImageBytesUpsert(
  workspaceId: string,
  period: string,
  bytes: number,
): SqlStatement {
  if (!workspaceId) {
    throw new Error('buildImageBytesUpsert: workspaceId is required (tenant-isolation guard)');
  }
  return {
    text: `INSERT INTO usage_counters (workspace_id, period, metric, value)
           VALUES ($1, $2::date, $3, $4)
           ON CONFLICT (workspace_id, period, metric)
           DO UPDATE SET value = usage_counters.value + EXCLUDED.value`,
    values: [workspaceId, period, IMAGE_STORAGE_BYTES, bytes],
  };
}
