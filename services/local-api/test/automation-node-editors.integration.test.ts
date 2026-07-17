// Integration (real Postgres): per-node editor persistence for the automation
// builder (§9B phase 6). A definition carrying configured wait / wait_until /
// hour_window / condition / set_attribute (literal|expression) / webhook /
// event-trigger nodes round-trips byte-for-byte through PUT → GET. A structurally
// INVALID definition is a TYPED 400 (never a 500). attach-template clones a
// LIBRARY template into a kind='copy' and repoints the node (cross-workspace
// refusal). The segment_entry trigger's segment is the AUTOMATION-ROW field
// trigger_segment_id, set via PUT (cross-workspace rejected). Never mocks the DB.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { hasDatabaseUrl } from '@cdp/db';
import { validateAutomationDefinition } from '@cdp/service-automation-runner';
import { makeWorld, tokenFor, call, type TestWorld } from './seed.js';

const WS = '0c0d0e95-0000-4000-8000-000000000a01';
const WS_OTHER = '0c0d0e95-0000-4000-8000-000000000a02';
const USER = '0c0d0e95-0000-4000-8000-0000000000b1';
const USER_OTHER = '0c0d0e95-0000-4000-8000-0000000000b2';
const SEG = '0c0d0e95-0000-4000-8000-0000000000d1';
const SEG_OTHER = '0c0d0e95-0000-4000-8000-0000000000d2';

const describeMaybe = hasDatabaseUrl() ? describe : describe.skip;

// A definition exercising EVERY editable node type the editors emit.
const fullDef = {
  startNode: 'trigger',
  nodes: {
    trigger: { type: 'trigger', kind: 'event', eventType: 'purchase', filter: { field: 'payload.sku', operator: '=', value: 'book' }, next: 'wait1' },
    wait1: { type: 'wait', delay: { seconds: 259200 }, next: 'wuntil' },
    wuntil: { type: 'wait', until: '2030-01-01T08:00:00.000Z', next: 'hour' },
    hour: { type: 'hour_of_day_window', startHour: 9, endHour: 17, daysOfWeek: [1, 2, 3, 4, 5], next: 'cond' },
    cond: { type: 'condition', ast: { field: 'attributes.tier', operator: '=', value: 'vip' }, onTrue: 'setExpr', onFalse: 'hook' },
    setExpr: { type: 'action', kind: 'set_attribute', key: 'last_sku', value: { kind: 'expression', expression: '{{event.sku}}' }, next: 'setLit' },
    setLit: { type: 'action', kind: 'set_attribute', key: 'stage', value: { kind: 'literal', value: 'engaged' }, next: 'xA' },
    hook: { type: 'action', kind: 'webhook', url: 'https://hooks.example.com/x', method: 'POST', headers: { Authorization: 'Bearer s3cr3t' }, bodyTemplate: '{"e":"{{customer.email}}"}', timeoutMs: 5000, maxRetries: 2, next: 'xB' },
    xA: { type: 'exit' },
    xB: { type: 'exit' },
  },
};

