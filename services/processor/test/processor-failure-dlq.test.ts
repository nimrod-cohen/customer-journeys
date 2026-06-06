import { describe, it, expect, vi } from 'vitest';
import { makeProcessorHandler, type ProcessorDeps } from '../src/handler.js';
import type { ProcessorMessage } from '@cdp/shared';

// AC3 — no lost events (§7, CLAUDE.md invariant 4). The handler reports a BATCH
// ITEM FAILURE for any record whose workspace-scoped tx throws (no ack), so SQS
// redelivers and eventually routes to the DLQ. Successful records are NOT in the
// failure list. We assert the SQS partial-batch-failure contract — never that
// "SQS delivered in order".

function msg(id: string, profileId = 'p1'): ProcessorMessage {
  return {
    workspace_id: 'ws-1',
    profile_id: profileId,
    envelope: {
      event_id: id,
      external_id: 'cust-1',
      type: 'progress',
      occurred_at: '2026-06-06T00:00:00.000Z',
      attributes: {},
    },
  };
}

function record(id: string, m: ProcessorMessage) {
  return { messageId: id, body: JSON.stringify(m) };
}

function makeDeps(runTx: ProcessorDeps['runInWorkspaceTx']): ProcessorDeps {
  return { runInWorkspaceTx: runTx };
}

describe('processor handler failure → DLQ contract (AC3)', () => {
  it('reports batchItemFailures for failing records and acks the rest', async () => {
    const runTx = vi.fn(async (_ws: string, plan: { statements: unknown[] }) => {
      void plan;
    });
    // first record fails, second succeeds
    runTx
      .mockImplementationOnce(async () => {
        throw new Error('DB write failed');
      })
      .mockImplementationOnce(async () => {});

    const handler = makeProcessorHandler(makeDeps(runTx));
    const res = await handler({
      Records: [record('r1', msg('e1')), record('r2', msg('e2'))],
    });

    expect(res.batchItemFailures).toEqual([{ itemIdentifier: 'r1' }]);
  });

  it('a record with an unparseable body is reported as a failure (no ack, no throw)', async () => {
    const runTx = vi.fn(async () => {});
    const handler = makeProcessorHandler(makeDeps(runTx));
    const res = await handler({
      Records: [{ messageId: 'bad', body: 'not-json' }],
    });
    expect(res.batchItemFailures).toEqual([{ itemIdentifier: 'bad' }]);
    expect(runTx).not.toHaveBeenCalled();
  });

  it('all-success yields an empty batchItemFailures list', async () => {
    const runTx = vi.fn(async () => {});
    const handler = makeProcessorHandler(makeDeps(runTx));
    const res = await handler({
      Records: [record('r1', msg('e1')), record('r2', msg('e2'))],
    });
    expect(res.batchItemFailures).toEqual([]);
  });

  it('runs each record in a workspace-scoped tx (workspace_id passed through)', async () => {
    const seen: string[] = [];
    const runTx = vi.fn(async (ws: string) => {
      seen.push(ws);
    });
    const handler = makeProcessorHandler(makeDeps(runTx));
    await handler({ Records: [record('r1', msg('e1'))] });
    expect(seen).toEqual(['ws-1']);
  });
});
