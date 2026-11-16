// Integration (real Postgres): the designer's edit history is saved with each
// autosave, read back oldest-first, trimmed to the newest 100, and scoped.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { hasDatabaseUrl } from '@cdp/db';
import { makeWorld, tokenFor, call, type TestWorld } from './seed.js';

const WS = '0c0d0e5d-0000-4000-8000-000000000f01';
const WS2 = '0c0d0e5d-0000-4000-8000-000000000f02';
const USER = '0c0d0e5d-0000-4000-8000-0000000000f1';
const USER2 = '0c0d0e5d-0000-4000-8000-0000000000f2';
const describeMaybe = hasDatabaseUrl() ? describe : describe.skip;

const design = (n: number) => ({ version: 1, settings: {}, rows: [{ id: `r${n}`, elements: [] }] });

describeMaybe('email template history (real Postgres)', () => {
  let world: TestWorld;
  beforeAll(async () => {
    world = makeWorld();
    await cleanup();
    for (const [ws, u] of [[WS, USER], [WS2, USER2]] as const) {
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
      await world.pool.query('DELETE FROM workspace_users WHERE workspace_id = $1', [ws]);
      await world.pool.query('DELETE FROM workspaces WHERE id = $1', [ws]);
    }
  }

  it('saves, reads back in order, trims to 100 and stays in its workspace', async () => {
    const tok = tokenFor(USER, WS);
    const mjml = '<mjml><mj-body></mj-body></mjml>';
    const c = await call(world.env, 'POST', '/templates', {
      token: tok,
      body: { name: 'T', mjml, design: design(0), history_append: [{ action: 'Add text', snapshot: JSON.stringify(design(0)), timestamp: 1 }] },
    });
    const id = (c.body as { template: { id: string } }).template.id;
    const entries = Array.from({ length: 110 }, (_, i) => ({ action: `Edit ${i + 1}`, snapshot: design(i + 1), timestamp: 1000 + i }));
    await call(world.env, 'PUT', `/templates/${id}`, { token: tok, body: { mjml, design: design(200), history_append: [...entries, { action: 'junk', snapshot: 'not json' }] } });

    const h = await call(world.env, 'GET', `/templates/${id}/history`, { token: tok });
    expect(h.status).toBe(200);
    const list = (h.body as { history: { action: string; snapshot: string }[] }).history;
    expect(list).toHaveLength(100);
    expect(list[0]!.action).toBe('Edit 11');
    expect(list[99]!.action).toBe('Edit 110');
    expect(JSON.parse(list[99]!.snapshot)).toEqual(design(110));

    expect((await call(world.env, 'GET', `/templates/${id}/history`, { token: tokenFor(USER2, WS2) })).status).toBe(404);
  });
});
