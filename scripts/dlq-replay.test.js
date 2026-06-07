// Unit tests for replayDlq (§16). aws-sdk-client-mock fakes SQS — no real AWS.
// Proves: receive→re-send (group/dedup preserved)→delete-after-success;
// dry-run sends/deletes nothing; a send failure leaves the message INTACT.
import { describe, it, expect, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { SQSClient, ReceiveMessageCommand, SendMessageCommand, DeleteMessageCommand, } from '@aws-sdk/client-sqs';
import { replayDlq } from './dlq-replay.js';
const DLQ = 'https://sqs.local/cdp-ingest-dlq.fifo';
const SRC = 'https://sqs.local/cdp-ingest.fifo';
const sqsMock = mockClient(SQSClient);
function msg(id, body, group, dedup) {
    return {
        MessageId: id,
        ReceiptHandle: `rh-${id}`,
        Body: body,
        Attributes: { MessageGroupId: group, MessageDeduplicationId: dedup },
    };
}
beforeEach(() => {
    sqsMock.reset();
});
describe('replayDlq', () => {
    it('receives → re-sends to source (preserving group + dedup) → deletes after success', async () => {
        sqsMock
            .on(ReceiveMessageCommand)
            .resolvesOnce({ Messages: [msg('a', '{"profile_id":"p1"}', 'p1', 'd1'), msg('b', '{}', 'p2', 'd2')] })
            .resolves({ Messages: [] }); // drained
        sqsMock.on(SendMessageCommand).resolves({ MessageId: 'new' });
        sqsMock.on(DeleteMessageCommand).resolves({});
        const r = await replayDlq({ sqs: new SQSClient({}), dlqUrl: DLQ, sourceUrl: SRC });
        expect(r).toMatchObject({ received: 2, replayed: 2, deleted: 2, dryRun: false });
        expect(r.stoppedOnError).toBeUndefined();
        const sends = sqsMock.commandCalls(SendMessageCommand);
        expect(sends).toHaveLength(2);
        expect(sends[0].args[0].input).toMatchObject({
            QueueUrl: SRC,
            MessageGroupId: 'p1',
            MessageDeduplicationId: 'd1',
        });
        // Delete targets the DLQ with the receipt handle, AFTER the send.
        const dels = sqsMock.commandCalls(DeleteMessageCommand);
        expect(dels).toHaveLength(2);
        expect(dels[0].args[0].input).toMatchObject({ QueueUrl: DLQ, ReceiptHandle: 'rh-a' });
    });
    it('dry-run receives + reports but sends NOTHING and deletes NOTHING', async () => {
        sqsMock
            .on(ReceiveMessageCommand)
            .resolvesOnce({ Messages: [msg('a', '{}', 'p1', 'd1')] })
            .resolves({ Messages: [] });
        const r = await replayDlq({ sqs: new SQSClient({}), dlqUrl: DLQ, sourceUrl: SRC, dryRun: true });
        expect(r).toMatchObject({ received: 1, replayed: 0, deleted: 0, dryRun: true });
        expect(sqsMock.commandCalls(SendMessageCommand)).toHaveLength(0);
        expect(sqsMock.commandCalls(DeleteMessageCommand)).toHaveLength(0);
    });
    it('a send failure leaves the message INTACT on the DLQ (no delete) and stops the run', async () => {
        sqsMock.on(ReceiveMessageCommand).resolves({ Messages: [msg('a', '{}', 'p1', 'd1')] });
        sqsMock.on(SendMessageCommand).rejects(new Error('source throttled'));
        const r = await replayDlq({ sqs: new SQSClient({}), dlqUrl: DLQ, sourceUrl: SRC });
        expect(r.replayed).toBe(0);
        expect(r.deleted).toBe(0);
        expect(r.stoppedOnError).toBe('source throttled');
        // The message is NOT deleted from the DLQ — no data loss.
        expect(sqsMock.commandCalls(DeleteMessageCommand)).toHaveLength(0);
    });
    it('honors maxMessages (stops after N) and stops when the DLQ is empty', async () => {
        sqsMock
            .on(ReceiveMessageCommand)
            .resolvesOnce({ Messages: [msg('a', '{}', 'p1', 'd1'), msg('b', '{}', 'p2', 'd2')] });
        sqsMock.on(SendMessageCommand).resolves({});
        sqsMock.on(DeleteMessageCommand).resolves({});
        const r = await replayDlq({ sqs: new SQSClient({}), dlqUrl: DLQ, sourceUrl: SRC, maxMessages: 1 });
        expect(r.received).toBe(1);
        expect(r.replayed).toBe(1);
    });
});
//# sourceMappingURL=dlq-replay.test.js.map