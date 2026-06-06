// Feedback Lambda — thin SNS handler (§10). One SNS record = one SES feedback
// notification. Per record: parse Records[].Sns.Message (JSON), hand it to the
// orchestrator, and map the result to ack vs. batch item failure.
//
// Retry policy: an UNRESOLVED workspace, a malformed message, or any thrown
// error → batch item failure (SNS/SQS redrives → eventually DLQ). We NEVER drop
// an unresolved event and NEVER guess a workspace. The handler NEVER throws —
// every record is wrapped in try/catch so one bad record can't fail the batch.
import { handleNotification, type FeedbackDeps } from './feedback.js';
import type { SesNotification } from './core.js';

/** A single SNS record (the bits we use). */
export interface SnsRecord {
  readonly Sns: {
    readonly MessageId: string;
    readonly Message: string;
  };
}

export interface SnsEvent {
  readonly Records: readonly SnsRecord[];
}

/** SQS/SNS partial-batch-failure response shape. */
export interface BatchResponse {
  readonly batchItemFailures: readonly { itemIdentifier: string }[];
}

/** Build the feedback handler from its injected dependencies. */
export function makeFeedbackHandler(deps: FeedbackDeps) {
  return async function handler(event: SnsEvent): Promise<BatchResponse> {
    const failures: { itemIdentifier: string }[] = [];
    for (const record of event.Records) {
      const id = record.Sns?.MessageId;
      try {
        let notification: SesNotification;
        try {
          const parsed = JSON.parse(record.Sns.Message) as unknown;
          if (typeof parsed !== 'object' || parsed === null) {
            // A primitive payload carries no sender-side signal → unresolvable.
            failures.push({ itemIdentifier: id });
            continue;
          }
          notification = parsed as SesNotification;
        } catch {
          failures.push({ itemIdentifier: id });
          continue;
        }
        const result = await handleNotification(deps, notification);
        if (result.status === 'unresolved') {
          // Do NOT drop — report so it redrives (→ DLQ), never guess a workspace.
          failures.push({ itemIdentifier: id });
        }
        // 'ok'/'noop' ack (the writes already reflect the outcome).
      } catch {
        // Defensive: never throw out of the handler. Treat as retryable.
        failures.push({ itemIdentifier: id });
      }
    }
    return { batchItemFailures: failures };
  };
}
