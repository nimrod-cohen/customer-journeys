import { describe, it, expect } from 'vitest';
import { buildFeedbackPlan, handleNotification, type FeedbackDeps } from '../src/feedback.js';
import type { SesNotification } from '../src/core.js';

const WS = '22222222-2222-2222-2222-222222222222';
const PROFILE = '33333333-3333-3333-3333-333333333333';

// §10 orchestrator. buildFeedbackPlan is pure-ish: given a classified event,
// the resolved profile id, and the prior soft-bounce count, it returns the list
// of SqlStatements to commit. handleNotification wires resolution + reads + the
// commit + reputation policing.

describe('buildFeedbackPlan', () => {
  it('hard bounce → suppression + global hard bounce + profile status + event row', () => {
    const plan = buildFeedbackPlan({
      workspaceId: WS,
      classified: {
        category: 'hard_bounce',
        type: 'bounce',
        subType: 'Permanent',
        sesMessageId: 'm1',
        recipients: ['a@b.com'],
      },
      profileId: PROFILE,
      priorSoftBounceCount: 0,
      raw: {},
    });
    const text = plan.map((s) => s.text).join('\n');
    expect(text).toMatch(/INSERT INTO email_events/i);
    expect(text).toMatch(/INSERT INTO suppressions/i);
    expect(text).toMatch(/INSERT INTO global_hard_bounces/i);
    expect(text).toMatch(/UPDATE profiles/i);
    // Every workspace-scoped statement binds WS at $1; the global one does not.
    for (const s of plan) {
      if (/global_hard_bounces/i.test(s.text)) {
        expect(s.values[0]).toBe('a@b.com');
      } else {
        expect(s.values[0]).toBe(WS);
      }
    }
  });

  it('complaint → suppression (complaint) + profile status complained, NO global row', () => {
    const plan = buildFeedbackPlan({
      workspaceId: WS,
      classified: { category: 'complaint', type: 'complaint', subType: null, sesMessageId: 'm2', recipients: ['c@b.com'] },
      profileId: PROFILE,
      priorSoftBounceCount: 0,
      raw: {},
    });
    const text = plan.map((s) => s.text).join('\n');
    expect(text).toMatch(/INSERT INTO suppressions/i);
    expect(text).not.toMatch(/global_hard_bounces/i);
    expect(text).toMatch(/email_status = \$3/);
  });

  it('soft bounce below N → only the event row (no suppression)', () => {
    const plan = buildFeedbackPlan({
      workspaceId: WS,
      classified: { category: 'soft_bounce', type: 'bounce', subType: 'Transient', sesMessageId: 'm3', recipients: ['s@b.com'] },
      profileId: PROFILE,
      priorSoftBounceCount: 0, // 1st event, N=3
      raw: {},
    });
    const text = plan.map((s) => s.text).join('\n');
    expect(text).toMatch(/INSERT INTO email_events/i);
    expect(text).not.toMatch(/INSERT INTO suppressions/i);
  });

  it('soft bounce AT N → event row + suppression', () => {
    const plan = buildFeedbackPlan({
      workspaceId: WS,
      classified: { category: 'soft_bounce', type: 'bounce', subType: 'Transient', sesMessageId: 'm4', recipients: ['s@b.com'] },
      profileId: PROFILE,
      priorSoftBounceCount: 2, // 3rd event, N=3 → cross
      raw: {},
    });
    const text = plan.map((s) => s.text).join('\n');
    expect(text).toMatch(/INSERT INTO suppressions/i);
    expect(text).not.toMatch(/global_hard_bounces/i);
  });

  it('other (delivery/open/click) → only the event row', () => {
    const plan = buildFeedbackPlan({
      workspaceId: WS,
      classified: { category: 'other', type: 'delivery', subType: null, sesMessageId: 'm5', recipients: ['d@b.com'] },
      profileId: null,
      priorSoftBounceCount: 0,
      raw: {},
    });
    expect(plan).toHaveLength(1);
    expect(plan[0].text).toMatch(/INSERT INTO email_events/i);
  });
});

// ── handleNotification (orchestration) ───────────────────────────────────────

interface Captured {
  committed: { ws: string; statements: { text: string; values: unknown[] }[] }[];
}

