import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { adminPool, hasDatabaseUrl } from '@cdp/db';
import type { SendMessageCommand } from '@aws-sdk/client-sqs';
import { runBroadcast, type BroadcastDeps, type Reader } from '../src/send.js';
import { runStatementsInWorkspaceTx } from '../src/deps.js';

// CLAUDE.md inv.1,2 — workspace_id is loaded FROM the broadcast row (never a
// client) and every statement binds workspace_id at $1. Two workspaces own a
// same-named segment with overlapping emails; a broadcast in WS-A must resolve
// ONLY WS-A members and never touch WS-B's profiles/outbox. Real Postgres.
const RUN = hasDatabaseUrl();
const wsA = 'b9000000-0000-0000-0000-0000000000a5';
const wsB = 'b9000000-0000-0000-0000-0000000000b5';

class FakeSqs {
  public sent: SendMessageCommand[] = [];
  async send(c: SendMessageCommand) {
    this.sent.push(c);
    return {};
  }
}

describe.skipIf(!RUN)('broadcast workspace scoping (real Postgres)', () => {
  let admin: Pool;
  let broadcastA: string;
  let aProfiles: string[] = [];

  beforeAll(async () => {
    admin = adminPool();
    await cleanup();
    for (const w of [wsA, wsB]) {
      await admin.query("INSERT INTO workspaces (id, name, status) VALUES ($1,'W','active')", [w]);
    }
    aProfiles = await seedWorkspace(wsA, 'a');
    await seedWorkspace(wsB, 'b'); // same external_id pattern + emails

    // broadcast in WS-A targeting WS-A's segment
    const segA = await admin.query(
      "SELECT id FROM segments WHERE workspace_id = $1 LIMIT 1",
      [wsA],
    );
    const tplA = await admin.query("SELECT id FROM email_templates WHERE workspace_id = $1 LIMIT 1", [wsA]);
    const b = await admin.query(
      "INSERT INTO broadcasts (workspace_id, name, template_id, audience_kind, audience_ref, status) VALUES ($1,'B',$2,'segment',$3,'draft') RETURNING id",
      [wsA, tplA.rows[0].id, segA.rows[0].id],
    );
    broadcastA = b.rows[0].id;
  });

  afterAll(async () => {
    if (admin) {
      await cleanup();
      await admin.end();
    }
  });

  async function seedWorkspace(w: string, tag: string): Promise<string[]> {
    const t = await admin.query(
      "INSERT INTO email_templates (workspace_id, name, mjml, compiled_html) VALUES ($1,'t','<m/>','<html/>') RETURNING id",
      [w],
    );
    void t;
    const s = await admin.query(
      "INSERT INTO segments (workspace_id, name, kind) VALUES ($1,'shared','manual') RETURNING id",
      [w],
    );
    const segId = s.rows[0].id;
    const ids: string[] = [];
    for (let i = 0; i < 2; i++) {
      const p = await admin.query(
        'INSERT INTO profiles (workspace_id, external_id, email) VALUES ($1,$2,$3) RETURNING id',
        [w, `shared-${i}`, `shared-${i}@example.com`],
      );
      ids.push(p.rows[0].id);
      await admin.query(
        "INSERT INTO segment_memberships (segment_id, profile_id, workspace_id, source) VALUES ($1,$2,$3,'manual')",
        [segId, p.rows[0].id, w],
      );
    }
    return ids;
  }

  async function cleanup() {
    for (const w of [wsA, wsB]) {
      await admin.query('DELETE FROM outbox WHERE workspace_id = $1', [w]);
      await admin.query('DELETE FROM segment_memberships WHERE workspace_id = $1', [w]);
      await admin.query('DELETE FROM segments WHERE workspace_id = $1', [w]);
      await admin.query('DELETE FROM broadcasts WHERE workspace_id = $1', [w]);
      await admin.query('DELETE FROM email_templates WHERE workspace_id = $1', [w]);
      await admin.query('DELETE FROM profiles WHERE workspace_id = $1', [w]);
      await admin.query('DELETE FROM workspaces WHERE id = $1', [w]);
    }
  }

  it('resolves only the owning workspace audience; never inserts into another workspace', async () => {
    const sqs = new FakeSqs();
    const reader: Reader = { query: (text, values) => admin.query(text, values as unknown[]) as never };
    const deps: BroadcastDeps = {
      reader,
      sqs,
      runInWorkspaceTx: (w, s) => runStatementsInWorkspaceTx(admin, w, s),
      now: () => new Date('2026-06-07T12:00:00.000Z'),
      dispatchQueueUrl: 'https://sqs/dispatch',
    };
    const res = await runBroadcast(deps, broadcastA);
    expect(res).toEqual({ result: 'sent', recipientCount: 2, batchCount: 1 });

    const a = await admin.query('SELECT profile_id FROM outbox WHERE workspace_id = $1', [wsA]);
    const b = await admin.query('SELECT count(*)::int n FROM outbox WHERE workspace_id = $1', [wsB]);
    expect(new Set(a.rows.map((r) => r.profile_id))).toEqual(new Set(aProfiles));
    expect(b.rows[0].n).toBe(0);
  });
});
