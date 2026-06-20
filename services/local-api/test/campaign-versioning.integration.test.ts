// Integration (real Postgres): campaign VERSIONING + publish-scope (§9B builder).
//
// Covers the draft-vs-live model:
//   - PUT /campaigns/:id/draft writes ONLY the draft (live untouched).
//   - GET /campaigns/:id returns the DRAFT to edit + liveDefinition + hasDraft +
//     activeVersion + draft trigger.
//   - POST /campaigns/:id/publish snapshots a version (v1, then v2…), promotes
//     draft→live + active_version_id + status active, CLEARS the draft; runs the
//     ordered envelope publish-gate (per-node 409) + invalid-def 400; backfill
//     enrolls the CURRENT segment-entry members (idempotent), forward/event/manual
//     enroll nothing.
//   - GET /campaigns/:id/versions lists newest-first with is_active.
//   - POST /campaigns/:id/revert loads a prior version INTO the draft, live intact.
//   - Everything workspace-scoped (cross-workspace id → 404; workspace_id never
//     from the body).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { hasDatabaseUrl } from '@cdp/db';
import { makeWorld, tokenFor, call, type TestWorld } from './seed.js';

const WS = '0c0d0e96-0000-4000-8000-000000000a01';
const WS_OTHER = '0c0d0e96-0000-4000-8000-000000000a02';
const USER = '0c0d0e96-0000-4000-8000-0000000000b1';
const USER_OTHER = '0c0d0e96-0000-4000-8000-0000000000b2';
const DOMAIN = '0c0d0e96-0000-4000-8000-0000000000d1';
const SENDER = '0c0d0e96-0000-4000-8000-0000000000f1';
const SEGMENT = '0c0d0e96-0000-4000-8000-0000000000e1';

const describeMaybe = hasDatabaseUrl() ? describe : describe.skip;

// A valid linear manual-trigger definition.
const linearDef = (label = 'x') => ({
  startNode: 'trigger',
  nodes: {
    trigger: { type: 'trigger', kind: 'manual', next: 'wait1' },
    wait1: { type: 'wait', delay: { seconds: 86400 }, next: 'x' },
    x: { type: 'exit', label },
  },
});

// A send-node definition referencing a copy template.
const sendDef = (copyId: string) => ({
  startNode: 'trigger',
  nodes: {
    trigger: { type: 'trigger', kind: 'manual', next: 'send' },
    send: { type: 'action', kind: 'send', template_id: copyId, next: 'x' },
    x: { type: 'exit' },
  },
});

// A segment-entry trigger definition (for backfill).
const segmentEntryDef = {
  startNode: 'trigger',
  nodes: {
    trigger: { type: 'trigger', kind: 'segment_entry', next: 'x' },
    x: { type: 'exit' },
  },
};

const eventDef = {
  startNode: 'trigger',
  nodes: {
    trigger: { type: 'trigger', kind: 'event', eventType: 'purchase', next: 'x' },
    x: { type: 'exit' },
  },
};

const invalidDef = {
  startNode: 'trigger',
  nodes: {
    trigger: { type: 'trigger', kind: 'manual', next: 'w' },
    w: { type: 'wait', delay: { seconds: 60 }, next: 'trigger' }, // cycle
    x: { type: 'exit' },
  },
};

