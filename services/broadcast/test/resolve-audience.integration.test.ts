import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { adminPool, hasDatabaseUrl } from '@cdp/db';
import type { SendMessageCommand } from '@aws-sdk/client-sqs';
import { runBroadcast, type BroadcastDeps, type Reader } from '../src/send.js';
import { runStatementsInWorkspaceTx } from '../src/deps.js';

// §9A CRITICAL invariant: the audience is resolved AT SEND TIME from
// segment_memberships (dynamic + manual, both sources). We prove it by MUTATING
// memberships AFTER the broadcast is created but BEFORE the send, and asserting
// the outbox reflects the membership set as of the send. Real Postgres; SQS is a
// counting fake. File-local workspace UUID + namespace.
const RUN = hasDatabaseUrl();
const ws = 'b9000000-0000-0000-0000-0000000000a1';

class FakeSqs {
  public sent: SendMessageCommand[] = [];
  async send(c: SendMessageCommand) {
    this.sent.push(c);
    return {};
  }
}

describe.skipIf(!RUN)('broadcast audience resolved at send time (real Postgres)', () => {
  let admin: Pool;
  let templateId: string;
  let segmentId: string;
  let pIds: string[] = [];

  beforeAll(async () => {
    admin = adminPool();
    await cleanup();
    await admin.query(
      "INSERT INTO workspaces (id, name, status, sending_identity) VALUES ($1,'W','active',$2::jsonb)",
      [ws, JSON.stringify({ verified: true, from_domain: 'mail.acme.com', config_set: 'cs' })],
    );
    const t = await admin.query(
      "INSERT INTO email_templates (workspace_id, name, mjml, compiled_html) VALUES ($1,'t','<m/>','<html>Hi</html>') RETURNING id",
      [ws],
    );
    templateId = t.rows[0].id;
    const s = await admin.query(
      "INSERT INTO segments (workspace_id, name, kind) VALUES ($1,'seg','manual') RETURNING id",
      [ws],
    );
    segmentId = s.rows[0].id;
    for (let i = 0; i < 3; i++) {
      const p = await admin.query(
        'INSERT INTO profiles (workspace_id, external_id, email) VALUES ($1,$2,$3) RETURNING id',
        [ws, `ra-${i}`, `ra-${i}@example.com`],
      );
      pIds.push(p.rows[0].id);
    }
  });

  afterAll(async () => {
    if (admin) {
      await cleanup();
      await admin.end();
    }
  });

  async function cleanup() {
    await admin.query('DELETE FROM outbox WHERE workspace_id = $1', [ws]);
    await admin.query('DELETE FROM broadcasts WHERE workspace_id = $1', [ws]);
    await admin.query('DELETE FROM segment_memberships WHERE workspace_id = $1', [ws]);
    await admin.query('DELETE FROM segments WHERE workspace_id = $1', [ws]);
    await admin.query('DELETE FROM email_templates WHERE workspace_id = $1', [ws]);
    await admin.query('DELETE FROM profiles WHERE workspace_id = $1', [ws]);
    await admin.query('DELETE FROM workspaces WHERE id = $1', [ws]);
  }

  function makeDeps(sqs: FakeSqs): BroadcastDeps {
    const reader: Reader = { query: (text, values) => admin.query(text, values as unknown[]) as never };
    return {
      reader,
      sqs,
      runInWorkspaceTx: (w, s) => runStatementsInWorkspaceTx(admin, w, s),
      now: () => new Date('2026-06-07T12:00:00.000Z'),
      dispatchQueueUrl: 'https://sqs/dispatch',
      batchSize: 500,
    };
  }

  it('inserts outbox rows for the membership set as of send time (post-creation mutation reflected)', async () => {
    // Broadcast created when only p0 is a member.
    await admin.query(
      "INSERT INTO segment_memberships (segment_id, profile_id, workspace_id, source) VALUES ($1,$2,$3,'manual')",
      [segmentId, pIds[0], ws],
    );
    const b = await admin.query(
      "INSERT INTO broadcasts (workspace_id, name, template_id, audience_kind, audience_ref, status) VALUES ($1,'B',$2,'manual_group',$3,'draft') RETURNING id",
      [ws, templateId, segmentId],
    );
    const broadcastId = b.rows[0].id;

    // MUTATE AFTER creation, BEFORE send: add p1, p2.
    await admin.query(
      "INSERT INTO segment_memberships (segment_id, profile_id, workspace_id, source) VALUES ($1,$2,$3,'manual'),($1,$4,$3,'manual')",
      [segmentId, pIds[1], ws, pIds[2]],
    );

    const sqs = new FakeSqs();
    const res = await runBroadcast(makeDeps(sqs), broadcastId);
    expect(res).toEqual({ result: 'sent', recipientCount: 3, batchCount: 1 });

    const ob = await admin.query(
      'SELECT profile_id, dedupe_key FROM outbox WHERE workspace_id = $1 ORDER BY dedupe_key',
      [ws],
    );
    expect(ob.rows).toHaveLength(3);
    const profileSet = new Set(ob.rows.map((r) => r.profile_id));
    expect(profileSet).toEqual(new Set(pIds));
    expect(sqs.sent).toHaveLength(3);

    const st = await admin.query('SELECT status, sent_at FROM broadcasts WHERE id = $1', [broadcastId]);
    expect(st.rows[0].status).toBe('sent');
    expect(st.rows[0].sent_at).not.toBeNull();
  });
});
