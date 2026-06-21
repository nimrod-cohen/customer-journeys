// Integration (real Postgres): GET /campaigns/:id round-trips a campaign's DSL
// definition for the builder reload (§9B phase 5). Workspace-scoped (inv.1/inv.2:
// the workspace comes from the TOKEN, never the body — a cross-workspace id 404s).
// POST/PUT reject a structurally INVALID definition (the validator's message
// surfaces) and don't mutate the stored row. Uses the SAME dispatch pipeline the
// HTTP server uses; never mocks the DB.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { hasDatabaseUrl } from '@cdp/db';
import { validateCampaignDefinition } from '@cdp/service-campaign-runner';
import { makeWorld, tokenFor, call, type TestWorld } from './seed.js';

const WS = '0c0d0e94-0000-4000-8000-000000000a01';
const WS_OTHER = '0c0d0e94-0000-4000-8000-000000000a02';
const USER = '0c0d0e94-0000-4000-8000-0000000000b1';
const USER_OTHER = '0c0d0e94-0000-4000-8000-0000000000b2';
const TOPIC = '0c0d0e94-0000-4000-8000-0000000000c1';
const TOPIC_OTHER = '0c0d0e94-0000-4000-8000-0000000000c2';

const describeMaybe = hasDatabaseUrl() ? describe : describe.skip;

// A valid linear definition (the builder's starter shape, extended).
const linearDef = {
  startNode: 'trigger',
  nodes: {
    trigger: { type: 'trigger', kind: 'manual', next: 'wait1' },
    wait1: { type: 'wait', delay: { seconds: 86400 }, next: 'x' },
    x: { type: 'exit' },
  },
};

// A valid branching definition (the canvas if-branch shape).
const branchDef = {
  startNode: 'trigger',
  nodes: {
    trigger: { type: 'trigger', kind: 'manual', next: 'cond' },
    cond: { type: 'condition', ast: { field: 'attributes.tier', operator: '=', value: 'vip' }, onTrue: 'aY', onFalse: 'aN' },
    aY: { type: 'action', kind: 'set_attribute', key: 'k', value: 'y', next: 'xY' },
    aN: { type: 'action', kind: 'set_attribute', key: 'k', value: 'n', next: 'xN' },
    xY: { type: 'exit' },
    xN: { type: 'exit' },
  },
};

