import { describe, it, expect, vi } from 'vitest';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { mockClient } from 'aws-sdk-client-mock';
import { makeIngestHandler, type IngestDeps } from '../src/handler.js';
import type { EventEnvelope, WorkspaceApiKeyRow } from '@cdp/shared';

// AC3 — durable boundary (§7, CLAUDE.md invariant 4): ingest returns 200 ONLY
// after SQS SendMessage RESOLVES. A deferred SQS mock proves the ordering: the
// handler promise must not resolve until SQS resolves. If SQS REJECTS, ingest
// returns a non-2xx so the producer retries with the same event_id.

const envelope: EventEnvelope = {
  event_id: '00000000-0000-0000-0000-000000000099',
  external_id: 'cust-7',
  type: 'progress',
  occurred_at: '2026-06-06T00:00:00.000Z',
  attributes: {},
};

const keyRow: WorkspaceApiKeyRow = {
  api_key_id: 'key-1',
  workspace_id: 'ws-1',
};

function makeEvent(apiKeyId: string | undefined, body: unknown) {
  return {
    requestContext: { identity: { apiKeyId } },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  };
}

function makeDeps(over: Partial<IngestDeps> = {}): IngestDeps {
  return {
    sqs: new SQSClient({ region: 'us-east-1' }),
    queueUrl: 'https://q/url.fifo',
    lookupApiKey: vi.fn(async () => keyRow),
    upsertProfile: vi.fn(async () => 'profile-1'),
    ...over,
  };
}

describe('ingest handler durable boundary (AC3)', () => {
  it('returns 200 ONLY after SQS SendMessage resolves (deferred mock proves ordering)', async () => {
    const sqsMock = mockClient(SQSClient);
    let resolveSend!: () => void;
    const gate = new Promise<void>((res) => {
      resolveSend = res;
    });
    sqsMock.on(SendMessageCommand).callsFake(async () => {
      await gate; // do not "accept" until the test lets it
      return { MessageId: 'm1' };
    });

    const deps = makeDeps({ sqs: sqsMock as unknown as SQSClient });
    const handler = makeIngestHandler(deps);

    let settled = false;
    const p = handler(makeEvent('key-1', envelope)).then((r) => {
      settled = true;
      return r;
    });

    // microtask flush: handler must still be pending — SQS hasn't resolved yet.
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);

    resolveSend();
    const res = await p;
    expect(settled).toBe(true);
    expect(res.statusCode).toBe(200);

    // FIFO attributes are correct on the actual send.
    const calls = sqsMock.commandCalls(SendMessageCommand);
    expect(calls).toHaveLength(1);
    const input = calls[0]!.args[0].input;
    expect(input.MessageGroupId).toBe('profile-1');
    expect(input.MessageDeduplicationId).toBe(envelope.event_id);
    sqsMock.restore();
  });

  it('returns non-2xx when SQS rejects (producer retries with same event_id)', async () => {
    const sqsMock = mockClient(SQSClient);
    sqsMock.on(SendMessageCommand).rejects(new Error('SQS unavailable'));

    const deps = makeDeps({ sqs: sqsMock as unknown as SQSClient });
    const handler = makeIngestHandler(deps);

    const res = await handler(makeEvent('key-1', envelope));
    expect(res.statusCode).toBeGreaterThanOrEqual(500);
    sqsMock.restore();
  });

  it('does NOT send to SQS and returns 400 for a malformed payload', async () => {
    const sqsMock = mockClient(SQSClient);
    sqsMock.on(SendMessageCommand).resolves({ MessageId: 'm1' });
    const deps = makeDeps({ sqs: sqsMock as unknown as SQSClient });
    const handler = makeIngestHandler(deps);

    const res = await handler(makeEvent('key-1', { external_id: 'x' }));
    expect(res.statusCode).toBe(400);
    expect(sqsMock.commandCalls(SendMessageCommand)).toHaveLength(0);
    sqsMock.restore();
  });

  it('returns 401/403 when the API key is unknown — never sends', async () => {
    const sqsMock = mockClient(SQSClient);
    sqsMock.on(SendMessageCommand).resolves({ MessageId: 'm1' });
    const deps = makeDeps({
      sqs: sqsMock as unknown as SQSClient,
      lookupApiKey: vi.fn(async () => null),
    });
    const handler = makeIngestHandler(deps);

    const res = await handler(makeEvent('unknown-key', envelope));
    expect(res.statusCode).toBe(403);
    expect(sqsMock.commandCalls(SendMessageCommand)).toHaveLength(0);
    sqsMock.restore();
  });

  it('never trusts a workspace_id in the client body — workspace comes from the key', async () => {
    const sqsMock = mockClient(SQSClient);
    sqsMock.on(SendMessageCommand).resolves({ MessageId: 'm1' });
    const upsertProfile = vi.fn(async () => 'profile-1');
    const deps = makeDeps({ sqs: sqsMock as unknown as SQSClient, upsertProfile });
    const handler = makeIngestHandler(deps);

    await handler(makeEvent('key-1', { ...envelope, workspace_id: 'attacker-ws' }));
    // profile upsert + SQS body must use the key-derived ws-1, not attacker-ws.
    expect(upsertProfile).toHaveBeenCalledWith('ws-1', envelope.external_id, expect.anything());
    const body = JSON.parse(sqsMock.commandCalls(SendMessageCommand)[0]!.args[0].input.MessageBody!);
    expect(body.workspace_id).toBe('ws-1');
    sqsMock.restore();
  });
});
