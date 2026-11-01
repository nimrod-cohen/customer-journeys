// Integration (real Postgres): segments and automations carry an optional
// free-text `description`. Create accepts it, update changes it (blank clears it,
// absent leaves it), list + detail return it, and an over-long one is a 400.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { hasDatabaseUrl } from '@cdp/db';
import { makeWorld, tokenFor, call, type TestWorld } from './seed.js';

const WS = '0c0d0e5d-0000-4000-8000-000000000e01';
const USER = '0c0d0e5d-0000-4000-8000-0000000000e1';

const describeMaybe = hasDatabaseUrl() ? describe : describe.skip;

const def = {
  startNode: 't',
  nodes: {
    t: { type: 'trigger', kind: 'event', eventType: 'purchase', next: 'x' },
    x: { type: 'exit' },
  },
};

describeMaybe('description on segments + automations (real Postgres)', () => {
  let world: TestWorld;
  const tok = () => tokenFor(USER, WS);

  beforeAll(async () => {
    world = makeWorld();
    await cleanup();
    await world.pool.query("INSERT INTO workspaces (id, name, status) VALUES ($1,'W','active')", [WS]);
    await world.pool.query("INSERT INTO workspace_users (workspace_id, user_id, role) VALUES ($1,$2,'owner')", [WS, USER]);
  });

  afterAll(async () => {
    if (world) {
      await cleanup();
      await world.pool.end();
    }
  });

  async function cleanup(): Promise<void> {
    await world.pool.query('DELETE FROM automations WHERE workspace_id = $1', [WS]);
    await world.pool.query('DELETE FROM segments WHERE workspace_id = $1', [WS]);
    await world.pool.query('DELETE FROM workspace_users WHERE workspace_id = $1', [WS]);
    await world.pool.query('DELETE FROM workspaces WHERE id = $1', [WS]);
  }

  it('segment: create, read, update, clear', async () => {
    const c = await call(world.env, 'POST', '/segments', {
      token: tok(),
      body: { name: 'VIP', kind: 'manual', definition: null, description: '  Top spenders  ' },
    });
    expect(c.status).toBe(201);
    const seg = (c.body as { segment: { id: string; description: string | null } }).segment;
    expect(seg.description).toBe('Top spenders');

    const g = await call(world.env, 'GET', `/segments/${seg.id}`, { token: tok() });
    expect((g.body as { segment: { description: string } }).segment.description).toBe('Top spenders');

    // A rename alone leaves the description untouched.
    await call(world.env, 'PUT', `/segments/${seg.id}`, { token: tok(), body: { name: 'VIPs' } });
    const l = await call(world.env, 'GET', '/segments', { token: tok() });
    const row = (l.body as { segments: { id: string; description: string | null }[] }).segments.find((s) => s.id === seg.id);
    expect(row?.description).toBe('Top spenders');

    // Blank clears it.
    await call(world.env, 'PUT', `/segments/${seg.id}`, { token: tok(), body: { description: '   ' } });
    const g2 = await call(world.env, 'GET', `/segments/${seg.id}`, { token: tok() });
    expect((g2.body as { segment: { description: string | null } }).segment.description).toBeNull();
  });

  it('automation: create, read, update, clear', async () => {
    const c = await call(world.env, 'POST', '/automations', {
      token: tok(),
      body: { name: 'Welcome', definition: def, description: 'Onboarding series' },
    });
    expect(c.status).toBe(201);
    const id = (c.body as { automation: { id: string; description: string } }).automation.id;
    expect((c.body as { automation: { description: string } }).automation.description).toBe('Onboarding series');

    const g = await call(world.env, 'GET', `/automations/${id}`, { token: tok() });
    expect((g.body as { automation: { description: string } }).automation.description).toBe('Onboarding series');

    await call(world.env, 'PUT', `/automations/${id}`, { token: tok(), body: { description: 'Updated' } });
    const l = await call(world.env, 'GET', '/automations', { token: tok() });
    const row = (l.body as { automations: { id: string; description: string | null }[] }).automations.find((a) => a.id === id);
    expect(row?.description).toBe('Updated');

    await call(world.env, 'PUT', `/automations/${id}`, { token: tok(), body: { description: null } });
    const g2 = await call(world.env, 'GET', `/automations/${id}`, { token: tok() });
    expect((g2.body as { automation: { description: string | null } }).automation.description).toBeNull();
  });

  it('an over-long description is a 400 and writes nothing', async () => {
    const long = 'x'.repeat(2001);
    const s = await call(world.env, 'POST', '/segments', {
      token: tok(),
      body: { name: 'Long', kind: 'manual', definition: null, description: long },
    });
    expect(s.status).toBe(400);
    const a = await call(world.env, 'POST', '/automations', {
      token: tok(),
      body: { name: 'Long', definition: def, description: long },
    });
    expect(a.status).toBe(400);
  });
});
