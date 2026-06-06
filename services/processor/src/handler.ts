// Processor Lambda (SQS FIFO consumer) — idempotent, ALWAYS workspace-scoped.
// Inserts events (ON CONFLICT DO NOTHING), upserts profile + features, re-evaluates
// the workspace's active segments, diffs memberships, appends segment_change_log. (§7)
//
// Scaffolding only: thin handler shell. Pure logic implemented test-first in §3–§5.
export {};
