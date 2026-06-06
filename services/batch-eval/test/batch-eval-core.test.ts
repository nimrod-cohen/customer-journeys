import { describe, it, expect, vi } from 'vitest';
import {
  planBatchEval,
  planBatchSegmentApply,
  runBatchEvalForWorkspace,
  type BatchEvalDeps,
} from '../src/core.js';
import { makeBatchEvalHandler } from '../src/handler.js';

const WS = 'a1a10000-0000-0000-0000-000000000001';
const SEG = 'a1a10000-0000-0000-0000-0000000000a1';

describe('planBatchEval (workspace-scoped, dynamic_batch only)', () => {
  it('selects active dynamic_batch segments with workspace_id $1', () => {
    const q = planBatchEval(WS);
    expect(q.values).toEqual([WS]);
    expect(q.text).toMatch(/kind = 'dynamic_batch'/);
    expect(q.text).toMatch(/workspace_id = \$1/);
    expect(q.text).not.toMatch(/manual/);
  });
});

describe('planBatchSegmentApply (pure diff → statements)', () => {
  it('enters: insert membership + change_log entered', () => {
    const s = planBatchSegmentApply(WS, SEG, ['p1', 'p2'], []);
    expect(s).toHaveLength(2);
    expect(s[0]!.text).toMatch(/INSERT INTO segment_memberships/i);
    expect(s[0]!.text).toMatch(/'evaluator'/);
    expect(s[1]!.values).toContain('entered');
  });

  it('exits: delete evaluator membership + change_log exited', () => {
    const s = planBatchSegmentApply(WS, SEG, [], ['p3']);
    expect(s[0]!.text).toMatch(/DELETE FROM segment_memberships/i);
    expect(s[0]!.text).toMatch(/source = 'evaluator'/);
    expect(s[1]!.values).toContain('exited');
  });

  it('both: enters before exits; empty diff → no statements', () => {
    expect(planBatchSegmentApply(WS, SEG, [], [])).toEqual([]);
    const s = planBatchSegmentApply(WS, SEG, ['p1'], ['p2']);
    expect(s).toHaveLength(4);
  });
});

describe('runBatchEvalForWorkspace (orchestration with fakes)', () => {
  it('matches → diffs vs membership → applies entered/exited per segment', async () => {
    const applied: { ws: string; texts: string[] }[] = [];
    const deps: BatchEvalDeps = {
      reader: {
        query: vi.fn(async (text: string) => {
          if (/FROM segments/i.test(text)) {
            return {
              rows: [{ id: SEG, workspace_id: WS, kind: 'dynamic_batch', definition: { field: 'total_events', operator: '>=', value: 3 } }],
            };
          }
          if (/FROM profiles p/i.test(text)) {
            // matched set
            return { rows: [{ id: 'p1' }, { id: 'p2' }] };
          }
          if (/FROM segment_memberships/i.test(text)) {
            // current evaluator membership
            return { rows: [{ profile_id: 'p2' }, { profile_id: 'p3' }] };
          }
          return { rows: [] };
        }),
      },
      runInWorkspaceTx: vi.fn(async (ws: string, statements) => {
        applied.push({ ws, texts: statements.map((s) => s.text) });
      }),
    };

    const res = await runBatchEvalForWorkspace(deps, WS);
    // matched {p1,p2} vs current {p2,p3} → entered [p1], exited [p3]
    expect(res.segments).toEqual([{ segmentId: SEG, entered: 1, exited: 1 }]);
    expect(applied).toHaveLength(1);
    expect(applied[0]!.ws).toBe(WS);
    // insert + log(entered) + delete + log(exited)
    expect(applied[0]!.texts.some((t) => /INSERT INTO segment_memberships/i.test(t))).toBe(true);
    expect(applied[0]!.texts.some((t) => /DELETE FROM segment_memberships/i.test(t))).toBe(true);
  });

  it('no diff → no tx applied', async () => {
    const runInWorkspaceTx = vi.fn(async () => {});
    const deps: BatchEvalDeps = {
      reader: {
        query: vi.fn(async (text: string) => {
          if (/FROM segments/i.test(text)) return { rows: [{ id: SEG, workspace_id: WS, kind: 'dynamic_batch', definition: null }] };
          if (/FROM profiles p/i.test(text)) return { rows: [{ id: 'p1' }] };
          if (/FROM segment_memberships/i.test(text)) return { rows: [{ profile_id: 'p1' }] };
          return { rows: [] };
        }),
      },
      runInWorkspaceTx,
    };
    const res = await runBatchEvalForWorkspace(deps, WS);
    expect(res.segments).toEqual([{ segmentId: SEG, entered: 0, exited: 0 }]);
    expect(runInWorkspaceTx).not.toHaveBeenCalled();
  });
});

describe('makeBatchEvalHandler (per-workspace sweep, failures isolated)', () => {
  it('sweeps each workspace; one failure does not abort the rest', async () => {
    const deps = {
      listWorkspaceIds: async () => ['ws-good', 'ws-bad', 'ws-good2'],
      reader: {
        query: async (text: string, values: unknown[]) => {
          const ws = values[0];
          if (ws === 'ws-bad' && /FROM segments/i.test(text)) throw new Error('boom');
          return { rows: [] };
        },
      },
      runInWorkspaceTx: async () => {},
    };
    const handler = makeBatchEvalHandler(deps);
    const res = await handler();
    expect(res.workspaces.map((w) => w.workspaceId)).toEqual(['ws-good', 'ws-good2']);
    expect(res.failures).toEqual([{ workspaceId: 'ws-bad', error: 'boom' }]);
  });
});
