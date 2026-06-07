import { describe, it, expect } from 'vitest';
import {
  buildBroadcastDedupeKey,
  buildBroadcastOutboxInsert,
  buildDispatchEnqueueMessage,
} from '../src/core.js';

// §9A / CLAUDE.md inv.1,5 — the dedupe key + the multi-row outbox INSERT that
// gives the broadcast layer of exactly-once. dedupe_key is UNIQUE per
// (broadcast_id, profile_id); the INSERT is ON CONFLICT DO NOTHING so a
// retry/concurrent run yields exactly one row per recipient. workspace_id at $1.
const WS = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const BC = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const TPL = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const P1 = '11111111-1111-1111-1111-111111111111';
const P2 = '22222222-2222-2222-2222-222222222222';

describe('buildBroadcastDedupeKey', () => {
  it('is broadcast:{broadcast_id}:{profile_id}', () => {
    expect(buildBroadcastDedupeKey(BC, P1)).toBe(`broadcast:${BC}:${P1}`);
  });
});

describe('buildBroadcastOutboxInsert', () => {
  it('binds workspace_id at $1 and is ON CONFLICT (dedupe_key) DO NOTHING', () => {
    const stmt = buildBroadcastOutboxInsert(WS, BC, TPL, { subject: 'Hi' }, [P1, P2]);
    expect(stmt.values[0]).toBe(WS);
    const t = stmt.text.replace(/\s+/g, ' ');
    expect(t).toMatch(/INSERT INTO outbox/i);
    expect(t).toMatch(/ON CONFLICT \(dedupe_key\) DO NOTHING/i);
    expect(t).toMatch(/dedupe_key/);
  });

  it('emits one row per profile with the right dedupe key', () => {
    const stmt = buildBroadcastOutboxInsert(WS, BC, TPL, { subject: 'Hi' }, [P1, P2]);
    // every profile id and its derived dedupe key must appear in the bound values
    expect(stmt.values).toContain(P1);
    expect(stmt.values).toContain(P2);
    expect(stmt.values).toContain(buildBroadcastDedupeKey(BC, P1));
    expect(stmt.values).toContain(buildBroadcastDedupeKey(BC, P2));
  });

  it('throws on a falsy workspaceId (tenancy guard)', () => {
    expect(() => buildBroadcastOutboxInsert('', BC, TPL, {}, [P1])).toThrow();
  });

  it('throws on an empty profile list (nothing to insert)', () => {
    expect(() => buildBroadcastOutboxInsert(WS, BC, TPL, {}, [])).toThrow();
  });
});

describe('buildDispatchEnqueueMessage', () => {
  it('body is { outbox_id } only — never carries workspace_id', () => {
    const cmd = buildDispatchEnqueueMessage('ob-1', 'https://sqs/dispatch');
    const input = (cmd as { input: { QueueUrl?: string; MessageBody?: string } }).input;
    expect(input.QueueUrl).toBe('https://sqs/dispatch');
    const body = JSON.parse(input.MessageBody ?? '{}');
    expect(body).toEqual({ outbox_id: 'ob-1' });
    expect(JSON.stringify(body)).not.toMatch(/workspace/i);
  });
});
