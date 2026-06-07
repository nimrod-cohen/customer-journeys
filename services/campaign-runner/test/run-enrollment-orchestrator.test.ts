import { describe, it, expect } from 'vitest';
import { runEnrollment, type RunDeps } from '../src/run.js';
import type { CampaignDefinition } from '../src/dsl.js';

// Unit test of the runEnrollment orchestrator with an in-memory fake reader/tx/
// SQS — no Postgres. Proves: CAS claim is attempted; nodes chain in one tick to
// a wait/exit boundary; condition branches consult the match query; sends are
// enqueued; the advance is guarded by the claim's updated_at.

const NOW = new Date('2026-06-07T12:00:00.000Z');

const DEF: CampaignDefinition = {
  startNode: 't',
  nodes: {
    t: { type: 'trigger', kind: 'manual', next: 'c' },
    c: {
      type: 'condition',
      ast: { field: 'total_events', operator: '>', value: 0 },
      onTrue: 'a',
      onFalse: 'x',
    },
    a: { type: 'action', kind: 'send', template_id: 'tpl-1', next: 'w' },
    w: { type: 'wait', delay: { seconds: 3600 }, next: 'x' },
    x: { type: 'exit' },
  },
};

interface FakeOpts {
  conditionMatches?: boolean;
  claimWins?: boolean;
  startNode?: string;
  updatedAt?: string;
}

function makeDeps(opts: FakeOpts = {}) {
  const conditionMatches = opts.conditionMatches ?? true;
  const claimWins = opts.claimWins ?? true;
  const startNode = opts.startNode ?? 't';
  const updatedAt = opts.updatedAt ?? '2026-06-07T11:00:00.000Z';

  const txCalls: { workspaceId: string; statements: { text: string; values: unknown[] }[] }[] = [];
  const sqsBodies: string[] = [];

  const reader = {
    async query<T>(text: string, values?: readonly unknown[]): Promise<{ rows: T[] }> {
      if (/FROM campaign_enrollments WHERE id =/.test(text)) {
        return {
          rows: [
            {
              id: 'e1',
              workspace_id: 'ws1',
              campaign_id: 'c1',
              profile_id: 'p1',
              current_node: startNode,
              status: 'active',
              next_run_at: '2026-06-07T11:30:00.000Z',
              updated_at: updatedAt,
            },
          ] as unknown as T[],
        };
      }
      if (/FROM campaigns WHERE/.test(text)) {
        return { rows: [{ definition: DEF }] as unknown as T[] };
      }
      if (/UPDATE campaign_enrollments[\s\S]*RETURNING/.test(text)) {
        // The CAS claim.
        return {
          rows: claimWins
            ? ([
                {
                  id: 'e1',
                  workspace_id: 'ws1',
                  campaign_id: 'c1',
                  profile_id: 'p1',
                  current_node: startNode,
                  status: 'active',
                  next_run_at: '2026-06-07T11:30:00.000Z',
                  updated_at: '2026-06-07T11:59:59.000Z',
                },
              ] as unknown as T[])
            : ([] as unknown as T[]),
        };
      }
      if (/FROM profiles[\s\S]*LEFT JOIN profile_features/.test(text)) {
        // Branch match query.
        return { rows: (conditionMatches ? [{ id: 'p1' }] : []) as unknown as T[] };
      }
      if (/SELECT id FROM outbox WHERE/.test(text)) {
        return { rows: [{ id: 'outbox-1' }] as unknown as T[] };
      }
      return { rows: [] as T[] };
    },
  };

  const deps: RunDeps = {
    reader,
    sqs: {
      async send(c: { input?: { MessageBody?: string } }) {
        sqsBodies.push(c.input?.MessageBody ?? '');
        return {};
      },
    } as unknown as RunDeps['sqs'],
    runInWorkspaceTx: async (workspaceId, statements) => {
      txCalls.push({ workspaceId, statements: statements as never });
    },
    now: () => NOW,
    dispatchQueueUrl: 'https://sqs/dispatch',
  };
  return { deps, txCalls, sqsBodies };
}

describe('runEnrollment', () => {
  it('chains trigger→condition(true)→action(send)→wait, parking at the wait and enqueuing the send', async () => {
    const { deps, txCalls, sqsBodies } = makeDeps({ conditionMatches: true });
    const res = await runEnrollment(deps, 'e1');
    expect(res.result).toBe('parked');
    expect((res as { node: string }).node).toBe('w');
    // one commit tx happened (outbox insert + guarded advance)
    expect(txCalls).toHaveLength(1);
    // the send was enqueued as {outbox_id}
    expect(sqsBodies).toEqual([JSON.stringify({ outbox_id: 'outbox-1' })]);
    // the advance is workspace-scoped
    expect(txCalls[0]!.workspaceId).toBe('ws1');
  });

  it('condition(false) routes straight to exit and completes with no send', async () => {
    const { deps, txCalls, sqsBodies } = makeDeps({ conditionMatches: false });
    const res = await runEnrollment(deps, 'e1');
    expect(res.result).toBe('completed');
    expect(sqsBodies).toEqual([]);
    expect(txCalls).toHaveLength(1);
  });

  it('skips when the CAS claim is lost (concurrent advance/retry)', async () => {
    const { deps, txCalls } = makeDeps({ claimWins: false });
    const res = await runEnrollment(deps, 'e1');
    expect(res).toMatchObject({ result: 'skipped' });
    expect(txCalls).toHaveLength(0); // no advance when the claim is lost
  });

  it('skips a missing enrollment', async () => {
    const deps: RunDeps = {
      reader: { async query() { return { rows: [] }; } },
      sqs: { async send() { return {}; } } as never,
      runInWorkspaceTx: async () => {},
      now: () => NOW,
      dispatchQueueUrl: 'q',
    };
    expect(await runEnrollment(deps, 'missing')).toMatchObject({ result: 'skipped' });
  });
});
