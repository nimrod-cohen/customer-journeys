// DLQ replay tool (§16 "DLQ runbook", §19 /scripts). Drains a FIFO DLQ back onto
// its source FIFO queue, preserving the FIFO ordering keys.
//
// The core `replayDlq(deps)` is PURE-ish (all I/O injected) so it is unit-tested
// with aws-sdk-client-mock — no real AWS. The CLI at the bottom wires the real
// SQS client. Safety properties (the runbook depends on these):
//   - RECEIVE from the DLQ → re-SEND to the SOURCE FIFO preserving
//     MessageGroupId + MessageDeduplicationId (so per-profile ordering and
//     dedupe survive the round-trip) → DELETE from the DLQ ONLY after the send
//     succeeds. A send failure leaves the message INTACT on the DLQ (no data
//     loss) and stops the run (so an operator can investigate).
//   - `dryRun` receives + reports what WOULD be replayed but sends/deletes
//     nothing.
import { SQSClient, ReceiveMessageCommand, SendMessageCommand, DeleteMessageCommand, } from '@aws-sdk/client-sqs';
/**
 * Replay messages from a FIFO DLQ back to its source FIFO queue, preserving
 * MessageGroupId + MessageDeduplicationId, deleting from the DLQ only after a
 * successful re-send. Returns counts; never throws on a per-message send failure
 * (it stops and reports, leaving the offending message intact on the DLQ).
 */
export async function replayDlq(deps) {
    const dryRun = deps.dryRun ?? false;
    const batchSize = Math.min(Math.max(deps.batchSize ?? 10, 1), 10);
    const limit = deps.maxMessages ?? Infinity;
    let received = 0;
    let replayed = 0;
    let deleted = 0;
    while (received < limit) {
        const want = Math.min(batchSize, limit - received);
        const recv = (await deps.sqs.send(new ReceiveMessageCommand({
            QueueUrl: deps.dlqUrl,
            MaxNumberOfMessages: want,
            WaitTimeSeconds: 1,
            // FIFO DLQs carry the group/dedup attributes — fetch them.
            MessageAttributeNames: ['All'],
            AttributeNames: ['All'],
        })));
        const messages = recv.Messages ?? [];
        if (messages.length === 0)
            break; // DLQ drained
        for (const m of messages) {
            if (received >= limit)
                break; // defensive: never exceed the cap mid-batch
            received += 1;
            if (dryRun)
                continue; // report-only: do not send or delete
            const groupId = m.Attributes?.['MessageGroupId'] ?? deriveGroupId(m.Body);
            const dedupId = m.Attributes?.['MessageDeduplicationId'] ?? m.MessageId ?? undefined;
            try {
                await deps.sqs.send(new SendMessageCommand({
                    QueueUrl: deps.sourceUrl,
                    MessageBody: m.Body ?? '',
                    ...(groupId ? { MessageGroupId: groupId } : {}),
                    ...(dedupId ? { MessageDeduplicationId: dedupId } : {}),
                    ...(m.MessageAttributes ? { MessageAttributes: m.MessageAttributes } : {}),
                }));
                replayed += 1;
            }
            catch (err) {
                // Leave the message INTACT on the DLQ (no delete) and stop the run.
                return {
                    received,
                    replayed,
                    deleted,
                    dryRun,
                    stoppedOnError: err.message,
                };
            }
            // DELETE only after a successful re-send (at-least-once → the dedup id
            // protects the source from a double-apply if we crash before delete).
            await deps.sqs.send(new DeleteMessageCommand({
                QueueUrl: deps.dlqUrl,
                ReceiptHandle: m.ReceiptHandle ?? '',
            }));
            deleted += 1;
        }
    }
    return { received, replayed, deleted, dryRun };
}
/**
 * Best-effort MessageGroupId when the DLQ message lost its attribute: the
 * processor FIFO uses MessageGroupId = profile_id, which travels in the body.
 * Fall back to a single group so ordering is at least preserved as a stream.
 */
function deriveGroupId(body) {
    if (body) {
        try {
            const parsed = JSON.parse(body);
            if (typeof parsed.profile_id === 'string' && parsed.profile_id)
                return parsed.profile_id;
        }
        catch {
            /* not JSON — fall through */
        }
    }
    return 'dlq-replay';
}
// ── Thin CLI ──────────────────────────────────────────────────────────────────
// Usage:
//   node --import tsx/esm dlq-replay.ts --dlq <url> --source <url> [--dry-run] [--max N]
function parseArgs(argv) {
    const out = { dryRun: false };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--dlq') {
            const v = argv[++i];
            if (v !== undefined)
                out.dlq = v;
        }
        else if (a === '--source') {
            const v = argv[++i];
            if (v !== undefined)
                out.source = v;
        }
        else if (a === '--dry-run') {
            out.dryRun = true;
        }
        else if (a === '--max') {
            out.max = Number(argv[++i]);
        }
    }
    return out;
}
async function main() {
    const args = parseArgs(process.argv.slice(2));
    if (!args.dlq || !args.source) {
        // eslint-disable-next-line no-console
        console.error('usage: dlq-replay --dlq <url> --source <url> [--dry-run] [--max N]');
        process.exit(2);
    }
    const sqs = new SQSClient({ ...(process.env.AWS_ENDPOINT_URL ? { endpoint: process.env.AWS_ENDPOINT_URL } : {}) });
    const result = await replayDlq({
        sqs,
        dlqUrl: args.dlq,
        sourceUrl: args.source,
        dryRun: args.dryRun,
        ...(args.max !== undefined ? { maxMessages: args.max } : {}),
    });
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(result, null, 2));
}
// Only run the CLI when executed directly (not when imported by the test).
if (typeof process !== 'undefined' &&
    process.argv[1] &&
    import.meta.url === `file://${process.argv[1]}`) {
    main().catch((err) => {
        // eslint-disable-next-line no-console
        console.error('[dlq-replay] failed', err);
        process.exit(1);
    });
}
//# sourceMappingURL=dlq-replay.js.map