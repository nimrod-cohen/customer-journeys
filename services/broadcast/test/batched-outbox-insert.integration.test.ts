import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { adminPool, hasDatabaseUrl } from '@cdp/db';
import type { SendMessageCommand } from '@aws-sdk/client-sqs';
import { runBroadcast, type BroadcastDeps, type Reader } from '../src/send.js';
import { runStatementsInWorkspaceTx } from '../src/deps.js';

// §9A — large audiences are enumerated in BATCHES (paginated outbox inserts +
// enqueues). With batchSize=2 and 5 members → 3 batches, but still exactly 5
// outbox rows and 5 enqueues. Real Postgres; counting fake SQS.
const RUN = hasDatabaseUrl();
const ws = 'b9000000-0000-0000-0000-0000000000a2';

class FakeSqs {
  public sent: SendMessageCommand[] = [];
  async send(c: SendMessageCommand) {
    this.sent.push(c);
    return {};
  }
}

describe.skipIf(!RUN)('broadcast batched outbox insert (real Postgres)', () => {
  let admin: Pool;
  let broadcastId: string;

  beforeAll(async () => {
    admin = adminPool();
    await cleanup();
    await admin.query("INSERT INTO workspaces (id, name, status) VALUES ($1,'W','active')", [ws]);
    const t = await admin.query(
      "INSERT INTO email_templates (workspace_id, name, mjml, compiled_html) VALUES ($1,'t','<m/>','<html/>') RETURNING id",
      [ws],
    );
    const templateId = t.rows[0].id;
    const s = await admin.query(
      "INSERT INTO segments (workspace_id, name, kind) VALUES ($1,'seg','manual') RETURNING id",
      [ws],
    );
    const segmentId = s.rows[0].id;
    for (let i = 0; i < 5; i++) {
      const p = await admin.query(
        'INSERT INTO profiles (workspace_id, external_id, email) VALUES ($1,$2,$3) RETURNING id',
        [ws, `bo-${i}`, `bo-${i}@example.com`],
      );
      await admin.query(
        "INSERT INTO segment_memberships (segment_id, profile_id, workspace_id, source) VALUES ($1,$2,$3,'manual')",
        [segmentId, p.rows[0].id, ws],
      );
    }
    const b = await admin.query(
      "INSERT INTO broadcasts (workspace_id, name, template_id, audience_kind, audience_ref, status) VALUES ($1,'B',$2,'segment',$3,'draft') RETURNING id",
      [ws, templateId, segmentId],
    );
    broadcastId = b.rows[0].id;
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

  it('chunks a 5-member audience into 3 batches but inserts exactly 5 outbox rows + 5 enqueues', async () => {
    const sqs = new FakeSqs();
    const reader: Reader = { query: (text, values) => admin.query(text, values as unknown[]) as never };
    const deps: BroadcastDeps = {
      reader,
      sqs,
      runInWorkspaceTx: (w, s) => runStatementsInWorkspaceTx(admin, w, s),
      now: () => new Date('2026-06-07T12:00:00.000Z'),
      dispatchQueueUrl: 'https://sqs/dispatch',
      batchSize: 2,
    };
    const res = await runBroadcast(deps, broadcastId);
    expect(res).toEqual({ result: 'sent', recipientCount: 5, batchCount: 3 });

    const n = await admin.query('SELECT count(*)::int n FROM outbox WHERE workspace_id = $1', [ws]);
    expect(n.rows[0].n).toBe(5);
    expect(sqs.sent).toHaveLength(5);
  });
});
