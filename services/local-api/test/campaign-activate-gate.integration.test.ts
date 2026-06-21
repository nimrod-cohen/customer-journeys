// Integration (real Postgres): PUBLISH validation extras for §9B phase 6 that the
// SPA's inline reasoning depends on (the ordered envelope 409s + verified-domain
// gate are covered by campaign-publish-gate.integration.test.ts; this file pins the
// MACHINE-USABLE 409 body {error,node,missing} and the TYPED-4xx-not-500 behavior
// when the STORED definition is structurally invalid or the trigger is incomplete).
// Workspace-scoped (inv.1/inv.2); never mocks the DB.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { hasDatabaseUrl } from '@cdp/db';
import { makeWorld, tokenFor, call, type TestWorld } from './seed.js';

const WS = '0c0d0e96-0000-4000-8000-000000000a01';
const USER = '0c0d0e96-0000-4000-8000-0000000000b1';
const DOMAIN = '0c0d0e96-0000-4000-8000-0000000000d1';
const SENDER = '0c0d0e96-0000-4000-8000-0000000000f1';

const describeMaybe = hasDatabaseUrl() ? describe : describe.skip;

const sendDef = (copyId: string) => ({
  startNode: 't',
  nodes: {
    t: { type: 'trigger', kind: 'manual', next: 'send' },
    send: { type: 'action', kind: 'send', template_id: copyId, next: 'x' },
    x: { type: 'exit' },
  },
});

