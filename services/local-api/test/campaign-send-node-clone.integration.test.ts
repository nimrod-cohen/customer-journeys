// PART A (real Postgres): attaching a library template to a campaign SEND node
// CLONES it into an independently-editable copy (kind='copy', source_template_id);
// editing the copy never touches the library original; the send node's template_id
// points at the copy. Cross-workspace template/sender ids are refused (inv.2).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { hasDatabaseUrl } from '@cdp/db';
import { makeWorld, tokenFor, call, type TestWorld } from './seed.js';

const WS = '0c0d0e92-0000-4000-8000-000000000a01';
const WS_B = '0c0d0e92-0000-4000-8000-000000000a02';
const USER = '0c0d0e92-0000-4000-8000-0000000000b1';
const USER_B = '0c0d0e92-0000-4000-8000-0000000000b2';
const LIB = '0c0d0e92-0000-4000-8000-0000000000e1';
const LIB_B = '0c0d0e92-0000-4000-8000-0000000000e2';
const DOMAIN = '0c0d0e92-0000-4000-8000-0000000000d1';
const SENDER = '0c0d0e92-0000-4000-8000-0000000000f1';
const SENDER_B = '0c0d0e92-0000-4000-8000-0000000000f2';

const DEF = {
  startNode: 't',
  nodes: {
    t: { type: 'trigger', kind: 'manual', next: 'send' },
    send: { type: 'action', kind: 'send', template_id: LIB, next: 'x' },
    x: { type: 'exit' },
  },
};

const describeMaybe = hasDatabaseUrl() ? describe : describe.skip;

describeMaybe('POST /campaigns/:id/send-nodes/:nodeId/attach-template (real Postgres)', () => {
  let world: TestWorld;
  const tok = () => tokenFor(USER, WS);
  let camp = '';

  beforeAll(async () => {
    world = makeWorld();
    await cleanup();
    for (const [ws, user] of [[WS, USER], [WS_B, USER_B]] as const) {
      await world.pool.query("INSERT INTO workspaces (id, name, status) VALUES ($1,'W','active')", [ws]);
      await world.pool.query("INSERT INTO workspace_users (workspace_id, user_id, role) VALUES ($1,$2,'owner')", [ws, user]);
    }
    await world.pool.query(
      "INSERT INTO sending_domains (id, workspace_id, domain, verified) VALUES ($1,$2,'mail.a.com',true)",
      [DOMAIN, WS],
    );
    await world.pool.query(
      "INSERT INTO domain_senders (id, workspace_id, domain, name, email) VALUES ($1,$2,'mail.a.com','A','a@mail.a.com')",
      [SENDER, WS],
    );
    await world.pool.query(
      "INSERT INTO domain_senders (id, workspace_id, domain, name, email) VALUES ($1,$2,'mail.b.com','B','b@mail.b.com')",
      [SENDER_B, WS_B],
    );
    // A configured LIBRARY template (envelope set so the clone is sendable).
    await world.pool.query(
      `INSERT INTO email_templates (id, workspace_id, name, mjml, compiled_html, kind, subject, sender_id, to_address)
       VALUES ($1,$2,'Lib','<m/>','<h/>','library','Welcome',$3,'{{customer.email}}')`,
      [LIB, WS, SENDER],
    );
    await world.pool.query(
      "INSERT INTO email_templates (id, workspace_id, name, mjml, compiled_html, kind) VALUES ($1,$2,'LibB','<m/>','<h/>','library')",
      [LIB_B, WS_B],
    );
    camp = (
      await world.pool.query(
        "INSERT INTO campaigns (workspace_id, name, definition, status) VALUES ($1,'C',$2::jsonb,'draft') RETURNING id",
        [WS, JSON.stringify(DEF)],
      )
    ).rows[0].id;
  });

  afterAll(async () => {
    if (world) {
      await cleanup();
      await world.pool.end();
    }
  });

  async function cleanup(): Promise<void> {
    for (const ws of [WS, WS_B]) {
      await world.pool.query('DELETE FROM campaigns WHERE workspace_id = $1', [ws]);
      await world.pool.query('DELETE FROM email_templates WHERE workspace_id = $1', [ws]);
      await world.pool.query('DELETE FROM domain_senders WHERE workspace_id = $1', [ws]);
      await world.pool.query('DELETE FROM sending_domains WHERE workspace_id = $1', [ws]);
      await world.pool.query('DELETE FROM workspace_users WHERE workspace_id = $1', [ws]);
      await world.pool.query('DELETE FROM workspaces WHERE id = $1', [ws]);
    }
  }

  it('clones the library template (kind=copy, source_template_id), points the node at the copy', async () => {
    const res = await call(world.env, 'POST', `/campaigns/${camp}/send-nodes/send/attach-template`, {
      token: tok(),
      body: { template_id: LIB },
    });
    expect(res.status).toBe(201);
    const copyId = (res.body as { template: { id: string } }).template.id;
    expect(copyId).not.toBe(LIB);

    const copy = await world.pool.query<{
      kind: string;
      source_template_id: string;
      subject: string;
      sender_id: string;
      to_address: string;
    }>('SELECT kind, source_template_id, subject, sender_id, to_address FROM email_templates WHERE id = $1', [copyId]);
    expect(copy.rows[0]!.kind).toBe('copy');
    expect(copy.rows[0]!.source_template_id).toBe(LIB);
    // Envelope columns copied from the source (configured library → sendable copy).
    expect(copy.rows[0]!.subject).toBe('Welcome');
    expect(copy.rows[0]!.sender_id).toBe(SENDER);
    expect(copy.rows[0]!.to_address).toBe('{{customer.email}}');

    // The send node now references the COPY.
    const def = await world.pool.query<{ definition: { nodes: Record<string, { template_id?: string }> } }>(
      'SELECT definition FROM campaigns WHERE id = $1',
      [camp],
    );
    expect(def.rows[0]!.definition.nodes.send!.template_id).toBe(copyId);

    // Editing the copy does NOT change the library original.
    await world.pool.query("UPDATE email_templates SET subject = 'Edited copy' WHERE id = $1", [copyId]);
    const lib = await world.pool.query<{ subject: string }>('SELECT subject FROM email_templates WHERE id = $1', [LIB]);
    expect(lib.rows[0]!.subject).toBe('Welcome'); // unchanged
  });

  it('cross-workspace template_id is REFUSED (404) — no copy created', async () => {
    const before = await world.pool.query("SELECT count(*)::int AS n FROM email_templates WHERE workspace_id = $1 AND kind = 'copy'", [WS]);
    const res = await call(world.env, 'POST', `/campaigns/${camp}/send-nodes/send/attach-template`, {
      token: tok(),
      body: { template_id: LIB_B }, // belongs to WS_B
    });
    expect(res.status).toBe(404);
    const after = await world.pool.query("SELECT count(*)::int AS n FROM email_templates WHERE workspace_id = $1 AND kind = 'copy'", [WS]);
    expect((after.rows[0] as { n: number }).n).toBe((before.rows[0] as { n: number }).n);
  });

  it('a foreign campaign id is a 404 (inv.2)', async () => {
    const res = await call(world.env, 'POST', `/campaigns/${camp}/send-nodes/send/attach-template`, {
      token: tokenFor(USER_B, WS_B),
      body: { template_id: LIB_B },
    });
    expect(res.status).toBe(404);
  });
});
