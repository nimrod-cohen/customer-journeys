# DLQ Runbook (§16)

Operational procedure for the CDP's dead-letter queues. The system has two
FIFO main queues, each with its own FIFO DLQ + redrive policy (`maxReceiveCount: 5`):

| Main queue (FIFO)        | Consumer            | DLQ (FIFO)                   |
| ------------------------ | ------------------- | ---------------------------- |
| `cdp-ingest.fifo`        | Processor Lambda    | `cdp-ingest-dlq.fifo`        |
| `cdp-dispatch.fifo`      | Dispatcher Lambda   | `cdp-dispatch-dlq.fifo`      |

A message reaches a DLQ only after the consumer failed to process it 5 times
(partial-batch-failure → no ack → SQS redrive). **No event is ever lost** — it
sits on the DLQ until an operator replays or discards it.

## 1. Detection

Alarms (CloudWatch, defined in `infra/lib/cdp-stack.ts`):

- **`*DlqDepth`** — fires when a DLQ has `ApproximateNumberOfMessagesVisible > 0`.
- **`*Errors`** — per-Lambda error-count alarms (often the upstream cause).
- **`*OldestMessageAge`** — main-queue backlog (oldest message > 5 min).
- **`/health`** — the local-api `/health` endpoint returns **503 degraded**
  when any monitored DLQ has depth > 0 (see `services/local-api/src/health.ts`).

## 2. Triage (read-only first)

1. Confirm which DLQ via the alarm name / `/health` body (`checks[].name = dlq:<q>`).
2. Inspect the messages **without deleting** (long-poll receive, then let the
   visibility timeout return them), or do a **dry run**:

   ```sh
   pnpm --filter @cdp/scripts dlq:replay \
     --dlq   https://sqs.<region>.amazonaws.com/<acct>/cdp-ingest-dlq.fifo \
     --source https://sqs.<region>.amazonaws.com/<acct>/cdp-ingest.fifo \
     --dry-run
   ```

   `--dry-run` **receives and reports** what would be replayed but **sends and
   deletes nothing**.
3. Read the message bodies + CloudWatch logs for the consumer Lambda to find the
   root cause (bad payload? downstream outage? poison message?).

## 3. Fix the root cause BEFORE replaying

Replaying onto the source queue without fixing the cause just re-fills the DLQ.
Typical causes:

- **Transient downstream outage** (DB/SES throttle) — wait for recovery, then replay.
- **Code bug** — deploy the fix first, then replay.
- **Poison message** (genuinely invalid, will never succeed) — do **not** replay;
  capture it for analysis and purge it (see §5).

## 4. Replay

Replays messages from the DLQ back onto the **source FIFO** queue, **preserving
`MessageGroupId` + `MessageDeduplicationId`** so per-profile ordering and
idempotency survive the round-trip. A message is **deleted from the DLQ only
after** its re-send succeeds; a send failure leaves it **intact** and stops the
run.

```sh
pnpm --filter @cdp/scripts dlq:replay \
  --dlq    https://sqs.<region>.amazonaws.com/<acct>/cdp-ingest-dlq.fifo \
  --source https://sqs.<region>.amazonaws.com/<acct>/cdp-ingest.fifo
# optional: --max N   (replay at most N messages, e.g. canary a few first)
```

The tool prints a JSON summary: `{ received, replayed, deleted, dryRun, stoppedOnError? }`.

- Because the source's `MessageDeduplicationId` is preserved, a crash between
  re-send and delete is safe: the redelivered message dedups at the source and
  the consumer's `ON CONFLICT DO NOTHING` (events) / atomic outbox claim
  (dispatch) make re-processing idempotent.
- For local/LocalStack testing set `AWS_ENDPOINT_URL`.

## 5. Discard a poison message

If a message can never succeed, do **not** replay it. Capture the body for a
ticket, then remove it from the DLQ (e.g. `aws sqs delete-message` with its
receipt handle, or purge the DLQ if it contains only poison messages). Document
the decision.

## 6. Verify recovery

1. DLQ depth returns to 0 (`*DlqDepth` alarm clears).
2. `/health` returns **200**.
3. Main-queue `OldestMessageAge` drops; consumer `Errors` stay flat.
4. Spot-check that the replayed work actually landed (e.g. the events/outbox rows
   for the affected `workspace_id` now exist).

## Implementation references

- Replay core + CLI: `scripts/dlq-replay.ts` (`replayDlq(deps)` is pure-injected,
  unit-tested in `scripts/dlq-replay.test.ts` with `aws-sdk-client-mock`).
- Health probe: `services/local-api/src/health.ts` (`buildHealth(deps)`).
- Queue/DLQ/alarm definitions: `infra/lib/cdp-stack.ts`.
