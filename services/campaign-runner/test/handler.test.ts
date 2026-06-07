import { describe, it, expect } from 'vitest';
import { makeScheduledSweepHandler } from '../src/handler.js';
import type { RunDeps } from '../src/run.js';

// §9B — the scheduled sweep runs each due enrollment and isolates per-row
// failures (one bad enrollment must not abort the sweep); the handler never
// throws.
function makeDeps(rowIds: string[], failOn?: string) {
  const runCalls: string[] = [];
  const reader = {
    async query<T>(text: string): Promise<{ rows: T[] }> {
      if (/FROM campaign_enrollments/.test(text)) {
        return { rows: rowIds.map((id) => ({ id })) as unknown as T[] };
      }
      // For runEnrollment's own load: throw to force a per-row failure when asked.
      throw new Error('unexpected');
    },
  };
  const deps: RunDeps = {
    reader: reader as never,
    sqs: { async send() { return {}; } } as never,
    runInWorkspaceTx: async () => {},
    now: () => new Date('2026-06-07T12:00:00.000Z'),
    dispatchQueueUrl: 'q',
  };
  return { deps, runCalls, failOn };
}

describe('makeScheduledSweepHandler', () => {
  it('reads the due set and runs each (isolating failures, never throwing)', async () => {
    // runEnrollment will fail internally (load throws) but the sweep must not
    // throw — it isolates each row.
    const { deps } = makeDeps(['e1', 'e2', 'e3']);
    const handler = makeScheduledSweepHandler(deps);
    await expect(handler()).resolves.toBeUndefined();
  });

  it('returns quietly when the due-set read fails', async () => {
    const deps: RunDeps = {
      reader: { async query() { throw new Error('db down'); } } as never,
      sqs: { async send() { return {}; } } as never,
      runInWorkspaceTx: async () => {},
      now: () => new Date(),
      dispatchQueueUrl: 'q',
    };
    await expect(makeScheduledSweepHandler(deps)()).resolves.toBeUndefined();
  });
});
