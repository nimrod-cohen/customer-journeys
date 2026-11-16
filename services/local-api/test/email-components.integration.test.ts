// Integration (real Postgres): saved email components. Editing a component
// re-renders every email linking to it (design snapshot + MJML + compiled HTML),
// a stale snapshot sent by an editor is refreshed on save, deleting a component
// leaves its emails with an unlinked copy, and everything is workspace-scoped.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { hasDatabaseUrl } from '@cdp/db';
import { makeWorld, tokenFor, call, type TestWorld } from './seed.js';

const WS = '0c0d0e5d-0000-4000-8000-000000000c01';
const WS2 = '0c0d0e5d-0000-4000-8000-000000000c02';
const USER = '0c0d0e5d-0000-4000-8000-0000000000c1';
const USER2 = '0c0d0e5d-0000-4000-8000-0000000000c2';

const describeMaybe = hasDatabaseUrl() ? describe : describe.skip;

const textRow = (id: string, html: string) => ({ id, elements: [{ id: `${id}-t`, type: 'text', props: { html } }] });

describeMaybe('email components (real Postgres)', () => {
  let world: TestWorld;
  const tok = () => tokenFor(USER, WS);

  beforeAll(async () => {
    world = makeWorld();
    await cleanup();
    for (const [ws, u] of [
      [WS, USER],
      [WS2, USER2],
    ] as const) {
      await world.pool.query("INSERT INTO workspaces (id, name, status) VALUES ($1,'W','active')", [ws]);
      await world.pool.query("INSERT INTO workspace_users (workspace_id, user_id, role) VALUES ($1,$2,'owner')", [ws, u]);
    }
  });

  afterAll(async () => {
    if (world) {
      await cleanup();
      await world.pool.end();
    }
  });

  async function cleanup(): Promise<void> {
    for (const ws of [WS, WS2]) {
      await world.pool.query('DELETE FROM email_templates WHERE workspace_id = $1', [ws]);
      await world.pool.query('DELETE FROM email_components WHERE workspace_id = $1', [ws]);
      await world.pool.query('DELETE FROM workspace_users WHERE workspace_id = $1', [ws]);
      await world.pool.query('DELETE FROM workspaces WHERE id = $1', [ws]);
    }
  }

  const html = async (id: string): Promise<string> =>
    (await world.pool.query<{ compiled_html: string }>('SELECT compiled_html FROM email_templates WHERE id = $1', [id])).rows[0]!.compiled_html;

  it('editing a component re-renders every email that links to it', async () => {
    const c = await call(world.env, 'POST', '/email-components', {
      token: tok(),
      body: { name: 'Footer', design: { version: 1, settings: {}, rows: [textRow('f', 'Old footer')] } },
    });
    expect(c.status).toBe(201);
    const comp = (c.body as { component: { id: string; design: { rows: unknown[] } } }).component;

    // The editor sends a linked row whose snapshot is STALE — the server refreshes it.
    const design = {
      version: 1,
      settings: {},
      rows: [textRow('b', 'Body text'), { id: 'l', elements: [], component: { id: comp.id, name: 'Footer', rows: [textRow('x', 'STALE')] } }],
    };
    const t = await call(world.env, 'POST', '/templates', { token: tok(), body: { name: 'News', mjml: '<mjml><mj-body></mj-body></mjml>', design } });
    expect(t.status).toBe(201);
    const tid = (t.body as { template: { id: string } }).template.id;
    expect(await html(tid)).toContain('Old footer');
    expect(await html(tid)).not.toContain('STALE');
    expect(await html(tid)).toContain('Body text');

    const u = await call(world.env, 'PUT', `/email-components/${comp.id}`, {
      token: tok(),
      body: { design: { version: 1, settings: {}, rows: [textRow('f', 'New footer {{unsubscribe}}')] } },
    });
    expect(u.status).toBe(200);
    expect((u.body as { updated_emails: number }).updated_emails).toBe(1);
    expect(await html(tid)).toContain('New footer');

    const l = await call(world.env, 'GET', '/email-components', { token: tok() });
    expect((l.body as { components: { used_by: number }[] }).components[0]!.used_by).toBe(1);

    // Another workspace can neither see nor edit it.
    const other = await call(world.env, 'PUT', `/email-components/${comp.id}`, { token: tokenFor(USER2, WS2), body: { name: 'x' } });
    expect(other.status).toBe(404);
    const otherList = await call(world.env, 'GET', '/email-components', { token: tokenFor(USER2, WS2) });
    expect((otherList.body as { components: unknown[] }).components).toEqual([]);

    // Deleting leaves the email with a plain copy that still sends the footer.
    const d = await call(world.env, 'DELETE', `/email-components/${comp.id}`, { token: tok() });
    expect(d.status).toBe(200);
    const row = (await world.pool.query<{ design: { rows: { component?: unknown }[] } }>('SELECT design FROM email_templates WHERE id = $1', [tid])).rows[0]!;
    expect(row.design.rows.some((r) => r.component)).toBe(false);
    expect(JSON.stringify(row.design)).toContain('New footer');
    expect(await html(tid)).toContain('New footer');
  });

  it('rejects a component without a name or design', async () => {
    expect((await call(world.env, 'POST', '/email-components', { token: tok(), body: { design: { version: 1, rows: [] } } })).status).toBe(400);
    expect((await call(world.env, 'POST', '/email-components', { token: tok(), body: { name: 'X' } })).status).toBe(400);
  });
});
