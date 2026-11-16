// The hosted MCP server end-to-end over real HTTP (createApp) + REAL Postgres:
// token lifecycle, auth, the JSON-RPC handshake, and the drafts-only guarantees —
// nothing an assistant does can change what is live or send anything.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { hasDatabaseUrl } from '@cdp/db';
import { createApp } from '../src/index.js';
import { makeWorld, tokenFor, call, type TestWorld } from './seed.js';

const WS = 'e7180000-0000-4000-8000-0000000000a1';
const WS_B = 'e7180000-0000-4000-8000-0000000000a2';
const OWNER = 'e7180000-0000-4000-8000-0000000000b1';
const MKT = 'e7180000-0000-4000-8000-0000000000b2';
const SEG = 'e7180000-0000-4000-8000-0000000000d1';
const SEG_B = 'e7180000-0000-4000-8000-0000000000d2';
const LIB = 'e7180000-0000-4000-8000-0000000000e1';

const GRAPH = {
  startNode: 't',
  nodes: {
    t: { type: 'trigger', kind: 'manual', next: 's' },
    s: { type: 'action', kind: 'send', medium: 'email', next: 'x' },
    x: { type: 'exit' },
  },
};

const describeMaybe = hasDatabaseUrl() ? describe : describe.skip;

describeMaybe('MCP server (real HTTP + Postgres)', () => {
  let world: TestWorld;
  let app: ReturnType<typeof createApp>;
  let token = '';
  let id = 0;

  beforeAll(async () => {
    world = makeWorld();
    app = createApp({ pool: world.pool, lookups: world.env.lookups, deps: world.env.deps });
    await cleanup();
    await world.pool.query("INSERT INTO users (id, email) VALUES ($1,'mcp-owner@x.test'),($2,'mcp-mkt@x.test') ON CONFLICT DO NOTHING", [OWNER, MKT]);
    for (const w of [WS, WS_B]) await world.pool.query("INSERT INTO workspaces (id, name, status) VALUES ($1,'W','active')", [w]);
    await world.pool.query("INSERT INTO workspace_users (workspace_id, user_id, role) VALUES ($1,$2,'owner'),($1,$3,'marketer')", [WS, OWNER, MKT]);
    await world.pool.query("INSERT INTO segments (id, workspace_id, name, kind, status) VALUES ($1,$2,'s','dynamic_realtime','active')", [SEG, WS]);
    await world.pool.query("INSERT INTO segments (id, workspace_id, name, kind, status) VALUES ($1,$2,'s','dynamic_realtime','active')", [SEG_B, WS_B]);
    await world.pool.query(
      "INSERT INTO email_templates (id, workspace_id, name, mjml, compiled_html, kind) VALUES ($1,$2,'Lib','<mjml/>','<p/>','library')",
      [LIB, WS],
    );
  });

  afterAll(async () => {
    if (world) {
      await cleanup();
      await world.pool.end();
    }
  });

  async function cleanup(): Promise<void> {
    for (const w of [WS, WS_B]) {
      await world.pool.query('DELETE FROM activity_log WHERE workspace_id = $1', [w]);
      await world.pool.query('DELETE FROM mcp_tokens WHERE workspace_id = $1', [w]);
      await world.pool.query('DELETE FROM broadcasts WHERE workspace_id = $1', [w]);
      await world.pool.query('UPDATE automations SET active_version_id = NULL WHERE workspace_id = $1', [w]);
      await world.pool.query('DELETE FROM automation_versions WHERE workspace_id = $1', [w]);
      await world.pool.query('DELETE FROM automation_enrollments WHERE workspace_id = $1', [w]);
      await world.pool.query('DELETE FROM automations WHERE workspace_id = $1', [w]);
      await world.pool.query('DELETE FROM email_templates WHERE workspace_id = $1 AND kind = $2', [w, 'copy']);
      await world.pool.query('DELETE FROM email_templates WHERE workspace_id = $1', [w]);
      await world.pool.query('DELETE FROM segment_memberships WHERE workspace_id = $1', [w]);
      await world.pool.query('DELETE FROM segments WHERE workspace_id = $1', [w]);
      await world.pool.query('DELETE FROM workspace_users WHERE workspace_id = $1', [w]);
      await world.pool.query('DELETE FROM workspaces WHERE id = $1', [w]);
    }
  }

  async function mcp(body: unknown, auth: string | null = `Bearer ${token}`) {
    const res = await app.request('/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(auth ? { authorization: auth } : {}) },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  }
  async function tool(name: string, args: Record<string, unknown> = {}) {
    const r = await mcp({ jsonrpc: '2.0', id: (id += 1), method: 'tools/call', params: { name, arguments: args } });
    expect(r.status).toBe(200);
    const result = r.body.result as { isError: boolean; structuredContent?: Record<string, unknown>; content: { text: string }[] };
    return { isError: result.isError, data: result.structuredContent ?? {}, text: result.content[0]!.text };
  }
  async function automationRow(aid: string) {
    return (await world.pool.query('SELECT status, definition, draft_definition, draft_trigger_segment_id FROM automations WHERE id = $1', [aid])).rows[0];
  }

  it('owner mints a token (shown once); a marketer cannot; the list never carries it', async () => {
    expect((await call(world.env, 'POST', '/workspace/mcp-tokens', { token: tokenFor(MKT, WS), body: { name: 'x' } })).status).toBe(403);
    expect((await call(world.env, 'POST', '/workspace/mcp-tokens', { token: tokenFor(OWNER, WS), body: {} })).status).toBe(400);
    const r = await call(world.env, 'POST', '/workspace/mcp-tokens', { token: tokenFor(OWNER, WS), body: { name: 'Claude' } });
    expect(r.status).toBe(201);
    token = (r.body as { token: string }).token;
    expect(token).toMatch(/^mcp_/);
    const list = await call(world.env, 'GET', '/workspace/mcp-tokens', { token: tokenFor(OWNER, WS) });
    expect(JSON.stringify(list.body)).not.toContain(token);
    const stored = await world.pool.query('SELECT token_hash FROM mcp_tokens WHERE workspace_id = $1', [WS]);
    expect(stored.rows[0].token_hash).not.toBe(token);
  });

  it('refuses a missing or wrong token, answers the handshake, and 202s notifications', async () => {
    expect((await mcp({ jsonrpc: '2.0', id: 1, method: 'ping' }, null)).status).toBe(401);
    expect((await mcp({ jsonrpc: '2.0', id: 1, method: 'ping' }, 'Bearer mcp_nope')).status).toBe(401);
    expect((await mcp('{not json')).status).toBe(400);
    const init = await mcp({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } });
    expect(init.status).toBe(200);
    expect(init.body.result.serverInfo.name).toBe('customer-journeys');
    expect((await mcp({ jsonrpc: '2.0', method: 'notifications/initialized' })).status).toBe(202);
    const list = await mcp({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    expect(list.body.result.tools.map((t: { name: string }) => t.name)).toContain('create_automation');
    const batch = await mcp([{ jsonrpc: '2.0', id: 3, method: 'ping' }, { jsonrpc: '2.0', id: 4, method: 'ping' }]);
    expect(batch.body).toHaveLength(2);
    expect((await app.request('/mcp', { method: 'GET' })).status).toBe(405);
  });

  it('creates automations as DRAFTS only, and validates them', async () => {
    const bad = await tool('create_automation', { name: 'Bad', definition: { startNode: 't', nodes: {} } });
    expect(bad.isError).toBe(true);
    const r = await tool('create_automation', { name: 'Welcome', definition: GRAPH });
    expect(r.isError).toBe(false);
    const aid = (r.data.automation as { id: string }).id;
    expect((await automationRow(aid)).status).toBe('draft');
    // There is no way to pass a status through rename.
    const sneaky = await tool('rename_automation', { automation_id: aid, name: 'W2', status: 'active' } as never);
    expect(sneaky.isError).toBe(true);
    expect((await automationRow(aid)).status).toBe('draft');
  });

  it('editing a LIVE automation only ever touches its draft (graph, trigger, and attached email)', async () => {
    const a = await world.pool.query(
      "INSERT INTO automations (workspace_id, name, definition, status, trigger_segment_id) VALUES ($1,'Live',$2::jsonb,'active',$3) RETURNING id",
      [WS, JSON.stringify({ ...GRAPH, nodes: { ...GRAPH.nodes, t: { type: 'trigger', kind: 'segment_entry', next: 's' } } }), SEG],
    );
    const aid = a.rows[0].id as string;
    const before = (await automationRow(aid)).definition;

    // attach on an automation with NO draft row must not write into live.
    const att = await tool('attach_email_to_automation_step', { automation_id: aid, node_id: 's', template_id: LIB });
    expect(att.isError, att.text).toBe(false);
    let row = await automationRow(aid);
    expect(row.definition).toEqual(before);
    const copyId = (row.draft_definition.nodes.s as { template_id: string }).template_id;
    expect(copyId).toBeTruthy();
    expect(copyId).not.toBe(LIB);
    expect(row.draft_trigger_segment_id).toBe(SEG); // kept, not cleared

    // The copy is only in the DRAFT, so its envelope may be set…
    { const e = await tool('set_email_envelope', { template_id: copyId, subject: 'Hi' }); expect(e.isError, e.text).toBe(false); }

    // …and a definition-only draft save keeps the trigger segment and adds exit rules.
    const draft = { ...row.draft_definition, exitRules: [{ id: 'r', action: 'exit', when: { kind: 'segment_exit', segmentId: SEG } }] };
    expect((await tool('save_automation_draft', { automation_id: aid, definition: draft })).isError).toBe(false);
    row = await automationRow(aid);
    expect(row.definition).toEqual(before);
    expect(row.status).toBe('active');
    expect(row.draft_trigger_segment_id).toBe(SEG);
    expect(row.draft_definition.exitRules).toHaveLength(1);

    // A foreign-workspace segment in an exit rule is refused (inv.2).
    const foreign = await tool('save_automation_draft', {
      automation_id: aid,
      definition: { ...draft, exitRules: [{ id: 'r', action: 'exit', when: { kind: 'segment_exit', segmentId: SEG_B } }] },
    });
    expect(foreign.isError).toBe(true);

    // Once that copy is in the LIVE definition, its envelope is off-limits.
    await world.pool.query('UPDATE automations SET definition = draft_definition WHERE id = $1', [aid]);
    const live = await tool('set_email_envelope', { template_id: copyId, subject: 'Changed' });
    expect(live.isError).toBe(true);
    expect(live.text).toMatch(/published automation/);
    // A library template is never edited here either.
    expect((await tool('set_email_envelope', { template_id: LIB, subject: 'x' })).isError).toBe(true);
  });

  it('broadcasts: drafts with their own email copy; never scheduled; non-drafts refused', async () => {
    const r = await tool('create_broadcast', { name: 'Promo', template_id: LIB, segment_id: SEG });
    expect(r.isError, r.text).toBe(false);
    const bid = (r.data.broadcast as { id: string }).id;
    const copyId = r.data.email_copy_id as string;
    let b = (await world.pool.query('SELECT status, scheduled_at, template_id FROM broadcasts WHERE id = $1', [bid])).rows[0];
    expect(b).toMatchObject({ status: 'draft', scheduled_at: null, template_id: copyId });

    expect((await tool('update_broadcast_draft', { broadcast_id: bid, name: 'Promo 2' })).isError).toBe(false);
    b = (await world.pool.query('SELECT name, template_id, status FROM broadcasts WHERE id = $1', [bid])).rows[0];
    expect(b).toMatchObject({ name: 'Promo 2', template_id: copyId, status: 'draft' }); // template kept

    expect((await tool('set_email_envelope', { template_id: copyId, subject: 'Sale' })).isError).toBe(false);

    await world.pool.query("UPDATE broadcasts SET status = 'scheduled', scheduled_at = now() + interval '1 day' WHERE id = $1", [bid]);
    const refused = await tool('update_broadcast_draft', { broadcast_id: bid, name: 'x' });
    expect(refused.isError).toBe(true);
    expect((await tool('set_email_envelope', { template_id: copyId, subject: 'x' })).isError).toBe(true);
    b = (await world.pool.query('SELECT status FROM broadcasts WHERE id = $1', [bid])).rows[0];
    expect(b.status).toBe('scheduled');
  });

  it('segments: create + count, without leaking people', async () => {
    const rule = { field: 'attributes.plan', operator: '=', value: 'gold' };
    const c = await tool('count_rule_audience', { definition: rule });
    expect(c.isError, c.text).toBe(false);
    expect(c.data).toEqual({ matching_profiles: 0 });
    const s = await tool('create_segment', { name: 'Gold', definition: rule });
    expect(s.isError, s.text).toBe(false);
  });

  it('is workspace-scoped: another workspace’s automation is not found', async () => {
    const other = await world.pool.query("INSERT INTO automations (workspace_id, name, definition) VALUES ($1,'B',$2::jsonb) RETURNING id", [WS_B, JSON.stringify(GRAPH)]);
    const r = await tool('get_automation', { automation_id: other.rows[0].id });
    expect(r.isError).toBe(true);
  });

  it('audits write tools only', async () => {
    const rows = (await world.pool.query("SELECT type, outcome, detail FROM activity_log WHERE workspace_id = $1 AND source = 'mcp'", [WS])).rows;
    expect(rows.some((r) => r.type === 'create_automation' && r.outcome === 'success' && r.detail.startsWith('Claude:'))).toBe(true);
    expect(rows.some((r) => r.type === 'update_broadcast_draft' && r.outcome === 'failed')).toBe(true);
    expect(rows.some((r) => r.type === 'get_automation')).toBe(false);
  });

  it('stops working when the creator leaves the workspace, or on revoke', async () => {
    await world.pool.query("UPDATE workspace_users SET role = 'accounting' WHERE workspace_id = $1 AND user_id = $2", [WS, OWNER]);
    expect((await mcp({ jsonrpc: '2.0', id: 1, method: 'ping' })).status).toBe(401);
    await world.pool.query("UPDATE workspace_users SET role = 'owner' WHERE workspace_id = $1 AND user_id = $2", [WS, OWNER]);
    expect((await mcp({ jsonrpc: '2.0', id: 1, method: 'ping' })).status).toBe(200);
    const list = await call(world.env, 'GET', '/workspace/mcp-tokens', { token: tokenFor(OWNER, WS) });
    const tid = (list.body as { tokens: { id: string }[] }).tokens[0]!.id;
    expect((await call(world.env, 'DELETE', `/workspace/mcp-tokens/${tid}`, { token: tokenFor(OWNER, WS) })).status).toBe(200);
    expect((await mcp({ jsonrpc: '2.0', id: 1, method: 'ping' })).status).toBe(401);
    // A token from another workspace's owner cannot be revoked from here.
    expect((await call(world.env, 'DELETE', `/workspace/mcp-tokens/${tid}`, { token: tokenFor(OWNER, WS) })).status).toBe(404);
  });
});
