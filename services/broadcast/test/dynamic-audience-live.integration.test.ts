import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { adminPool, hasDatabaseUrl } from '@cdp/db';
import type { SendMessageCommand } from '@aws-sdk/client-sqs';
import { runBroadcast, type BroadcastDeps, type Reader } from '../src/send.js';
import { runStatementsInWorkspaceTx } from '../src/deps.js';

// §9A + segments-eval Phase 3: a DYNAMIC segment audience is resolved LIVE at send
// time by running its rule — NOT from segment_memberships. We prove it by seeding
// matching profiles with NO membership rows at all: the broadcast still reaches the
// rule's matches (and excludes non-matchers), and a time-window rule reflects now().
const RUN = hasDatabaseUrl();
const ws = 'b9000000-0000-0000-0000-0000000000d1';

class FakeSqs {
  public sent: SendMessageCommand[] = [];
  async send(c: SendMessageCommand) {
    this.sent.push(c);
    return {};
  }
}

describe.skipIf(!RUN)('broadcast dynamic audience is resolved live (real Postgres)', () => {
  let admin: Pool;
  let templateId: string;

  beforeAll(async () => {
    admin = adminPool();
    await cleanup();
    await admin.query("INSERT INTO workspaces (id, name, status) VALUES ($1,'W','active')", [ws]);
    const t = await admin.query(
      "INSERT INTO email_templates (workspace_id, name, mjml, compiled_html) VALUES ($1,'t','<m/>','<html/>') RETURNING id",
      [ws],
    );
    templateId = t.rows[0].id;
    // Two VIPs + one standard — NO segment_memberships rows are ever inserted.
    for (const [ext, tier] of [['v1', 'vip'], ['v2', 'vip'], ['s1', 'std']] as const) {
      await admin.query(
        `INSERT INTO profiles (workspace_id, external_id, email, attributes)
         VALUES ($1,$2,$3, jsonb_build_object('tier',$4::text))`,
        [ws, ext, `${ext}@example.com`, tier],
      );
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

  function deps(sqs: FakeSqs): BroadcastDeps {
    const reader: Reader = { query: (text, values) => admin.query(text, values as unknown[]) as never };
    return {
      reader,
      sqs,
      runInWorkspaceTx: (w, s) => runStatementsInWorkspaceTx(admin, w, s),
      now: () => new Date('2026-06-11T12:00:00.000Z'),
      dispatchQueueUrl: 'https://sqs/dispatch',
    };
  }

  it('reaches the rule matches (2 VIPs) with NO membership rows present', async () => {
    const s = await admin.query(
      `INSERT INTO segments (workspace_id, name, kind, status, definition)
       VALUES ($1,'VIPs','dynamic_realtime','active', $2::jsonb) RETURNING id`,
      [ws, JSON.stringify({ field: 'attributes.tier', operator: '=', value: 'vip' })],
    );
    const b = await admin.query(
      "INSERT INTO broadcasts (workspace_id, name, template_id, audience_kind, audience_ref, status) VALUES ($1,'B',$2,'segment',$3,'draft') RETURNING id",
      [ws, templateId, s.rows[0].id],
    );
    const sqs = new FakeSqs();
    const res = await runBroadcast(deps(sqs), b.rows[0].id);
    // 2 VIPs match the rule; the standard profile is excluded. No memberships exist.
    expect(res).toEqual({ result: 'sent', recipientCount: 2, batchCount: 1 });
    const n = await admin.query('SELECT count(*)::int n FROM outbox WHERE workspace_id = $1', [ws]);
    expect(n.rows[0].n).toBe(2);
    const mem = await admin.query('SELECT count(*)::int n FROM segment_memberships WHERE workspace_id = $1', [ws]);
    expect(mem.rows[0].n).toBe(0); // resolved purely from the rule
  });
});
