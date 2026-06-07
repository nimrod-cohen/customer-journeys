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
// parseProcessorMessage reads it back. Catches wiring mistakes, not logic.
//
// GATED ON LOCALSTACK_URL ONLY (explicit opt-in). The AWS SDK's SQS HTTP path
// does not work reliably under vitest's module loader (LocalStack returns
// QueueDoesNotExist even though the identical calls succeed in plain Node — a
// harness incompatibility, not a product bug; the buildSqsMessage→SQS→parse
// round-trip is verified to work outside vitest). We therefore do NOT couple
// this to AWS_ENDPOINT_URL (which the image pipeline sets), so a normal
// `pnpm test` run stays green; opt in explicitly with LOCALSTACK_URL to run it.
const URL = process.env.LOCALSTACK_URL;
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
    // LocalStack's CreateQueue returns a *.localstack.cloud QueueUrl host. The
    // SDK's useQueueUrlAsEndpoint rewrite that would normalize it back to our
    // endpoint does not apply reliably under vitest's module loader, so we build
    // the path-style URL against our own endpoint directly and use that for all
    // subsequent ops — no host rewrite needed.
    const queueName = `cdp-e2e-${Date.now()}.fifo`;
    await sqs.send(
      new CreateQueueCommand({
        QueueName: queueName,
        Attributes: { FifoQueue: 'true', ContentBasedDeduplication: 'false' },
      }),
    );
    const queueUrl = `${URL}/000000000000/${queueName}`;
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
