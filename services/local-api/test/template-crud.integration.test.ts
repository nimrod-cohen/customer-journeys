// Email templates can be created, loaded, and updated (the editor's save/load).
// REAL Postgres; MJML is recompiled server-side on write.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { hasDatabaseUrl } from '@cdp/db';
import { makeWorld, tokenFor, call, type TestWorld } from './seed.js';

const WS = '0c0d0e12-0000-4000-8000-000000000a01';
const OTHER = '0c0d0e12-0000-4000-8000-000000000a02';
const USER = '0c0d0e12-0000-4000-8000-0000000000b1';
const MJML = '<mjml><mj-body><mj-section><mj-column><mj-text>hi</mj-text></mj-column></mj-section></mj-body></mjml>';

const describeMaybe = hasDatabaseUrl() ? describe : describe.skip;

describeMaybe('email template CRUD (real Postgres)', () => {
  let world: TestWorld;
  const tok = () => tokenFor(USER, WS);

  beforeAll(async () => {
    world = makeWorld();
    await cleanup();
    for (const ws of [WS, OTHER]) {
      await world.pool.query("INSERT INTO workspaces (id, name, status) VALUES ($1,'W','active')", [ws]);
    }
    await world.pool.query("INSERT INTO workspace_users (workspace_id, user_id, role) VALUES ($1,$2,'owner')", [WS, USER]);
  });

  afterAll(async () => {
    if (world) { await cleanup(); await world.pool.end(); }
  });

  async function cleanup(): Promise<void> {
    await world.pool.query('DELETE FROM email_templates WHERE workspace_id = ANY($1)', [[WS, OTHER]]);
    await world.pool.query('DELETE FROM workspace_users WHERE workspace_id = $1', [WS]);
    for (const ws of [WS, OTHER]) await world.pool.query('DELETE FROM workspaces WHERE id = $1', [ws]);
  }

  it('create → get → update → list reflects the change', async () => {
    const c = await call(world.env, 'POST', '/templates', { token: tok(), body: { name: 'Welcome', mjml: MJML } });
    expect(c.status).toBe(201);
    const id = (c.body as { template: { id: string } }).template.id;

    const g = await call(world.env, 'GET', `/templates/${id}`, { token: tok() });
    const t = (g.body as { template: { name: string; mjml: string } }).template;
    expect(t.name).toBe('Welcome');
    expect(t.mjml).toContain('<mj-text>hi</mj-text>');

    const u = await call(world.env, 'PUT', `/templates/${id}`, {
      token: tok(),
      body: { name: 'Welcome v2', mjml: MJML.replace('hi', 'hello') },
    });
    expect(u.status).toBe(200);

    const g2 = await call(world.env, 'GET', `/templates/${id}`, { token: tok() });
    const t2 = (g2.body as { template: { name: string; mjml: string } }).template;
    expect(t2.name).toBe('Welcome v2');
    expect(t2.mjml).toContain('hello');

    // compiled_html was recompiled server-side from the new MJML.
    const row = await world.pool.query<{ compiled_html: string }>(
      'SELECT compiled_html FROM email_templates WHERE id = $1',
      [id],
    );
    expect(row.rows[0]!.compiled_html).toContain('hello');

    const list = await call(world.env, 'GET', '/templates', { token: tok() });
    expect((list.body as { templates: Array<{ id: string }> }).templates.some((x) => x.id === id)).toBe(true);
  });

  it('duplicate makes a new LIBRARY template with the same design, named "(copy)", without the API key', async () => {
    const c = await call(world.env, 'POST', '/templates', {
      token: tok(),
      body: { name: 'Promo', mjml: MJML, design: { rows: [1] }, subject: 'Hi there' },
    });
    const id = (c.body as { template: { id: string } }).template.id;
    await call(world.env, 'PUT', `/templates/${id}/transactional-key`, {
      token: tok(),
      body: { transactional_key: 'dup-src' },
    });

    const d = await call(world.env, 'POST', `/templates/${id}/duplicate`, { token: tok() });
    expect(d.status).toBe(201);
    const dup = (d.body as { template: { id: string; name: string } }).template;
    expect(dup.id).not.toBe(id);
    expect(dup.name).toBe('Promo (copy)');

    const row = await world.pool.query(
      'SELECT kind, source_template_id, design, subject, transactional_key, compiled_html FROM email_templates WHERE id = $1',
      [dup.id],
    );
    const r = row.rows[0]!;
    expect(r.kind).toBe('library');
    expect(r.source_template_id).toBeNull();
    expect(r.design).toEqual({ rows: [1] });
    expect(r.subject).toBe('Hi there');
    // The key is unique per workspace — the copy must not take it.
    expect(r.transactional_key).toBeNull();
    expect(r.compiled_html).toContain('hi');

    const list = await call(world.env, 'GET', '/templates', { token: tok() });
    expect((list.body as { templates: Array<{ id: string }> }).templates.some((x) => x.id === dup.id)).toBe(true);
  });

  it('duplicating a foreign or unknown template is 404', async () => {
    const foreign = await world.pool.query<{ id: string }>(
      "INSERT INTO email_templates (workspace_id, name, mjml, compiled_html) VALUES ($1,'F',$2,'') RETURNING id",
      [OTHER, MJML],
    );
    const d = await call(world.env, 'POST', `/templates/${foreign.rows[0]!.id}/duplicate`, { token: tok() });
    expect(d.status).toBe(404);
    const count = await world.pool.query("SELECT count(*)::int AS n FROM email_templates WHERE workspace_id = $1 AND name = 'F (copy)'", [WS]);
    expect(count.rows[0]!.n).toBe(0);
  });

  it('cross-workspace GET is 404 (never another tenant)', async () => {
    const c = await call(world.env, 'POST', '/templates', { token: tok(), body: { name: 'X', mjml: MJML } });
    const id = (c.body as { template: { id: string } }).template.id;
    const other = tokenFor(USER, OTHER); // no membership in OTHER
    expect([403, 404]).toContain((await call(world.env, 'GET', `/templates/${id}`, { token: other })).status);
  });
});
