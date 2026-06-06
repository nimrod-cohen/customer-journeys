import { describe, it, expect } from 'vitest';
import { planProcessing } from '../src/core.js';
import type { ProcessorMessage } from '@cdp/shared';

// Phase 5 (§7 step 4/5, §8): planProcessing now APPENDS a realtime segment
// re-eval step AFTER the feature upsert (which reads POST-update features),
// inside the SAME workspace-scoped tx. The profile-upsert-FIRST / feature-SECOND
// ordering must NOT regress (Phase 4 invariant). The re-eval itself needs reads
// (per-segment compiled rules), so it rides as a marker on the plan that deps.ts
// executes against the tx client.

function msg(type = 'purchase'): ProcessorMessage {
  return {
    workspace_id: 'ws-1',
    profile_id: 'profile-1',
    envelope: {
      event_id: '00000000-0000-0000-0000-0000000000aa',
      external_id: 'cust-1',
      type,
      occurred_at: '2026-06-06T00:00:00.000Z',
      attributes: { amount: 10 },
    },
  };
}

describe('planProcessing — Phase 5 segment re-eval extension', () => {
  it('keeps profile-upsert FIRST, feature-upsert SECOND (no Phase 4 regression)', () => {
    const plan = planProcessing(msg());
    const texts = plan.statements.map((s) => s.text);
    const upsertIdx = texts.findIndex((t) => /INSERT INTO profiles/i.test(t));
    const featIdx = texts.findIndex((t) => /INSERT INTO profile_features/i.test(t));
    expect(upsertIdx).toBe(0);
    expect(featIdx).toBe(1);
    expect(upsertIdx).toBeLessThan(featIdx);
  });

  it('appends a realtime segment re-eval marker scoped to the changed profile', () => {
    const plan = planProcessing(msg());
    expect(plan.segmentReeval).toBeDefined();
    // re-eval is keyed by the changed profile's external_id (the processor resolves
    // its concrete id inside the tx) and is workspace-scoped.
    expect(plan.segmentReeval!.profileExternalId).toBe('cust-1');
    expect(plan.workspaceId).toBe('ws-1');
  });

  it('every static statement remains workspace-scoped (ws-1 bound)', () => {
    const plan = planProcessing(msg());
    for (const s of plan.statements) expect(s.values).toContain('ws-1');
  });
});
