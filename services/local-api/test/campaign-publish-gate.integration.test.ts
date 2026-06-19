// PART A (real Postgres): PUBLISH-time gating on campaign activation. Mirrors
// sendBroadcast's ORDERED 409s per send node (sender_id -> to_address -> subject),
// naming the offending node, THEN the verified-domain gate. A campaign with no send
// node activates ungated. Cross-workspace scoping enforced (inv.2).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { hasDatabaseUrl } from '@cdp/db';
import { makeWorld, tokenFor, call, type TestWorld } from './seed.js';

const WS = '0c0d0e93-0000-4000-8000-000000000a01';
const WS_NOVERIFY = '0c0d0e93-0000-4000-8000-000000000a03';
const USER = '0c0d0e93-0000-4000-8000-0000000000b1';
const USER_NV = '0c0d0e93-0000-4000-8000-0000000000b3';
const DOMAIN = '0c0d0e93-0000-4000-8000-0000000000d1';
const SENDER = '0c0d0e93-0000-4000-8000-0000000000f1';

const describeMaybe = hasDatabaseUrl() ? describe : describe.skip;

// A campaign with a single send node referencing the given copy template.
const sendDef = (copyId: string) => ({
  startNode: 't',
  nodes: {
    t: { type: 'trigger', kind: 'manual', next: 'send' },
    send: { type: 'action', kind: 'send', template_id: copyId, next: 'x' },
    x: { type: 'exit' },
  },
});

const noSendDef = {
  startNode: 't',
  nodes: {
    t: { type: 'trigger', kind: 'manual', next: 'a' },
    a: { type: 'action', kind: 'set_attribute', key: 'tier', value: 'gold', next: 'x' },
    x: { type: 'exit' },
  },
};