describeMaybe('POST /campaigns/:id/activate — machine-usable body + typed errors (real Postgres)', () => {
  let world: TestWorld;
  const tok = () => tokenFor(USER, WS);

  async function makeCopy(env: { subject?: string | null; sender_id?: string | null; to_address?: string | null }): Promise<string> {
    const r = await world.pool.query<{ id: string }>(
      `INSERT INTO email_templates (workspace_id, name, mjml, compiled_html, kind, subject, sender_id, to_address)
       VALUES ($1,'copy','<m/>','<h/>','copy',$2,$3,$4) RETURNING id`,
      [WS, env.subject ?? null, env.sender_id ?? null, env.to_address ?? null],
    );
    return r.rows[0]!.id;
  }

  async function makeCampaign(def: unknown): Promise<string> {
    const r = await world.pool.query<{ id: string }>(
      "INSERT INTO campaigns (workspace_id, name, definition, status) VALUES ($1,'C',$2::jsonb,'draft') RETURNING id",
      [WS, JSON.stringify(def)],
    );
    return r.rows[0]!.id;
  }

  beforeAll(async () => {
    world = makeWorld();
    await cleanup();
    await world.pool.query("INSERT INTO workspaces (id, name, status) VALUES ($1,'W','active')", [WS]);
    await world.pool.query("INSERT INTO workspace_users (workspace_id, user_id, role) VALUES ($1,$2,'owner')", [WS, USER]);
    await world.pool.query("INSERT INTO sending_domains (id, workspace_id, domain, verified) VALUES ($1,$2,'mail.a.com',true)", [DOMAIN, WS]);
    await world.pool.query("INSERT INTO domain_senders (id, workspace_id, domain, name, email) VALUES ($1,$2,'mail.a.com','A','a@mail.a.com')", [SENDER, WS]);
  });

  afterAll(async () => {
    if (world) {
      await cleanup();
      await world.pool.end();
    }
  });

  async function cleanup(): Promise<void> {
    await world.pool.query('DELETE FROM campaigns WHERE workspace_id = $1', [WS]);
    await world.pool.query('DELETE FROM email_templates WHERE workspace_id = $1', [WS]);
    await world.pool.query('DELETE FROM domain_senders WHERE workspace_id = $1', [WS]);
    await world.pool.query('DELETE FROM sending_domains WHERE workspace_id = $1', [WS]);
    await world.pool.query('DELETE FROM workspace_users WHERE workspace_id = $1', [WS]);
    await world.pool.query('DELETE FROM workspaces WHERE id = $1', [WS]);
  }

  it('the missing-sender 409 carries {error, node, missing:"sender"} for inline rendering', async () => {
    const copy = await makeCopy({ subject: 'Hi', to_address: '{{customer.email}}', sender_id: null });
    const camp = await makeCampaign(sendDef(copy));
    const res = await call(world.env, 'POST', `/campaigns/${camp}/activate`, { token: tok() });
    expect(res.status).toBe(409);
    const body = res.body as { error: string; node?: string; missing?: string };
    expect(body.node).toBe('send');
    expect(body.missing).toBe('sender');
    expect(body.error).toMatch(/Choose who the email is from/i);
  });

  it('the missing-To then missing-Subject 409s carry the matching `missing` discriminator', async () => {
    const noTo = await makeCampaign(sendDef(await makeCopy({ subject: 'Hi', to_address: '', sender_id: SENDER })));
    const r1 = await call(world.env, 'POST', `/campaigns/${noTo}/activate`, { token: tok() });
    expect(r1.status).toBe(409);
    expect((r1.body as { missing?: string }).missing).toBe('to');

    const noSubj = await makeCampaign(sendDef(await makeCopy({ subject: '', to_address: '{{customer.email}}', sender_id: SENDER })));
    const r2 = await call(world.env, 'POST', `/campaigns/${noSubj}/activate`, { token: tok() });
    expect(r2.status).toBe(409);
    expect((r2.body as { missing?: string }).missing).toBe('subject');
  });

  it('the verified-domain 409 carries missing:"verified_domain"', async () => {
    // Complete envelope but temporarily un-verify the domain.
    const copy = await makeCopy({ subject: 'Hi', to_address: '{{customer.email}}', sender_id: SENDER });
    const camp = await makeCampaign(sendDef(copy));
    await world.pool.query('UPDATE sending_domains SET verified = false WHERE id = $1', [DOMAIN]);
    const res = await call(world.env, 'POST', `/campaigns/${camp}/activate`, { token: tok() });
    await world.pool.query('UPDATE sending_domains SET verified = true WHERE id = $1', [DOMAIN]);
    expect(res.status).toBe(409);
    expect((res.body as { missing?: string }).missing).toBe('verified_domain');
  });

  it('a STRUCTURALLY INVALID stored definition is a TYPED 400 (not 500); status stays draft', async () => {
    // condition missing onFalse — slipped past via a direct INSERT.
    const camp = await makeCampaign({ startNode: 't', nodes: { t: { type: 'trigger', kind: 'manual', next: 'c' }, c: { type: 'condition', ast: { field: 'x', operator: 'exists' }, onTrue: 'x' }, x: { type: 'exit' } } });
    const res = await call(world.env, 'POST', `/campaigns/${camp}/activate`, { token: tok() });
    expect(res.status).toBe(400);
    expect(typeof (res.body as { error?: string }).error).toBe('string');
    const row = await world.pool.query<{ status: string }>('SELECT status FROM campaigns WHERE id = $1', [camp]);
    expect(row.rows[0]!.status).toBe('draft');
  });

  it('an INCOMPLETE event trigger (no eventType) is a TYPED 400 on activate, not 500', async () => {
    const camp = await makeCampaign({ startNode: 't', nodes: { t: { type: 'trigger', kind: 'event', next: 'x' }, x: { type: 'exit' } } });
    const res = await call(world.env, 'POST', `/campaigns/${camp}/activate`, { token: tok() });
    expect(res.status).toBe(400);
    expect(typeof (res.body as { error?: string }).error).toBe('string');
    const row = await world.pool.query<{ status: string }>('SELECT status FROM campaigns WHERE id = $1', [camp]);
    expect(row.rows[0]!.status).toBe('draft');
  });

  // ── multi-channel publish gate (v0.54.0) ──────────────────────────────────────

  const smsDef = (body: string) => ({
    startNode: 't',
    nodes: {
      t: { type: 'trigger', kind: 'manual', next: 'send' },
      send: { type: 'action', kind: 'send', medium: 'sms', text_body: body, next: 'x' },
      x: { type: 'exit' },
    },
  });

  it('a TEXT (sms) send with a BLANK body is REFUSED (typed 4xx, naming text_body); stays draft', async () => {
    const camp = await makeCampaign(smsDef('   '));
    const res = await call(world.env, 'POST', `/campaigns/${camp}/activate`, { token: tok() });
    expect(res.status).toBe(400);
    expect((res.body as { error?: string }).error).toMatch(/text_body/i);
    const row = await world.pool.query<{ status: string }>('SELECT status FROM campaigns WHERE id = $1', [camp]);
    expect(row.rows[0]!.status).toBe('draft');
  });

  it('a configured TEXT campaign ACTIVATES with NO verified sending domain (text skips the email/domain gate)', async () => {
    // Un-verify the only domain — a text campaign must still activate.
    await world.pool.query('UPDATE sending_domains SET verified = false WHERE id = $1', [DOMAIN]);
    const camp = await makeCampaign(smsDef('Hi {{customer.first_name}}!'));
    const res = await call(world.env, 'POST', `/campaigns/${camp}/activate`, { token: tok() });
    await world.pool.query('UPDATE sending_domains SET verified = true WHERE id = $1', [DOMAIN]);
    expect(res.status).toBe(200);
    expect((res.body as { status?: string }).status).toBe('active');
    const row = await world.pool.query<{ status: string }>('SELECT status FROM campaigns WHERE id = $1', [camp]);
    expect(row.rows[0]!.status).toBe('active');
  });
});
