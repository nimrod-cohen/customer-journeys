// Broadcasts can be created (draft/scheduled) and EDITED only while draft or
// scheduled — a sent broadcast is immutable. Scoped to the token's workspace.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { hasDatabaseUrl } from '@cdp/db';
import { makeWorld, tokenFor, call, type TestWorld } from './seed.js';

const WS = '0c0d0e11-0000-4000-8000-000000000a01';
const OTHER = '0c0d0e11-0000-4000-8000-000000000a02';
const USER = '0c0d0e11-0000-4000-8000-0000000000b1';
const SEG = '0c0d0e11-0000-4000-8000-0000000000d1';

const describeMaybe = hasDatabaseUrl() ? describe : describe.skip;

describeMaybe('broadcast create + edit (real Postgres)', () => {
  let world: TestWorld;
  let tpl = '';
  const tok = () => tokenFor(USER, WS);

  beforeAll(async () => {
    world = makeWorld();
    await cleanup();
    for (const ws of [WS, OTHER]) {
      await world.pool.query("INSERT INTO workspaces (id, name, status) VALUES ($1,'W','active')", [ws]);
    }
    await world.pool.query("INSERT INTO workspace_users (workspace_id, user_id, role) VALUES ($1,$2,'owner')", [WS, USER]);
    await world.pool.query("INSERT INTO segments (id, workspace_id, name, kind, status) VALUES ($1,$2,'seg','manual','active')", [SEG, WS]);
    tpl = (await world.pool.query(
      "INSERT INTO email_templates (workspace_id, name, mjml, compiled_html) VALUES ($1,'t','<m/>','<h/>') RETURNING id",
      [WS],
    )).rows[0].id;
  });

  afterAll(async () => {
    if (world) { await cleanup(); await world.pool.end(); }
  });

  async function cleanup(): Promise<void> {
    await world.pool.query('DELETE FROM broadcasts WHERE workspace_id = ANY($1)', [[WS, OTHER]]);
    await world.pool.query('DELETE FROM email_templates WHERE workspace_id = $1', [WS]);
    await world.pool.query('DELETE FROM segments WHERE workspace_id = $1', [WS]);
    await world.pool.query('DELETE FROM workspace_users WHERE workspace_id = $1', [WS]);
    for (const ws of [WS, OTHER]) await world.pool.query('DELETE FROM workspaces WHERE id = $1', [ws]);
  }

  it('creates a draft, then GET returns it', async () => {
    const c = await call(world.env, 'POST', '/broadcasts', {
      token: tok(),
      body: { name: 'B1', audience_kind: 'segment', audience_ref: SEG, template_id: tpl },
    });
    expect(c.status).toBe(201);
    const id = (c.body as { broadcast: { id: string; status: string } }).broadcast.id;
    expect((c.body as { broadcast: { status: string } }).broadcast.status).toBe('draft');

    const g = await call(world.env, 'GET', `/broadcasts/${id}`, { token: tok() });
    const b = (g.body as { broadcast: { name: string; audience_ref: string; template_id: string } }).broadcast;
    expect(b.name).toBe('B1');
    expect(b.audience_ref).toBe(SEG);
    expect(b.template_id).toBe(tpl);

    // The list endpoint (newest-first) returns it (guards the scoped ORDER BY SQL).
    const list = await call(world.env, 'GET', '/broadcasts', { token: tok() });
    expect(list.status).toBe(200);
    const rows = (list.body as { broadcasts: Array<{ id: string }> }).broadcasts;
    expect(rows.some((r) => r.id === id)).toBe(true);
  });

  it('a scheduled_at flips status to scheduled; editing name persists', async () => {
    const c = await call(world.env, 'POST', '/broadcasts', {
      token: tok(), body: { name: 'B2', audience_kind: 'segment', audience_ref: SEG, template_id: tpl },
    });
    const id = (c.body as { broadcast: { id: string } }).broadcast.id;

    await call(world.env, 'PUT', `/broadcasts/${id}`, {
      token: tok(),
      body: { name: 'B2 renamed', audience_kind: 'segment', audience_ref: SEG, template_id: tpl, scheduled_at: '2099-01-01T10:00:00Z' },
    });
    const g = await call(world.env, 'GET', `/broadcasts/${id}`, { token: tok() });
    const b = (g.body as { broadcast: { name: string; status: string; scheduled_at: string | null } }).broadcast;
    expect(b.name).toBe('B2 renamed');
    expect(b.status).toBe('scheduled');
    expect(b.scheduled_at).not.toBeNull();
  });

  it('a SENT broadcast cannot be edited (409)', async () => {
    const c = await call(world.env, 'POST', '/broadcasts', {
      token: tok(), body: { name: 'B3', audience_kind: 'segment', audience_ref: SEG, template_id: tpl },
    });
    const id = (c.body as { broadcast: { id: string } }).broadcast.id;
    await world.pool.query("UPDATE broadcasts SET status='sent', sent_at=now() WHERE id=$1", [id]);
    const r = await call(world.env, 'PUT', `/broadcasts/${id}`, {
      token: tok(), body: { name: 'nope', audience_ref: SEG, audience_kind: 'segment', template_id: tpl },
    });
    expect(r.status).toBe(409);
  });

  it('cross-workspace GET/PUT is 404 (never another tenant)', async () => {
    const c = await call(world.env, 'POST', '/broadcasts', {
      token: tok(), body: { name: 'B4', audience_kind: 'segment', audience_ref: SEG, template_id: tpl },
    });
    const id = (c.body as { broadcast: { id: string } }).broadcast.id;
    const other = tokenFor(USER, OTHER); // USER has no membership in OTHER
    expect([403, 404]).toContain((await call(world.env, 'GET', `/broadcasts/${id}`, { token: other })).status);
  });
});