describeMaybe('GET /campaigns/:id — definition round-trip (real Postgres)', () => {
  let world: TestWorld;
  const tok = () => tokenFor(USER, WS);

  beforeAll(async () => {
    world = makeWorld();
    await cleanup();
    for (const [ws, user] of [[WS, USER], [WS_OTHER, USER_OTHER]] as const) {
      await world.pool.query("INSERT INTO workspaces (id, name, status) VALUES ($1,'W','active')", [ws]);
      await world.pool.query("INSERT INTO workspace_users (workspace_id, user_id, role) VALUES ($1,$2,'owner')", [ws, user]);
    }
    await world.pool.query("INSERT INTO topics (id, workspace_id, name) VALUES ($1,$2,'News')", [TOPIC, WS]);
    await world.pool.query("INSERT INTO topics (id, workspace_id, name) VALUES ($1,$2,'Foreign')", [TOPIC_OTHER, WS_OTHER]);
  });

  afterAll(async () => {
    if (world) {
      await cleanup();
      await world.pool.end();
    }
  });

  async function cleanup(): Promise<void> {
    for (const ws of [WS, WS_OTHER]) {
      await world.pool.query('DELETE FROM campaigns WHERE workspace_id = $1', [ws]);
      await world.pool.query('DELETE FROM topics WHERE workspace_id = $1', [ws]);
      await world.pool.query('DELETE FROM workspace_users WHERE workspace_id = $1', [ws]);
      await world.pool.query('DELETE FROM workspaces WHERE id = $1', [ws]);
    }
  }

  it('returns the full campaign + definition for an in-workspace id', async () => {
    const created = await call(world.env, 'POST', '/campaigns', {
      token: tok(),
      body: { name: 'Round trip', definition: linearDef },
    });
    expect(created.status).toBe(201);
    const id = (created.body as { campaign: { id: string } }).campaign.id;

    const got = await call(world.env, 'GET', `/campaigns/${id}`, { token: tok() });
    expect(got.status).toBe(200);
    const c = (got.body as { campaign: Record<string, unknown> }).campaign;
    expect(c.id).toBe(id);
    expect(c.name).toBe('Round trip');
    expect(c.status).toBe('draft');
    expect(c).toHaveProperty('trigger_segment_id');
    expect(c).toHaveProperty('trigger_on');
    expect(c.definition).toEqual(linearDef); // the DSL deep-equals what we saved
  });

  it('round-trips a branching definition that still passes the validator', async () => {
    const created = await call(world.env, 'POST', '/campaigns', {
      token: tok(),
      body: { name: 'Branchy', definition: branchDef },
    });
    const id = (created.body as { campaign: { id: string } }).campaign.id;
    const got = await call(world.env, 'GET', `/campaigns/${id}`, { token: tok() });
    const def = (got.body as { campaign: { definition: unknown } }).campaign.definition;
    expect(def).toEqual(branchDef);
    expect(() => validateCampaignDefinition(def)).not.toThrow();
  });

  it('PUT /campaigns/:id sets a workspace topic_id; GET surfaces it; a foreign topic is rejected', async () => {
    const created = await call(world.env, 'POST', '/campaigns', {
      token: tok(),
      body: { name: 'Topiced', definition: linearDef },
    });
    const id = (created.body as { campaign: { id: string } }).campaign.id;

    // Set an in-workspace topic.
    const put = await call(world.env, 'PUT', `/campaigns/${id}`, { token: tok(), body: { topic_id: TOPIC } });
    expect(put.status).toBe(200);
    const got = await call(world.env, 'GET', `/campaigns/${id}`, { token: tok() });
    expect((got.body as { campaign: { topic_id: string | null } }).campaign.topic_id).toBe(TOPIC);

    // A FOREIGN topic id is rejected (inv.2) — the stored topic is unchanged.
    const bad = await call(world.env, 'PUT', `/campaigns/${id}`, { token: tok(), body: { topic_id: TOPIC_OTHER } });
    expect(bad.status).toBe(400);
    expect((bad.body as { error?: string }).error).toMatch(/topic_id not found/i);
    const after = await call(world.env, 'GET', `/campaigns/${id}`, { token: tok() });
    expect((after.body as { campaign: { topic_id: string | null } }).campaign.topic_id).toBe(TOPIC);

    // Clearing the topic (null) is allowed.
    const clear = await call(world.env, 'PUT', `/campaigns/${id}`, { token: tok(), body: { topic_id: null } });
    expect(clear.status).toBe(200);
    const cleared = await call(world.env, 'GET', `/campaigns/${id}`, { token: tok() });
    expect((cleared.body as { campaign: { topic_id: string | null } }).campaign.topic_id).toBeNull();
  });

  it('404s for a campaign in ANOTHER workspace (token-scoped, inv.2)', async () => {
    const created = await call(world.env, 'POST', '/campaigns', {
      token: tokenFor(USER_OTHER, WS_OTHER),
      body: { name: 'Foreign', definition: linearDef },
    });
    const foreignId = (created.body as { campaign: { id: string } }).campaign.id;
    // Our token (WS) must NOT see WS_OTHER's campaign.
    const got = await call(world.env, 'GET', `/campaigns/${foreignId}`, { token: tok() });
    expect(got.status).toBe(404);
  });

  it('rejects POST of an invalid definition (cycle / orphan / no-exit / two triggers)', async () => {
    const cyclic = {
      startNode: 'trigger',
      nodes: {
        trigger: { type: 'trigger', kind: 'manual', next: 'w' },
        w: { type: 'wait', delay: { seconds: 60 }, next: 'trigger' }, // back-edge
        x: { type: 'exit' },
      },
    };
    const noExit = {
      startNode: 'trigger',
      nodes: {
        trigger: { type: 'trigger', kind: 'manual', next: 'a' },
        a: { type: 'action', kind: 'set_attribute', key: 'k', value: '1', next: 'a' },
      },
    };
    const orphan = {
      startNode: 'trigger',
      nodes: {
        trigger: { type: 'trigger', kind: 'manual', next: 'x' },
        x: { type: 'exit' },
        lonely: { type: 'exit' }, // unreachable
      },
    };
    const twoTriggers = {
      startNode: 'trigger',
      nodes: {
        trigger: { type: 'trigger', kind: 'manual', next: 'x' },
        trigger2: { type: 'trigger', kind: 'manual', next: 'x' },
        x: { type: 'exit' },
      },
    };

    for (const [def, re] of [
      [cyclic, /cycle/i],
      [noExit, /cycle|exit/i],
      [orphan, /orphan|reachable/i],
      [twoTriggers, /one trigger/i],
    ] as const) {
      const res = await call(world.env, 'POST', '/campaigns', {
        token: tok(),
        body: { name: 'Bad', definition: def },
      });
      expect(res.status).toBe(400); // a malformed graph is USER input → a TYPED 400 (§9B phase-6)
      expect(JSON.stringify(res.body)).toMatch(re);
    }
  });

  it('PUT of an invalid definition is refused and does NOT mutate the stored row', async () => {
    const created = await call(world.env, 'POST', '/campaigns', {
      token: tok(),
      body: { name: 'Keep me', definition: linearDef },
    });
    const id = (created.body as { campaign: { id: string } }).campaign.id;

    const bad = {
      startNode: 'trigger',
      nodes: {
        trigger: { type: 'trigger', kind: 'manual', next: 'w' },
        w: { type: 'wait', delay: { seconds: 60 }, next: 'trigger' },
        x: { type: 'exit' },
      },
    };
    const put = await call(world.env, 'PUT', `/campaigns/${id}`, {
      token: tok(),
      body: { definition: bad },
    });
    expect(put.status).toBe(400);

    // Re-GET shows the ORIGINAL definition (untouched).
    const got = await call(world.env, 'GET', `/campaigns/${id}`, { token: tok() });
    expect((got.body as { campaign: { definition: unknown } }).campaign.definition).toEqual(linearDef);
  });
});
