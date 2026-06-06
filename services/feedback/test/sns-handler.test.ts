import { describe, it, expect } from 'vitest';
import { makeFeedbackHandler, type SnsEvent } from '../src/handler.js';
import type { FeedbackDeps } from '../src/feedback.js';

const WS = '44444444-4444-4444-4444-444444444444';

// §10 thin SNS handler. Per-record try/catch → batch item failure; never throws.
// An UNRESOLVED notification is a batch failure (do NOT silently drop it).

function makeDeps(behavior: (note: unknown) => 'ok' | 'unresolved' | 'throw'): FeedbackDeps {
  return {
    reader: {
      async query<T>(text: string): Promise<{ rows: T[] }> {
        const t = text.replace(/\s+/g, ' ').trim();
        // resolve a workspace for the 'ok'/'throw' cases (tag lookup).
        if (/FROM workspaces WHERE id = \$1/i.test(t)) return { rows: [{ id: WS } as unknown as T] };
        if (/FROM profiles/i.test(t)) return { rows: [] };
        if (/messages_log/i.test(t)) {
          return { rows: [{ sent: 0, bounces: 0, complaints: 0 } as unknown as T] };
        }
        return { rows: [] };
      },
    },
    async runInWorkspaceTx() {
      // emulate the per-record behavior through a thrown error path
    },
  } satisfies FeedbackDeps;
}

function snsEvent(...messages: { id: string; body: unknown }[]): SnsEvent {
  return {
    Records: messages.map((m) => ({ Sns: { MessageId: m.id, Message: JSON.stringify(m.body) } })),
  };
}

describe('makeFeedbackHandler (synthetic SNS events)', () => {
  it('acks a resolved notification (no batchItemFailures)', async () => {
    const handler = makeFeedbackHandler(makeDeps(() => 'ok'));
    const res = await handler(
      snsEvent({
        id: 'a',
        body: {
          notificationType: 'Bounce',
          bounce: { bounceType: 'Permanent', bouncedRecipients: [{ emailAddress: 'a@b.com' }] },
          mail: { messageId: 'm1', tags: { workspace_id: [WS] } },
        },
      }),
    );
    expect(res.batchItemFailures).toHaveLength(0);
  });

  it('reports an UNRESOLVED notification as a batch item failure', async () => {
    const handler = makeFeedbackHandler(makeDeps(() => 'unresolved'));
    const res = await handler(
      snsEvent({
        id: 'b',
        body: {
          notificationType: 'Bounce',
          bounce: { bounceType: 'Permanent', bouncedRecipients: [{ emailAddress: 'a@b.com' }] },
          mail: { messageId: 'm2', destination: ['a@b.com'] }, // recipient only
        },
      }),
    );
    expect(res.batchItemFailures).toEqual([{ itemIdentifier: 'b' }]);
  });

  it('reports a malformed Sns.Message as a batch item failure (never throws)', async () => {
    const handler = makeFeedbackHandler(makeDeps(() => 'ok'));
    const res = await handler({ Records: [{ Sns: { MessageId: 'c', Message: 'not json' } }] });
    expect(res.batchItemFailures).toEqual([{ itemIdentifier: 'c' }]);
  });

  it('isolates failures per record (one bad, one good)', async () => {
    const handler = makeFeedbackHandler(makeDeps(() => 'ok'));
    const res = await handler(
      snsEvent(
        {
          id: 'good',
          body: {
            notificationType: 'Delivery',
            mail: { messageId: 'm3', tags: { workspace_id: [WS] }, destination: ['x@y.com'] },
          },
        },
        { id: 'bad', body: 'this-will-be-double-encoded-but-parses-to-string' },
      ),
    );
    // 'bad' parses to a string → resolveWorkspaceRef sees no mail → unresolved → failure
    expect(res.batchItemFailures.map((f) => f.itemIdentifier)).toContain('bad');
    expect(res.batchItemFailures.map((f) => f.itemIdentifier)).not.toContain('good');
  });
});
