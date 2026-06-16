import { describe, it, expect, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { runBroadcast, type BroadcastDeps, type Reader } from '../src/send.js';
import { makeSendNowHandler, makeScheduledSweepHandler } from '../src/handler.js';
import type { SqlStatement } from '../src/core.js';

// §9A / §16A — orchestrator + thin handlers with fakes. SQS is mocked at the
// boundary (aws-sdk-client-mock). We assert: workspace comes from the row, the
// audience is resolved at send time, outbox rows are inserted then each
// {outbox_id} is enqueued (NO workspace_id in the body), and status→sending→sent.
const sqsMock = mockClient(SQSClient);
const sqs = new SQSClient({});

const WS = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const BC = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const TPL = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const SEG = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
const P1 = '11111111-1111-1111-1111-111111111111';
const P2 = '22222222-2222-2222-2222-222222222222';

interface FakeState {
  status: string;
  scheduledAt: string | null;
  members: string[];
}

function makeDeps(state: FakeState, calls: { tx: SqlStatement[][] }): BroadcastDeps {
  const reader: Reader = {
    async query<T>(text: string): Promise<{ rows: T[] }> {
      const t = text.replace(/\s+/g, ' ').trim();
      if (t.startsWith('SELECT id, workspace_id, template_id, audience_kind')) {
        return {
          rows: [
            {
              id: BC,
              workspace_id: WS,
              template_id: TPL,
              audience_kind: 'segment',
              audience_ref: SEG,
              scheduled_at: state.scheduledAt,
              status: state.status,
            } as unknown as T,
          ],
        };
      }
      if (t.startsWith('SELECT status FROM broadcasts')) {
        return { rows: [{ status: state.status } as unknown as T] };
      }
      if (t.startsWith('SELECT profile_id FROM segment_memberships')) {
        return { rows: state.members.map((profile_id) => ({ profile_id })) as unknown as T[] };
      }
      if (t.startsWith('SELECT id FROM outbox')) {
        // one synthetic outbox id per member in this batch
        return { rows: state.members.map((p) => ({ id: `ob-${p}` })) as unknown as T[] };
      }
      return { rows: [] };
    },
  };
  return {
    reader,
    sqs,
    async runInWorkspaceTx(workspaceId, statements) {
      expect(workspaceId).toBe(WS);
      for (const s of statements) expect(s.values[0]).toBe(WS);
      calls.tx.push([...statements]);
      // reflect the claim/sent status changes the orchestrator expects to see
      const setSending = statements.some((s) => /status = \$4/.test(s.text) && s.values[3] === 'sending');
      const setSent = statements.some((s) => s.values[3] === 'sent');
      if (setSending) state.status = 'sending';
      if (setSent) state.status = 'sent';
    },
    now: () => new Date('2026-06-07T12:00:00.000Z'),
    dispatchQueueUrl: 'https://sqs/dispatch',
    batchSize: 500,
  };
}

describe('runBroadcast (fakes; SQS mocked at the boundary)', () => {
  beforeEach(() => {
    sqsMock.reset();
    sqsMock.on(SendMessageCommand).resolves({ MessageId: 'm' });
  });

  it('resolves audience at send time, inserts outbox, enqueues {outbox_id}, marks sent', async () => {
    const state: FakeState = { status: 'draft', scheduledAt: null, members: [P1, P2] };
    const calls = { tx: [] as SqlStatement[][] };
    const res = await runBroadcast(makeDeps(state, calls), BC);

    expect(res).toEqual({ result: 'sent', recipientCount: 2, batchCount: 1 });
    expect(state.status).toBe('sent');

    const sends = sqsMock.commandCalls(SendMessageCommand);
    expect(sends).toHaveLength(2);
    for (const c of sends) {
      const body = JSON.parse(c.args[0].input.MessageBody as string);
      expect(Object.keys(body)).toEqual(['outbox_id']);
      expect(JSON.stringify(body)).not.toMatch(/workspace/i);
    }
  });

  it('skips a not-yet-due scheduled broadcast (no SQS, no status change)', async () => {
    const state: FakeState = {
      status: 'scheduled',
      scheduledAt: '2026-06-07T13:00:00.000Z',
      members: [P1],
    };
    const res = await runBroadcast(makeDeps(state, { tx: [] }), BC);
    expect(res.result).toBe('skipped');
    expect(state.status).toBe('scheduled');
    expect(sqsMock.commandCalls(SendMessageCommand)).toHaveLength(0);
  });

  it('skips a broadcast already sent (terminal)', async () => {
    const state: FakeState = { status: 'sent', scheduledAt: null, members: [P1] };
    const res = await runBroadcast(makeDeps(state, { tx: [] }), BC);
    expect(res.result).toBe('skipped');
    expect(sqsMock.commandCalls(SendMessageCommand)).toHaveLength(0);
  });

  it('REVERTS sending→draft when audience resolution fails (no stuck "sending")', async () => {
    // Reproduces the real incident: a dynamic segment whose rule doesn't compile
    // (a bare attribute key). The claim flips status→sending, then buildSegmentMatch
    // throws — the orchestrator must roll the status back, not leave it stuck.
    const tx: SqlStatement[][] = [];
    const reader: Reader = {
      async query<T>(text: string): Promise<{ rows: T[] }> {
        const t = text.replace(/\s+/g, ' ').trim();
        if (t.startsWith('SELECT id, workspace_id, template_id, audience_kind')) {
          return {
            rows: [
              { id: BC, workspace_id: WS, template_id: TPL, audience_kind: 'segment', audience_ref: SEG, scheduled_at: null, status: 'draft' } as unknown as T,
            ],
          };
        }
        if (t.startsWith('SELECT status FROM broadcasts')) return { rows: [{ status: 'sending' } as unknown as T] };
        if (t.startsWith('SELECT kind, definition FROM segments')) {
          // A bad rule (bare attribute key) → the compiler throws.
          return { rows: [{ kind: 'dynamic_realtime', definition: { field: 'is_admin', operator: '=', value: 1 } } as unknown as T] };
        }
        return { rows: [] };
      },
    };
    const deps: BroadcastDeps = {
      reader,
      sqs,
      async runInWorkspaceTx(_ws, statements) {
        tx.push([...statements]);
      },
      now: () => new Date('2026-06-07T12:00:00.000Z'),
      dispatchQueueUrl: 'https://sqs/dispatch',
      batchSize: 500,
    };
    await expect(runBroadcast(deps, BC)).rejects.toThrow();
    // First tx claims sending; the LAST tx reverts to draft (so it's not stuck).
    expect(tx[0]!.some((s) => s.values[3] === 'sending')).toBe(true);
    expect(tx.at(-1)!.some((s) => s.values[3] === 'draft')).toBe(true);
    // Nothing was enqueued.
    expect(sqsMock.commandCalls(SendMessageCommand)).toHaveLength(0);
  });
});

describe('thin handlers never throw', () => {
  beforeEach(() => {
    sqsMock.reset();
    sqsMock.on(SendMessageCommand).resolves({ MessageId: 'm' });
  });

  it('onSendNow swallows orchestrator errors', async () => {
    const deps = {
      reader: { query: async () => { throw new Error('db down'); } },
      sqs,
      runInWorkspaceTx: async () => {},
      now: () => new Date(),
      dispatchQueueUrl: 'https://sqs/dispatch',
    } as unknown as BroadcastDeps;
    await expect(makeSendNowHandler(deps)(BC)).resolves.toBeUndefined();
  });

  it('onScheduledSweep runs each due broadcast and isolates failures', async () => {
    const state: FakeState = { status: 'scheduled', scheduledAt: '2026-06-07T11:00:00.000Z', members: [P1] };
    const calls = { tx: [] as SqlStatement[][] };
    const base = makeDeps(state, calls);
    const deps: BroadcastDeps = {
      ...base,
      reader: {
        async query<T>(text: string, values?: readonly unknown[]): Promise<{ rows: T[] }> {
          const t = text.replace(/\s+/g, ' ').trim();
          if (t.startsWith('SELECT id, workspace_id FROM broadcasts')) {
            return { rows: [{ id: BC }] as unknown as T[] };
          }
          return base.reader.query(text, values);
        },
      },
    };
    await expect(makeScheduledSweepHandler(deps)()).resolves.toBeUndefined();
    expect(state.status).toBe('sent');
  });
});
