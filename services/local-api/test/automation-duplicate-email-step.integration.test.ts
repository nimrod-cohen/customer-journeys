// Integration (real Postgres): a DUPLICATED email step gets its own email copy on
// draft save — the original keeps its copy, editing one never edits the other —
// and a later save with a stale model does not mint yet another copy.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { hasDatabaseUrl } from '@cdp/db';
import { makeWorld, tokenFor, call, type TestWorld } from './seed.js';

const WS = '0c0d0e5d-0000-4000-8000-000000000d01';
const USER = '0c0d0e5d-0000-4000-8000-0000000000d1';
const describeMaybe = hasDatabaseUrl() ? describe : describe.skip;

describeMaybe('duplicated email step (real Postgres)', () => {
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
    await world.pool.query('DELETE FROM email_templates WHERE workspace_id = $1', [WS]);
    await world.pool.query('DELETE FROM workspace_users WHERE workspace_id = $1', [WS]);
    await world.pool.query('DELETE FROM workspaces WHERE id = $1', [WS]);
  }

  const def = (nodes: Record<string, unknown>) => ({ startNode: 't', nodes: { t: { type: 'trigger', kind: 'manual', next: 's1' }, ...nodes, x: { type: 'exit' } } });

  it('splits a shared copy, keeps the original on the original step, and is stable', async () => {
    const copy = (
      await world.pool.query<{ id: string }>(
        "INSERT INTO email_templates (workspace_id, name, mjml, compiled_html, kind) VALUES ($1,'E','<mjml></mjml>','<p>hi</p>','copy') RETURNING id",
        [WS],
      )
    ).rows[0]!.id;
    const one = def({ s1: { type: 'action', kind: 'send', template_id: copy, next: 'x' } });
    const c = await call(world.env, 'POST', '/automations', { token: tok(), body: { name: 'A', definition: one } });
    const aid = (c.body as { automation: { id: string } }).automation.id;

    // The builder duplicated s1 as s2 — both point at the same copy.
    const two = def({
      s1: { type: 'action', kind: 'send', template_id: copy, next: 's2' },
      s2: { type: 'action', kind: 'send', template_id: copy, next: 'x' },
    });
    const r = await call(world.env, 'PUT', `/automations/${aid}/draft`, { token: tok(), body: { definition: two } });
    expect(r.status).toBe(200);
    expect((r.body as { repointed?: boolean }).repointed).toBe(true);
    const draft = (await world.pool.query<{ d: { nodes: Record<string, { template_id: string }> } }>('SELECT draft_definition AS d FROM automations WHERE id = $1', [aid])).rows[0]!.d;
    expect(draft.nodes.s1!.template_id).toBe(copy);
    const s2 = draft.nodes.s2!.template_id;
    expect(s2).not.toBe(copy);
    const kind = (await world.pool.query<{ kind: string }>('SELECT kind FROM email_templates WHERE id = $1', [s2])).rows[0]!.kind;
    expect(kind).toBe('copy');

    // A stale save (model still sharing) reuses s2's own copy instead of cloning again.
    const before = (await world.pool.query<{ n: number }>('SELECT count(*)::int AS n FROM email_templates WHERE workspace_id = $1', [WS])).rows[0]!.n;
    await call(world.env, 'PUT', `/automations/${aid}/draft`, { token: tok(), body: { definition: two } });
    const after = (await world.pool.query<{ n: number }>('SELECT count(*)::int AS n FROM email_templates WHERE workspace_id = $1', [WS])).rows[0]!.n;
    expect(after).toBe(before);
    const draft2 = (await world.pool.query<{ d: { nodes: Record<string, { template_id: string }> } }>('SELECT draft_definition AS d FROM automations WHERE id = $1', [aid])).rows[0]!.d;
    expect(draft2.nodes.s2!.template_id).toBe(s2);
  });
});
