# Tests

Cross-cutting test tiers (§16A). Colocated `*.test.ts` next to source is also allowed.

- **Unit** — pure, fast (segment compiler, capping, quiet-hours, cost math).
- **Integration** — against a real local Postgres (Supabase CLI / Testcontainers);
  do NOT mock the DB. Asserts ordering, idempotency, tenant isolation under RLS,
  and service-role workspace scoping.
- **E2E** — thin tier via LocalStack (SQS FIFO → Processor; SES feedback → suppression).

Mock SES and outbound HTTP (`aws-sdk-client-mock`); never send real mail.
