-- Webhook action AT-MOST-ONCE dedupe marker (§9B, campaign webhook).
--
-- A campaign webhook action fires its outbound HTTP call AFTER the row-lock tx
-- commits (mirroring enqueueSends — an external call must never hold the FOR
-- UPDATE enrollment lock). The single-winner lock already guarantees only one
-- tick advances past the webhook node, but a crash-recovery re-sweep that somehow
-- re-reaches the node must NOT double-fire. We record the webhook OUTCOME as an
-- append-only activity_log row (source='webhook') keyed by a stable per-
-- (campaign,profile,node) dedupe key stored in `dedupe_key`; a PARTIAL UNIQUE
-- index on (workspace_id, dedupe_key) WHERE source='webhook' makes the marker
-- insert idempotent (ON CONFLICT DO NOTHING) so the webhook is fired exactly
-- once across retries/recovery. The column is nullable + the index partial so it
-- does not constrain the existing unsubscribe/profile activity rows.
ALTER TABLE activity_log ADD COLUMN IF NOT EXISTS dedupe_key text;

CREATE UNIQUE INDEX IF NOT EXISTS activity_log_webhook_dedupe_idx
  ON activity_log (workspace_id, dedupe_key)
  WHERE source = 'webhook' AND dedupe_key IS NOT NULL;
