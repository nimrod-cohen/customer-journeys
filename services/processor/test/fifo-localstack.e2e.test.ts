import { describe, it, expect } from 'vitest';
import {
  SQSClient,
  CreateQueueCommand,
  SendMessageCommand,
  ReceiveMessageCommand,
  DeleteQueueCommand,
} from '@aws-sdk/client-sqs';
import { buildSqsMessage } from '@cdp/service-ingest';
import { parseProcessorMessage } from '../src/core.js';
import type { EventEnvelope } from '@cdp/shared';

// Thin E2E (§16A tier 3) — verifies the SQS wiring against a REAL FIFO queue on
// LocalStack: ingest's buildSqsMessage round-trips through SQS and the processor's
// parseProcessorMessage reads it back. Catches wiring mistakes, not logic. Skips
// unless LOCALSTACK_URL is set, so it never blocks the unit/integration tiers.
const URL = process.env.LOCALSTACK_URL ?? process.env.AWS_ENDPOINT_URL;
const RUN = Boolean(URL);

const envelope: EventEnvelope = {
  event_id: '00000000-0000-0000-0000-0000000000e2',
  external_id: 'e2e-cust',
  type: 'progress',
  occurred_at: '2026-06-06T00:00:00.000Z',
  attributes: {},
};

describe.skipIf(!RUN)('FIFO ingest→SQS→processor wiring (E2E, LocalStack)', () => {
  it('a message sent with FIFO attrs is received and parses into a ProcessorMessage', async () => {
    const sqs = new SQSClient({
      region: 'us-east-1',
      endpoint: URL,
      credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
    });
    const created = await sqs.send(
      new CreateQueueCommand({
        QueueName: `cdp-e2e-${Date.now()}.fifo`,
        Attributes: { FifoQueue: 'true', ContentBasedDeduplication: 'false' },
      }),
    );
    const queueUrl = created.QueueUrl!;
    try {
      await sqs.send(new SendMessageCommand(buildSqsMessage('ws-e2e', 'profile-e2e', envelope, queueUrl)));
      const recv = await sqs.send(
        new ReceiveMessageCommand({ QueueUrl: queueUrl, WaitTimeSeconds: 5, MaxNumberOfMessages: 1 }),
      );
      const body = recv.Messages?.[0]?.Body;
      expect(body).toBeTruthy();
      const parsed = parseProcessorMessage(body!);
      expect(parsed.workspace_id).toBe('ws-e2e');
      expect(parsed.profile_id).toBe('profile-e2e');
      expect(parsed.envelope.event_id).toBe(envelope.event_id);
    } finally {
      await sqs.send(new DeleteQueueCommand({ QueueUrl: queueUrl }));
    }
  });
});
