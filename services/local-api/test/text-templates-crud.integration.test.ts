// Text-template library CRUD + tenant isolation (CLAUDE.md text_templates). A
// text template is a reusable plain-text body usable for SMS and WhatsApp; it is
// workspace-scoped (a cross-workspace id 404s, inv.1/2). Real Postgres; never
// mocks the DB.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { hasDatabaseUrl, adminPool } from '@cdp/db';
import { makePgLookups, makeLocalDeps, dispatch, type DispatchEnv } from '../src/index.js';
import { tokenFor } from './seed.js';
import type { Pool } from 'pg';

const WS = '0c0d0ef1-0000-4000-8000-000000000a01';
const WS_B = '0c0d0ef1-0000-4000-8000-000000000a02';
const OWNER = '0c0d0ef1-0000-4000-8000-0000000000b1';
const OWNER_B = '0c0d0ef1-0000-4000-8000-0000000000b2';

const describeMaybe = hasDatabaseUrl() ? describe : describe.skip;

describeMaybe('text-templates CRUD + isolation (real Postgres)', () => {
  let pool: Pool;
  const e = (): DispatchEnv => ({ pool, lookups: makePgLookups(pool), deps: makeLocalDeps(pool) });
  const tok = (u: string, w: string) => tokenFor(u, w);

  const call = (
    method: string,
    path: string,
    who: { u: string; w: string },
    body: Record<string, unknown> = {},
    query: Record<string, string> = {},
  ) => dispatch({ method, path, authorization: tok(who.u, who.w), query, body }, e());

  beforeAll(async () => {
    pool = adminPool();
    await cleanup();
    await pool.query("INSERT INTO workspaces (id, name, status) VALUES ($1,'W','active'),($2,'WB','active')", [WS, WS_B]);
    await pool.query(
      "INSERT INTO workspace_users (workspace_id, user_id, role) VALUES ($1,$2,'owner'),($3,$4,'owner')",
      [WS, OWNER, WS_B, OWNER_B],
    );
  });

  afterAll(async () => {
    if (pool) {
      await cleanup();
      await pool.end();
    }
  });

  async function cleanup(): Promise<void> {
    for (const w of [WS, WS_B]) {
      await pool.query('DELETE FROM text_templates WHERE workspace_id = $1', [w]);
      await pool.query('DELETE FROM workspace_users WHERE workspace_id = $1', [w]);
      await pool.query('DELETE FROM workspaces WHERE id = $1', [w]);
    }
  }

  it('create → list → get → update → delete lifecycle', async () => {
    const c = await call('POST', '/text-templates', { u: OWNER, w: WS }, { name: 'Order shipped', body: 'Hi {{customer.first_name}}!' });
    expect(c.status).toBe(201);
    const tpl = (c.body as { template: { id: string; name: string; body: string } }).template;
    expect(tpl.name).toBe('Order shipped');
    expect(tpl.body).toBe('Hi {{customer.first_name}}!');
    const id = tpl.id;

    const l = await call('GET', '/text-templates', { u: OWNER, w: WS });
    expect((l.body as { templates: unknown[] }).templates).toHaveLength(1);

    const g = await call('GET', `/text-templates/${id}`, { u: OWNER, w: WS });
    expect(g.status).toBe(200);
    expect((g.body as { template: { body: string } }).template.body).toBe('Hi {{customer.first_name}}!');

    const u = await call('PUT', `/text-templates/${id}`, { u: OWNER, w: WS }, { name: 'Renamed', body: 'New body' });
    expect(u.status).toBe(200);
    expect((u.body as { template: { name: string; body: string } }).template.name).toBe('Renamed');
    expect((u.body as { template: { body: string } }).template.body).toBe('New body');

    const d = await call('DELETE', `/text-templates/${id}`, { u: OWNER, w: WS });
    expect(d.status).toBe(200);
    expect((d.body as { deleted: number }).deleted).toBe(1);
    const l2 = await call('GET', '/text-templates', { u: OWNER, w: WS });
    expect((l2.body as { templates: unknown[] }).templates).toHaveLength(0);
  });

  it('rejects a blank name or blank body (400)', async () => {
    const noName = await call('POST', '/text-templates', { u: OWNER, w: WS }, { name: '  ', body: 'x' });
    expect(noName.status).toBe(400);
    const noBody = await call('POST', '/text-templates', { u: OWNER, w: WS }, { name: 'x', body: '   ' });
    expect(noBody.status).toBe(400);
  });

  it('ISOLATION: workspace B does not see workspace A templates', async () => {
    await call('POST', '/text-templates', { u: OWNER, w: WS }, { name: 'A-only', body: 'b' });
    const lB = await call('GET', '/text-templates', { u: OWNER_B, w: WS_B });
    expect((lB.body as { templates: { name: string }[] }).templates.find((t) => t.name === 'A-only')).toBeUndefined();
  });

  it("ISOLATION: B cannot GET/PUT/DELETE A's template (404)", async () => {
    const c = await call('POST', '/text-templates', { u: OWNER, w: WS }, { name: 'cross', body: 'b' });
    const id = (c.body as { template: { id: string } }).template.id;
    const g = await call('GET', `/text-templates/${id}`, { u: OWNER_B, w: WS_B });
    expect(g.status).toBe(404);
    const p = await call('PUT', `/text-templates/${id}`, { u: OWNER_B, w: WS_B }, { name: 'hacked' });
    expect(p.status).toBe(404);
    const d = await call('DELETE', `/text-templates/${id}`, { u: OWNER_B, w: WS_B });
    expect(d.status).toBe(404);
    // Still intact in A.
    const g2 = await call('GET', `/text-templates/${id}`, { u: OWNER, w: WS });
    expect((g2.body as { template: { name: string } }).template.name).toBe('cross');
  });

  it('PUT can update just the body (partial)', async () => {
    const c = await call('POST', '/text-templates', { u: OWNER, w: WS }, { name: 'Partial', body: 'orig' });
    const id = (c.body as { template: { id: string } }).template.id;
    const u = await call('PUT', `/text-templates/${id}`, { u: OWNER, w: WS }, { body: 'only-body' });
    expect(u.status).toBe(200);
    expect((u.body as { template: { name: string; body: string } }).template.name).toBe('Partial');
    expect((u.body as { template: { body: string } }).template.body).toBe('only-body');
  });
});