describeMaybe('POST /campaigns/:id/activate — publish gating (real Postgres)', () => {
  let world: TestWorld;
  const tok = () => tokenFor(USER, WS);

  // Create a copy template with the given envelope columns; return its id.
  async function makeCopy(
    ws: string,
    env: { subject?: string | null; sender_id?: string | null; to_address?: string | null },
  ): Promise<string> {
    const r = await world.pool.query<{ id: string }>(
      `INSERT INTO email_templates (workspace_id, name, mjml, compiled_html, kind, subject, sender_id, to_address)
       VALUES ($1,'copy','<m/>','<h/>','copy',$2,$3,$4) RETURNING id`,
      [ws, env.subject ?? null, env.sender_id ?? null, env.to_address ?? null],
    );
    return r.rows[0]!.id;
  }

  async function makeCampaign(ws: string, def: unknown): Promise<string> {
    const r = await world.pool.query<{ id: string }>(
      "INSERT INTO campaigns (workspace_id, name, definition, status) VALUES ($1,'C',$2::jsonb,'draft') RETURNING id",
      [ws, JSON.stringify(def)],
    );
    return r.rows[0]!.id;
  }

  beforeAll(async () => {
    world = makeWorld();
    await cleanup();
    for (const [ws, user] of [[WS, USER], [WS_NOVERIFY, USER_NV]] as const) {
      await world.pool.query("INSERT INTO workspaces (id, name, status) VALUES ($1,'W','active')", [ws]);
      await world.pool.query("INSERT INTO workspace_users (workspace_id, user_id, role) VALUES ($1,$2,'owner')", [ws, user]);
    }
    // WS has a verified domain + a named sender; WS_NOVERIFY has neither verified.
    await world.pool.query(
      "INSERT INTO sending_domains (id, workspace_id, domain, verified) VALUES ($1,$2,'mail.a.com',true)",
      [DOMAIN, WS],
    );
    await world.pool.query(
      "INSERT INTO domain_senders (id, workspace_id, domain, name, email) VALUES ($1,$2,'mail.a.com','A','a@mail.a.com')",
      [SENDER, WS],
    );
  });

  afterAll(async () => {
    if (world) {
      await cleanup();
      await world.pool.end();
    }
  });

  async function cleanup(): Promise<void> {
    for (const ws of [WS, WS_NOVERIFY]) {
      await world.pool.query('DELETE FROM campaigns WHERE workspace_id = $1', [ws]);
      await world.pool.query('DELETE FROM email_templates WHERE workspace_id = $1', [ws]);
      await world.pool.query('DELETE FROM domain_senders WHERE workspace_id = $1', [ws]);
      await world.pool.query('DELETE FROM sending_domains WHERE workspace_id = $1', [ws]);
      await world.pool.query('DELETE FROM workspace_users WHERE workspace_id = $1', [ws]);
      await world.pool.query('DELETE FROM workspaces WHERE id = $1', [ws]);
    }
  }

  it('refuses when the send node copy has no sender_id (ordered 409 #1, names the node)', async () => {
    const copy = await makeCopy(WS, { subject: 'Hi', to_address: '{{customer.email}}', sender_id: null });
    const camp = await makeCampaign(WS, sendDef(copy));
    const res = await call(world.env, 'POST', `/campaigns/${camp}/activate`, { token: tok() });
    expect(res.status).toBe(409);
    expect((res.body as { error: string }).error).toMatch(/Choose who the email is from/i);
    expect((res.body as { error: string }).error).toContain('send'); // names the node
  });

  it('refuses when To is blank (ordered 409 #2)', async () => {
    const copy = await makeCopy(WS, { subject: 'Hi', to_address: '', sender_id: SENDER });
    const camp = await makeCampaign(WS, sendDef(copy));
    const res = await call(world.env, 'POST', `/campaigns/${camp}/activate`, { token: tok() });
    expect(res.status).toBe(409);
    expect((res.body as { error: string }).error).toMatch(/Set the To field/i);
  });

  it('refuses when the subject is blank (ordered 409 #3)', async () => {
    const copy = await makeCopy(WS, { subject: '', to_address: '{{customer.email}}', sender_id: SENDER });
    const camp = await makeCampaign(WS, sendDef(copy));
    const res = await call(world.env, 'POST', `/campaigns/${camp}/activate`, { token: tok() });
    expect(res.status).toBe(409);
    expect((res.body as { error: string }).error).toMatch(/Add a subject line/i);
  });

  it('with a fully-configured send node AND a verified domain, activation SUCCEEDS', async () => {
    const copy = await makeCopy(WS, { subject: 'Hi', to_address: '{{customer.email}}', sender_id: SENDER });
    const camp = await makeCampaign(WS, sendDef(copy));
    const res = await call(world.env, 'POST', `/campaigns/${camp}/activate`, { token: tok() });
    expect(res.status).toBe(200);
    const row = await world.pool.query<{ status: string }>('SELECT status FROM campaigns WHERE id = $1', [camp]);
    expect(row.rows[0]!.status).toBe('active');
  });

  it('verified-domain gate runs AFTER per-node envelope checks (complete envelope, no verified domain)', async () => {
    // WS_NOVERIFY: complete envelope, but no verified sending domain.
    const copy = await makeCopy(WS_NOVERIFY, { subject: 'Hi', to_address: '{{customer.email}}', sender_id: null });
    // Give it a sender so the envelope is complete; but the domain is unverified.
    const snd = await world.pool.query<{ id: string }>(
      "INSERT INTO domain_senders (workspace_id, domain, name, email) VALUES ($1,'mail.nv.com','NV','nv@mail.nv.com') RETURNING id",
      [WS_NOVERIFY],
    );
    await world.pool.query('UPDATE email_templates SET sender_id = $1 WHERE id = $2', [snd.rows[0]!.id, copy]);
    const camp = await makeCampaign(WS_NOVERIFY, sendDef(copy));
    const res = await call(world.env, 'POST', `/campaigns/${camp}/activate`, { token: tokenFor(USER_NV, WS_NOVERIFY) });
    expect(res.status).toBe(409);
    expect((res.body as { error: string }).error).toMatch(/verified sending domain/i);
  });

  it('a campaign with NO send nodes activates ungated', async () => {
    const camp = await makeCampaign(WS, noSendDef);
    const res = await call(world.env, 'POST', `/campaigns/${camp}/activate`, { token: tok() });
    expect(res.status).toBe(200);
    const row = await world.pool.query<{ status: string }>('SELECT status FROM campaigns WHERE id = $1', [camp]);
    expect(row.rows[0]!.status).toBe('active');
  });

  it('a foreign campaign id is a 404 (inv.2)', async () => {
    const copy = await makeCopy(WS, { subject: 'Hi', to_address: '{{customer.email}}', sender_id: SENDER });
    const camp = await makeCampaign(WS, sendDef(copy));
    const res = await call(world.env, 'POST', `/campaigns/${camp}/activate`, { token: tokenFor(USER_NV, WS_NOVERIFY) });
    expect(res.status).toBe(404);
  });
});
