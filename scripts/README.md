# Scripts

- `db-start.sh` — start local Postgres via Supabase CLI + apply migrations (§15).
- `localstack-start.sh` — start LocalStack (SQS/S3/SNS/API GW) (§15).

Planned (later phases): seed multi-workspace data with overlapping `external_id`s/emails
for isolation tests, ordering test harness, DLQ replay.