describeMaybe('campaign versioning + publish-scope (real Postgres)', () => {
  let world: TestWorld;
  const tok = () => tokenFor(USER, WS);

  async function makeCopy(
    ws: string,
    env: { subject?: string | null; sender_id?: string | null; to_address?: string | null },
  ): Promise<string> {
    const r = await world.pool.query<{ id: string }>(
      `INSERT INTO email_templates (workspace_id, name, mjml, compiled_html, kind, subject, sender_id, to_address)
       VALUES ($1,'copy','<m/>','<h/>','copy',$2,$3,$4) RETURNING id`,
      [ws, env.subject ?? null, env.sender_id ?? null, env.to_address ?? null],
    );
    return r.rows[0]!.id;
  }

  async function makeCampaign(ws: string, def: unknown, opts: { trigger_segment_id?: string } = {}): Promise<string> {
    const r = await world.pool.query<{ id: string }>(
      "INSERT INTO campaigns (workspace_id, name, definition, status, trigger_segment_id) VALUES ($1,'C',$2::jsonb,'draft',$3) RETURNING id",
      [ws, JSON.stringify(def), opts.trigger_segment_id ?? null],
    );
    return r.rows[0]!.id;
  }

  beforeAll(async () => {
    world = makeWorld();
    await cleanup();
    for (const [ws, user] of [[WS, USER], [WS_OTHER, USER_OTHER]] as const) {
      await world.pool.query("INSERT INTO workspaces (id, name, status) VALUES ($1,'W','active')", [ws]);
      await world.pool.query("INSERT INTO workspace_users (workspace_id, user_id, role) VALUES ($1,$2,'owner')", [ws, user]);
    }
    await world.pool.query("INSERT INTO users (id, email) VALUES ($1,$2) ON CONFLICT DO NOTHING", [USER, 'u95@x.test']);
    await world.pool.query(
      "INSERT INTO sending_domains (id, workspace_id, domain, verified) VALUES ($1,$2,'mail.a.com',true)",
      [DOMAIN, WS],
    );
    await world.pool.query(
      "INSERT INTO domain_senders (id, workspace_id, domain, name, email) VALUES ($1,$2,'mail.a.com','A','a@mail.a.com')",
      [SENDER, WS],
    );
    // A manual segment with two members for backfill.
    await world.pool.query(
      "INSERT INTO segments (id, workspace_id, name, kind) VALUES ($1,$2,'S','manual')",
      [SEGMENT, WS],
    );
  });

  afterAll(async () => {
    if (world) {
      await cleanup();
      await world.pool.end();
    }
  });

  async function cleanup(): Promise<void> {
    for (const ws of [WS, WS_OTHER]) {
      await world.pool.query('DELETE FROM campaign_enrollments WHERE workspace_id = $1', [ws]);
      // Drop the active_version_id FK first, THEN the versions, THEN the campaigns.
      await world.pool.query("UPDATE campaigns SET active_version_id = NULL WHERE workspace_id = $1", [ws]);
      await world.pool.query('DELETE FROM campaign_versions WHERE workspace_id = $1', [ws]);
      await world.pool.query('DELETE FROM campaigns WHERE workspace_id = $1', [ws]);
      await world.pool.query('DELETE FROM segment_memberships WHERE workspace_id = $1', [ws]);
      await world.pool.query('DELETE FROM segments WHERE workspace_id = $1', [ws]);
      await world.pool.query('DELETE FROM email_templates WHERE workspace_id = $1', [ws]);
      await world.pool.query('DELETE FROM domain_senders WHERE workspace_id = $1', [ws]);
      await world.pool.query('DELETE FROM sending_domains WHERE workspace_id = $1', [ws]);
      await world.pool.query('DELETE FROM profiles WHERE workspace_id = $1', [ws]);
      await world.pool.query('DELETE FROM workspace_users WHERE workspace_id = $1', [ws]);
      await world.pool.query('DELETE FROM workspaces WHERE id = $1', [ws]);
    }
  }

  it('PUT /draft writes ONLY the draft; live definition + trigger are untouched', async () => {
    const camp = await makeCampaign(WS, linearDef('live'));
    const res = await call(world.env, 'PUT', `/campaigns/${camp}/draft`, {
      token: tok(),
      body: { definition: linearDef('draft'), trigger_segment_id: SEGMENT },
    });
    expect(res.status).toBe(200);
    const row = await world.pool.query<{ definition: { nodes: { x: { label: string } } }; draft_definition: { nodes: { x: { label: string } } }; trigger_segment_id: string | null; draft_trigger_segment_id: string | null }>(
      'SELECT definition, draft_definition, trigger_segment_id, draft_trigger_segment_id FROM campaigns WHERE id = $1',
      [camp],
    );
    expect(row.rows[0]!.definition.nodes.x.label).toBe('live'); // LIVE untouched
    expect(row.rows[0]!.draft_definition.nodes.x.label).toBe('draft');
    expect(row.rows[0]!.trigger_segment_id).toBeNull();
    expect(row.rows[0]!.draft_trigger_segment_id).toBe(SEGMENT);
  });

  it('PUT /draft rejects an invalid definition with a typed 400 (no write)', async () => {
    const camp = await makeCampaign(WS, linearDef('live'));
    const res = await call(world.env, 'PUT', `/campaigns/${camp}/draft`, {
      token: tok(),
      body: { definition: invalidDef },
    });
    expect(res.status).toBe(400);
    const row = await world.pool.query<{ draft_definition: unknown }>('SELECT draft_definition FROM campaigns WHERE id = $1', [camp]);
    expect(row.rows[0]!.draft_definition).toBeNull();
  });

  it('GET /campaigns/:id returns the draft to edit + liveDefinition + hasDraft + draft trigger', async () => {
    const camp = await makeCampaign(WS, linearDef('live'));
    await call(world.env, 'PUT', `/campaigns/${camp}/draft`, {
      token: tok(),
      body: { definition: linearDef('draft'), trigger_segment_id: SEGMENT },
    });
    const got = await call(world.env, 'GET', `/campaigns/${camp}`, { token: tok() });
    expect(got.status).toBe(200);
    const c = (got.body as { campaign: Record<string, unknown> }).campaign;
    expect((c.definition as { nodes: { x: { label: string } } }).nodes.x.label).toBe('draft'); // EDIT the draft
    expect((c.liveDefinition as { nodes: { x: { label: string } } }).nodes.x.label).toBe('live');
    expect(c.hasDraft).toBe(true);
    expect(c.trigger_segment_id).toBe(SEGMENT); // draft trigger
    expect(c.activeVersion).toBeNull();
  });

  it('GET /campaigns/:id with no draft: definition==live, hasDraft false', async () => {
    const camp = await makeCampaign(WS, linearDef('live'));
    const got = await call(world.env, 'GET', `/campaigns/${camp}`, { token: tok() });
    const c = (got.body as { campaign: Record<string, unknown> }).campaign;
    expect((c.definition as { nodes: { x: { label: string } } }).nodes.x.label).toBe('live');
    expect(c.hasDraft).toBe(false);
  });

  it('POST /publish snapshots v1, promotes draft→live + active_version_id + status active, clears the draft', async () => {
    const camp = await makeCampaign(WS, linearDef('orig'));
    await call(world.env, 'PUT', `/campaigns/${camp}/draft`, { token: tok(), body: { definition: linearDef('v1') } });
    const res = await call(world.env, 'POST', `/campaigns/${camp}/publish`, { token: tok(), body: { name: 'First', scope: 'forward' } });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ version: 1, name: 'First', enrolled: 0 });

    const row = await world.pool.query<{ definition: { nodes: { x: { label: string } } }; draft_definition: unknown; status: string; active_version_id: string | null }>(
      'SELECT definition, draft_definition, status, active_version_id FROM campaigns WHERE id = $1',
      [camp],
    );
    expect(row.rows[0]!.definition.nodes.x.label).toBe('v1'); // live == published draft
    expect(row.rows[0]!.draft_definition).toBeNull(); // draft cleared
    expect(row.rows[0]!.status).toBe('active');
    expect(row.rows[0]!.active_version_id).not.toBeNull();

    const ver = await world.pool.query<{ version: number; name: string; created_by: string | null }>(
      'SELECT version, name, created_by FROM campaign_versions WHERE campaign_id = $1', [camp]);
    expect(ver.rows[0]!.version).toBe(1);
    expect(ver.rows[0]!.name).toBe('First');
    expect(ver.rows[0]!.created_by).toBe(USER);

    // Publish AGAIN → v2.
    await call(world.env, 'PUT', `/campaigns/${camp}/draft`, { token: tok(), body: { definition: linearDef('v2') } });
    const res2 = await call(world.env, 'POST', `/campaigns/${camp}/publish`, { token: tok(), body: { name: 'Second', scope: 'forward' } });
    expect((res2.body as { version: number }).version).toBe(2);
    const live2 = await world.pool.query<{ definition: { nodes: { x: { label: string } } } }>('SELECT definition FROM campaigns WHERE id = $1', [camp]);
    expect(live2.rows[0]!.definition.nodes.x.label).toBe('v2');
  });

  it('POST /publish with NO draft publishes the current live definition (idempotent re-publish)', async () => {
    const camp = await makeCampaign(WS, linearDef('only'));
    const res = await call(world.env, 'POST', `/campaigns/${camp}/publish`, { token: tok(), body: { name: 'Live as-is', scope: 'forward' } });
    expect(res.status).toBe(200);
    expect((res.body as { version: number }).version).toBe(1);
  });

  it('POST /publish requires a name', async () => {
    const camp = await makeCampaign(WS, linearDef());
    const res = await call(world.env, 'POST', `/campaigns/${camp}/publish`, { token: tok(), body: { scope: 'forward' } });
    expect(res.status).toBe(400);
  });

  it('POST /publish runs the ordered envelope gate against the DRAFT (per-node 409)', async () => {
    const copy = await makeCopy(WS, { subject: 'Hi', to_address: '{{customer.email}}', sender_id: null });
    const camp = await makeCampaign(WS, linearDef());
    await call(world.env, 'PUT', `/campaigns/${camp}/draft`, { token: tok(), body: { definition: sendDef(copy) } });
    const res = await call(world.env, 'POST', `/campaigns/${camp}/publish`, { token: tok(), body: { name: 'gated', scope: 'forward' } });
    expect(res.status).toBe(409);
    expect((res.body as { error: string }).error).toMatch(/Choose who the email is from/i);
    expect((res.body as { missing: string }).missing).toBe('sender');
    // NOT published: no version, no draft cleared, status still draft.
    const ver = await world.pool.query('SELECT 1 FROM campaign_versions WHERE campaign_id = $1', [camp]);
    expect(ver.rowCount).toBe(0);
    const row = await world.pool.query<{ status: string; draft_definition: unknown }>('SELECT status, draft_definition FROM campaigns WHERE id = $1', [camp]);
    expect(row.rows[0]!.status).toBe('draft');
    expect(row.rows[0]!.draft_definition).not.toBeNull();
  });

  it('POST /publish rejects an invalid draft definition with a typed 400 (no version)', async () => {
    const camp = await makeCampaign(WS, linearDef());
    // Bypass PUT validation by writing the bad draft directly, to prove publish re-validates.
    await world.pool.query('UPDATE campaigns SET draft_definition = $1::jsonb WHERE id = $2', [JSON.stringify(invalidDef), camp]);
    const res = await call(world.env, 'POST', `/campaigns/${camp}/publish`, { token: tok(), body: { name: 'bad', scope: 'forward' } });
    expect(res.status).toBe(400);
    const ver = await world.pool.query('SELECT 1 FROM campaign_versions WHERE campaign_id = $1', [camp]);
    expect(ver.rowCount).toBe(0);
  });

  it('POST /publish scope=backfill enrolls the CURRENT segment-entry members (idempotent)', async () => {
    // Two profiles, both in the manual segment.
    const p1 = await world.pool.query<{ id: string }>("INSERT INTO profiles (workspace_id, email) VALUES ($1,'p1@x.test') RETURNING id", [WS]);
    const p2 = await world.pool.query<{ id: string }>("INSERT INTO profiles (workspace_id, email) VALUES ($1,'p2@x.test') RETURNING id", [WS]);
    for (const p of [p1, p2]) {
      await world.pool.query(
        "INSERT INTO segment_memberships (workspace_id, segment_id, profile_id, source) VALUES ($1,$2,$3,'manual')",
        [WS, SEGMENT, p.rows[0]!.id],
      );
    }
    const camp = await makeCampaign(WS, segmentEntryDef, { trigger_segment_id: SEGMENT });
    const res = await call(world.env, 'POST', `/campaigns/${camp}/publish`, { token: tok(), body: { name: 'bf', scope: 'backfill' } });
    expect(res.status).toBe(200);
    expect((res.body as { enrolled: number }).enrolled).toBe(2);
    const en = await world.pool.query('SELECT 1 FROM campaign_enrollments WHERE campaign_id = $1', [camp]);
    expect(en.rowCount).toBe(2);

    // Re-publish backfill → ON CONFLICT 'once': no new enrollments.
    const res2 = await call(world.env, 'POST', `/campaigns/${camp}/publish`, { token: tok(), body: { name: 'bf2', scope: 'backfill' } });
    expect(res2.status).toBe(200);
    expect((res2.body as { enrolled: number }).enrolled).toBe(2); // resolves current members again
    const en2 = await world.pool.query('SELECT 1 FROM campaign_enrollments WHERE campaign_id = $1', [camp]);
    expect(en2.rowCount).toBe(2); // still 2 — idempotent
  });

  it('POST /publish scope=forward on a segment-entry trigger enrolls NOTHING', async () => {
    const camp = await makeCampaign(WS, segmentEntryDef, { trigger_segment_id: SEGMENT });
    const res = await call(world.env, 'POST', `/campaigns/${camp}/publish`, { token: tok(), body: { name: 'fwd', scope: 'forward' } });
    expect((res.body as { enrolled: number }).enrolled).toBe(0);
    const en = await world.pool.query('SELECT 1 FROM campaign_enrollments WHERE campaign_id = $1', [camp]);
    expect(en.rowCount).toBe(0);
  });

  it('POST /publish scope=backfill on an EVENT trigger enrolls NOTHING (no segment)', async () => {
    const camp = await makeCampaign(WS, eventDef);
    const res = await call(world.env, 'POST', `/campaigns/${camp}/publish`, { token: tok(), body: { name: 'ev', scope: 'backfill' } });
    expect((res.body as { enrolled: number }).enrolled).toBe(0);
  });

  it('GET /campaigns/:id/versions lists newest-first with is_active', async () => {
    const camp = await makeCampaign(WS, linearDef('a'));
    await call(world.env, 'POST', `/campaigns/${camp}/publish`, { token: tok(), body: { name: 'A', scope: 'forward' } });
    await call(world.env, 'PUT', `/campaigns/${camp}/draft`, { token: tok(), body: { definition: linearDef('b') } });
    await call(world.env, 'POST', `/campaigns/${camp}/publish`, { token: tok(), body: { name: 'B', scope: 'forward' } });

    const res = await call(world.env, 'GET', `/campaigns/${camp}/versions`, { token: tok() });
    expect(res.status).toBe(200);
    const versions = (res.body as { versions: Array<{ version: number; name: string; is_active: boolean }> }).versions;
    expect(versions.map((v) => v.version)).toEqual([2, 1]); // newest first
    expect(versions[0]!.name).toBe('B');
    expect(versions[0]!.is_active).toBe(true); // v2 is the active one
    expect(versions[1]!.is_active).toBe(false);
  });

  it('POST /revert loads a prior version INTO the draft; live untouched', async () => {
    const camp = await makeCampaign(WS, linearDef('start'));
    await call(world.env, 'POST', `/campaigns/${camp}/publish`, { token: tok(), body: { name: 'V1', scope: 'forward' } });
    const v1Id = (await world.pool.query<{ id: string }>('SELECT id FROM campaign_versions WHERE campaign_id = $1 AND version = 1', [camp])).rows[0]!.id;
    // Publish a v2 with a different label so live differs from v1.
    await call(world.env, 'PUT', `/campaigns/${camp}/draft`, { token: tok(), body: { definition: linearDef('v2live') } });
    await call(world.env, 'POST', `/campaigns/${camp}/publish`, { token: tok(), body: { name: 'V2', scope: 'forward' } });

    const res = await call(world.env, 'POST', `/campaigns/${camp}/revert`, { token: tok(), body: { version_id: v1Id } });
    expect(res.status).toBe(200);
    expect((res.body as { definition: { nodes: { x: { label: string } } } }).definition.nodes.x.label).toBe('start');

    const row = await world.pool.query<{ definition: { nodes: { x: { label: string } } }; draft_definition: { nodes: { x: { label: string } } } }>(
      'SELECT definition, draft_definition FROM campaigns WHERE id = $1', [camp]);
    expect(row.rows[0]!.definition.nodes.x.label).toBe('v2live'); // LIVE untouched
    expect(row.rows[0]!.draft_definition.nodes.x.label).toBe('start'); // loaded into draft
  });

  it('POST /revert with a version from ANOTHER campaign 404s', async () => {
    const campA = await makeCampaign(WS, linearDef('a'));
    await call(world.env, 'POST', `/campaigns/${campA}/publish`, { token: tok(), body: { name: 'A', scope: 'forward' } });
    const vA = (await world.pool.query<{ id: string }>('SELECT id FROM campaign_versions WHERE campaign_id = $1', [campA])).rows[0]!.id;
    const campB = await makeCampaign(WS, linearDef('b'));
    const res = await call(world.env, 'POST', `/campaigns/${campB}/revert`, { token: tok(), body: { version_id: vA } });
    expect(res.status).toBe(404);
  });

  // --- cross-workspace isolation (inv.1/inv.2) ---
  it('a foreign campaign id 404s on draft/publish/versions/revert + GET', async () => {
    const foreign = await makeCampaign(WS_OTHER, linearDef('foreign'));
    const t = tok(); // WS token cannot touch WS_OTHER's campaign
    expect((await call(world.env, 'GET', `/campaigns/${foreign}`, { token: t })).status).toBe(404);
    expect((await call(world.env, 'PUT', `/campaigns/${foreign}/draft`, { token: t, body: { definition: linearDef() } })).status).toBe(404);
    expect((await call(world.env, 'POST', `/campaigns/${foreign}/publish`, { token: t, body: { name: 'x', scope: 'forward' } })).status).toBe(404);
    expect((await call(world.env, 'GET', `/campaigns/${foreign}/versions`, { token: t })).status).toBe(404);
    expect((await call(world.env, 'POST', `/campaigns/${foreign}/revert`, { token: t, body: { version_id: foreign } })).status).toBe(404);
  });
});