describeMaybe('automation per-node editor persistence (real Postgres)', () => {
  let world: TestWorld;
  const tok = () => tokenFor(USER, WS);

  async function makeAutomation(ws: string): Promise<string> {
    const r = await world.pool.query<{ id: string }>(
      "INSERT INTO automations (workspace_id, name, definition, status) VALUES ($1,'C','{\"startNode\":\"trigger\",\"nodes\":{\"trigger\":{\"type\":\"trigger\",\"kind\":\"manual\",\"next\":\"x\"},\"x\":{\"type\":\"exit\"}}}'::jsonb,'draft') RETURNING id",
      [ws],
    );
    return r.rows[0]!.id;
  }

  async function makeLibTemplate(ws: string): Promise<string> {
    const r = await world.pool.query<{ id: string }>(
      `INSERT INTO email_templates (workspace_id, name, mjml, compiled_html, subject, to_address)
       VALUES ($1,'Lib','<m/>','<h/>','Hi','{{customer.email}}') RETURNING id`,
      [ws],
    );
    return r.rows[0]!.id;
  }

  beforeAll(async () => {
    world = makeWorld();
    await cleanup();
    for (const [ws, user, seg] of [[WS, USER, SEG], [WS_OTHER, USER_OTHER, SEG_OTHER]] as const) {
      await world.pool.query("INSERT INTO workspaces (id, name, status) VALUES ($1,'W','active')", [ws]);
      await world.pool.query("INSERT INTO workspace_users (workspace_id, user_id, role) VALUES ($1,$2,'owner')", [ws, user]);
      await world.pool.query(
        "INSERT INTO segments (id, workspace_id, name, kind, status) VALUES ($1,$2,'seg','dynamic_realtime','active')",
        [seg, ws],
      );
    }
  });

  afterAll(async () => {
    if (world) {
      await cleanup();
      await world.pool.end();
    }
  });

  async function cleanup(): Promise<void> {
    for (const ws of [WS, WS_OTHER]) {
      await world.pool.query('DELETE FROM automations WHERE workspace_id = $1', [ws]);
      await world.pool.query('DELETE FROM email_templates WHERE workspace_id = $1', [ws]);
      await world.pool.query('DELETE FROM segments WHERE workspace_id = $1', [ws]);
      await world.pool.query('DELETE FROM workspace_users WHERE workspace_id = $1', [ws]);
      await world.pool.query('DELETE FROM workspaces WHERE id = $1', [ws]);
    }
  }

  it('PUT a definition with every node type round-trips byte-for-byte through GET', async () => {
    const camp = await makeAutomation(WS);
    const put = await call(world.env, 'PUT', `/automations/${camp}`, { token: tok(), body: { definition: fullDef } });
    expect(put.status).toBe(200);
    const got = await call(world.env, 'GET', `/automations/${camp}`, { token: tok() });
    expect(got.status).toBe(200);
    const def = (got.body as { automation: { definition: unknown } }).automation.definition;
    expect(def).toEqual(fullDef);
    expect(() => validateAutomationDefinition(def)).not.toThrow();
  });

  it('a structurally INVALID definition is a TYPED 400 (not a 500)', async () => {
    const camp = await makeAutomation(WS);
    const bad = [
      // condition missing onFalse
      { startNode: 't', nodes: { t: { type: 'trigger', kind: 'manual', next: 'c' }, c: { type: 'condition', ast: { field: 'x', operator: 'exists' }, onTrue: 'x' }, x: { type: 'exit' } } },
      // webhook with a non-http url
      { startNode: 't', nodes: { t: { type: 'trigger', kind: 'manual', next: 'h' }, h: { type: 'action', kind: 'webhook', url: 'ftp://nope', method: 'POST', next: 'x' }, x: { type: 'exit' } } },
      // set_attribute with an unknown value-spec kind
      { startNode: 't', nodes: { t: { type: 'trigger', kind: 'manual', next: 'a' }, a: { type: 'action', kind: 'set_attribute', key: 'k', value: { kind: 'nope' }, next: 'x' }, x: { type: 'exit' } } },
    ];
    for (const def of bad) {
      const res = await call(world.env, 'PUT', `/automations/${camp}`, { token: tok(), body: { definition: def } });
      expect(res.status).toBe(400);
      expect(typeof (res.body as { error?: string }).error).toBe('string');
    }
  });

  it('set_attribute persists both an expression spec and a legacy bare scalar', async () => {
    const camp = await makeAutomation(WS);
    const def = {
      startNode: 't',
      nodes: {
        t: { type: 'trigger', kind: 'manual', next: 'a' },
        a: { type: 'action', kind: 'set_attribute', key: 'last', value: { kind: 'expression', expression: '{{event.foo}}' }, next: 'b' },
        b: { type: 'action', kind: 'set_attribute', key: 'legacy', value: 'plainscalar', next: 'x' },
        x: { type: 'exit' },
      },
    };
    await call(world.env, 'PUT', `/automations/${camp}`, { token: tok(), body: { definition: def } });
    const got = await call(world.env, 'GET', `/automations/${camp}`, { token: tok() });
    expect((got.body as { automation: { definition: unknown } }).automation.definition).toEqual(def);
  });

  it('attach-template clones a library template into a kind=copy and repoints the send node', async () => {
    const lib = await makeLibTemplate(WS);
    const camp = await makeAutomation(WS);
    // Add a send node to attach onto.
    const sendDef = { startNode: 't', nodes: { t: { type: 'trigger', kind: 'manual', next: 'send' }, send: { type: 'action', kind: 'send', next: 'x' }, x: { type: 'exit' } } };
    await call(world.env, 'PUT', `/automations/${camp}`, { token: tok(), body: { definition: sendDef } });

    const res = await call(world.env, 'POST', `/automations/${camp}/send-nodes/send/attach-template`, { token: tok(), body: { template_id: lib } });
    expect(res.status).toBe(201);
    const copyId = (res.body as { template: { id: string } }).template.id;

    // The send node now points at the COPY, and the copy is kind='copy'.
    const got = await call(world.env, 'GET', `/automations/${camp}`, { token: tok() });
    const def = (got.body as { automation: { definition: { nodes: Record<string, { template_id?: string }> } } }).automation.definition;
    expect(def.nodes.send!.template_id).toBe(copyId);
    const row = await world.pool.query<{ kind: string; source_template_id: string }>(
      'SELECT kind, source_template_id FROM email_templates WHERE id = $1',
      [copyId],
    );
    expect(row.rows[0]!.kind).toBe('copy');
    expect(row.rows[0]!.source_template_id).toBe(lib);
    // The library original is untouched (still kind='live'/default).
    const orig = await world.pool.query<{ kind: string }>('SELECT kind FROM email_templates WHERE id = $1', [lib]);
    expect(orig.rows[0]!.kind).not.toBe('copy');
  });

  it('attach-template REFUSES a cross-workspace template_id (404, clones nothing) — inv.2', async () => {
    const foreignLib = await makeLibTemplate(WS_OTHER);
    const camp = await makeAutomation(WS);
    const sendDef = { startNode: 't', nodes: { t: { type: 'trigger', kind: 'manual', next: 'send' }, send: { type: 'action', kind: 'send', next: 'x' }, x: { type: 'exit' } } };
    await call(world.env, 'PUT', `/automations/${camp}`, { token: tok(), body: { definition: sendDef } });
    const before = await world.pool.query<{ n: string }>("SELECT count(*) n FROM email_templates WHERE workspace_id = $1", [WS]);
    const res = await call(world.env, 'POST', `/automations/${camp}/send-nodes/send/attach-template`, { token: tok(), body: { template_id: foreignLib } });
    expect(res.status).toBe(404);
    const after = await world.pool.query<{ n: string }>("SELECT count(*) n FROM email_templates WHERE workspace_id = $1", [WS]);
    expect(after.rows[0]!.n).toBe(before.rows[0]!.n); // nothing cloned
  });

  it('trigger_segment_id is set via PUT (automation-row field); a cross-workspace id is rejected (inv.2)', async () => {
    const camp = await makeAutomation(WS);
    // In-workspace segment → accepted + persisted.
    const okRes = await call(world.env, 'PUT', `/automations/${camp}`, { token: tok(), body: { trigger_segment_id: SEG } });
    expect(okRes.status).toBe(200);
    let row = await world.pool.query<{ trigger_segment_id: string | null }>('SELECT trigger_segment_id FROM automations WHERE id = $1', [camp]);
    expect(row.rows[0]!.trigger_segment_id).toBe(SEG);

    // A foreign segment id → 400, and the stored value is unchanged.
    const badRes = await call(world.env, 'PUT', `/automations/${camp}`, { token: tok(), body: { trigger_segment_id: SEG_OTHER } });
    expect(badRes.status).toBe(400);
    row = await world.pool.query<{ trigger_segment_id: string | null }>('SELECT trigger_segment_id FROM automations WHERE id = $1', [camp]);
    expect(row.rows[0]!.trigger_segment_id).toBe(SEG); // untouched
  });
});