function makeDeps(opts: {
  resolveWorkspaceId?: string | null;
  profileId?: string | null;
  priorSoftBounces?: number;
  reputation?: { sent: number; bounces: number; complaints: number };
  captured: Captured;
}): FeedbackDeps {
  return {
    reader: {
      async query<T>(text: string): Promise<{ rows: T[] }> {
        const t = text.replace(/\s+/g, ' ').trim();
        if (/FROM workspaces/i.test(t) && /sending_identity/i.test(t)) {
          // config_set / from_domain resolution lookup
          return opts.resolveWorkspaceId
            ? { rows: [{ id: opts.resolveWorkspaceId } as unknown as T] }
            : { rows: [] };
        }
        if (/FROM workspaces/i.test(t)) {
          return opts.resolveWorkspaceId
            ? { rows: [{ id: opts.resolveWorkspaceId } as unknown as T] }
            : { rows: [] };
        }
        if (/FROM profiles/i.test(t)) {
          return opts.profileId ? { rows: [{ id: opts.profileId } as unknown as T] } : { rows: [] };
        }
        if (/count\(DISTINCT ses_message_id\)/i.test(t)) {
          return { rows: [{ n: opts.priorSoftBounces ?? 0 } as unknown as T] };
        }
        if (/messages_log/i.test(t)) {
          const r = opts.reputation ?? { sent: 0, bounces: 0, complaints: 0 };
          return { rows: [r as unknown as T] };
        }
        return { rows: [] };
      },
    },
    async runInWorkspaceTx(ws, statements) {
      opts.captured.committed.push({ ws, statements: statements.map((s) => ({ text: s.text, values: [...s.values] })) });
    },
  };
}

describe('handleNotification', () => {
  it('resolves workspace by tag, commits the plan, and runs reputation policing', async () => {
    const captured: Captured = { committed: [] };
    const deps = makeDeps({
      resolveWorkspaceId: WS,
      profileId: PROFILE,
      priorSoftBounces: 0,
      reputation: { sent: 1000, bounces: 1, complaints: 0 }, // healthy
      captured,
    });
    const note: SesNotification = {
      notificationType: 'Bounce',
      bounce: { bounceType: 'Permanent', bouncedRecipients: [{ emailAddress: 'a@b.com' }] },
      mail: { messageId: 'm1', tags: { workspace_id: [WS] } },
    };
    const res = await handleNotification(deps, note);
    expect(res.status).toBe('ok');
    // plan committed for the resolved workspace
    expect(captured.committed[0].ws).toBe(WS);
    // healthy → no suspend statement
    const allText = captured.committed.flatMap((c) => c.statements.map((s) => s.text)).join('\n');
    expect(allText).not.toMatch(/status = 'suspended'/i);
  });

  it('auto-suspends ONLY the offending workspace when its rate breaches threshold', async () => {
    const captured: Captured = { committed: [] };
    const deps = makeDeps({
      resolveWorkspaceId: WS,
      profileId: PROFILE,
      reputation: { sent: 1000, bounces: 200, complaints: 0 }, // 20% bounce
      captured,
    });
    const note: SesNotification = {
      eventType: 'Bounce',
      bounce: { bounceType: 'Permanent', bouncedRecipients: [{ emailAddress: 'a@b.com' }] },
      mail: { messageId: 'm9', tags: { workspace_id: [WS] } },
    };
    const res = await handleNotification(deps, note);
    expect(res.status).toBe('ok');
    const suspendStmt = captured.committed
      .flatMap((c) => c.statements)
      .find((s) => /status = 'suspended'/i.test(s.text));
    expect(suspendStmt).toBeDefined();
    expect(suspendStmt!.values).toEqual([WS]);
  });

  it('returns unresolved (→ batch failure) when no sender-side workspace signal', async () => {
    const captured: Captured = { committed: [] };
    const deps = makeDeps({ resolveWorkspaceId: null, captured });
    const note: SesNotification = {
      notificationType: 'Bounce',
      bounce: { bounceType: 'Permanent', bouncedRecipients: [{ emailAddress: 'a@b.com' }] },
      mail: { messageId: 'm1', destination: ['a@b.com'] }, // recipient only — NOT usable
    };
    const res = await handleNotification(deps, note);
    expect(res.status).toBe('unresolved');
    expect(captured.committed).toHaveLength(0);
  });

  it('returns unresolved when a sender signal exists but maps to no workspace row', async () => {
    const captured: Captured = { committed: [] };
    const deps = makeDeps({ resolveWorkspaceId: null, captured });
    const note: SesNotification = {
      eventType: 'Bounce',
      bounce: { bounceType: 'Permanent', bouncedRecipients: [{ emailAddress: 'a@b.com' }] },
      mail: { messageId: 'm1', source: 'no-reply@unknown.example' },
    };
    const res = await handleNotification(deps, note);
    expect(res.status).toBe('unresolved');
    expect(captured.committed).toHaveLength(0);
  });
});
