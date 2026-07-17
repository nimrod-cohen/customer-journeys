// Profile-trigger enrollment (real Postgres). A profile CREATE enrolls into
// active profile/created (and profile/any) automations, NOT profile/updated-only; an
// UPDATE enrolls into profile/updated + any; idempotent on replay; a draft
// automation and a different trigger kind enroll nobody; everything workspace-scoped.
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { Pool } from 'pg';
import { adminPool, hasDatabaseUrl } from '@cdp/db';
import { enrollFromProfileChange, type EnrollDeps, type Reader } from '../src/enroll.js';
import { runStatementsInWorkspaceTx } from '../src/deps.js';
import type { AutomationDefinition } from '../src/dsl.js';

const RUN = hasDatabaseUrl();
const WS = 'ca110002-0000-0000-0000-0000000000f5';
const WS_B = 'ca110002-0000-0000-0000-0000000000f6';

const profDef = (profileChange?: 'created' | 'updated' | 'any'): AutomationDefinition =>
  ({
    startNode: 'trig',
    nodes: {
      trig: { type: 'trigger', kind: 'profile', ...(profileChange ? { profileChange } : {}), next: 'x' },
      x: { type: 'exit' },
    },
  }) as unknown as AutomationDefinition;

const EVENT_DEF: AutomationDefinition = {
  startNode: 'trig',
  nodes: { trig: { type: 'trigger', kind: 'event', eventType: 'purchase', next: 'x' }, x: { type: 'exit' } },
};

describe.skipIf(!RUN)('enrollFromProfileChange (real Postgres)', () => {
  let admin: Pool;

  beforeAll(async () => {
    admin = adminPool();
    await cleanup();
    for (const ws of [WS, WS_B]) {
      await admin.query("INSERT INTO workspaces (id, name, status) VALUES ($1,'W','active')", [ws]);
    }
  });

  // Each test starts with NO automations/enrollments/profiles so res.enrolled counts
  // only this test's automations (a profile/any automation matches EVERY new profile).
  beforeEach(async () => {
    for (const ws of [WS, WS_B]) {
      await admin.query('DELETE FROM automation_enrollments WHERE workspace_id = $1', [ws]);
      await admin.query('DELETE FROM automations WHERE workspace_id = $1', [ws]);
      await admin.query('DELETE FROM profiles WHERE workspace_id = $1', [ws]);
    }
  });

  afterAll(async () => {
    if (admin) {
      await cleanup();
      await admin.end();
    }
  });

  async function cleanup(): Promise<void> {
    for (const ws of [WS, WS_B]) {
      await admin.query('DELETE FROM automation_enrollments WHERE workspace_id = $1', [ws]);
      await admin.query('DELETE FROM automations WHERE workspace_id = $1', [ws]);
      await admin.query('DELETE FROM profiles WHERE workspace_id = $1', [ws]);
      await admin.query('DELETE FROM workspaces WHERE id = $1', [ws]);
    }
  }

  function deps(): EnrollDeps {
    const reader: Reader = { query: (t, v) => admin.query(t, v as unknown[]) as never };
    return { reader, runInWorkspaceTx: (w, s) => runStatementsInWorkspaceTx(admin, w, s) };
  }

  async function newProfile(ws: string, ext: string): Promise<string> {
    const r = await admin.query('INSERT INTO profiles (workspace_id, external_id) VALUES ($1,$2) RETURNING id', [ws, ext]);
    return r.rows[0].id as string;
  }
  async function newAutomation(ws: string, def: AutomationDefinition, status = 'active'): Promise<string> {
    const r = await admin.query(
      'INSERT INTO automations (workspace_id, name, definition, status) VALUES ($1,$2,$3::jsonb,$4) RETURNING id',
      [ws, 'C', JSON.stringify(def), status],
    );
    return r.rows[0].id as string;
  }
  async function count(ws: string, campId: string, profId: string): Promise<number> {
    const r = await admin.query(
      'SELECT count(*)::int n FROM automation_enrollments WHERE workspace_id = $1 AND automation_id = $2 AND profile_id = $3',
      [ws, campId, profId],
    );
    return r.rows[0].n as number;
  }

  it('a CREATED change enrolls profile/created AND profile/any, NOT profile/updated', async () => {
    const created = await newAutomation(WS, profDef('created'));
    const any = await newAutomation(WS, profDef('any'));
    const updated = await newAutomation(WS, profDef('updated'));
    const prof = await newProfile(WS, 'p-created');
    const res = await enrollFromProfileChange(deps(), { workspace_id: WS, profile_id: prof, change: 'created' });
    expect(res.enrolled).toBe(2);
    expect(await count(WS, created, prof)).toBe(1);
    expect(await count(WS, any, prof)).toBe(1);
    expect(await count(WS, updated, prof)).toBe(0);
    const e = await admin.query(
      'SELECT current_node, status FROM automation_enrollments WHERE workspace_id = $1 AND automation_id = $2 AND profile_id = $3',
      [WS, created, prof],
    );
    expect(e.rows[0].current_node).toBe('trig');
    expect(e.rows[0].status).toBe('active');
  });

  it('an UPDATED change enrolls profile/updated AND profile/any, NOT profile/created-only', async () => {
    const created = await newAutomation(WS, profDef('created'));
    const any = await newAutomation(WS, profDef('any'));
    const updated = await newAutomation(WS, profDef('updated'));
    const prof = await newProfile(WS, 'p-updated');
    const res = await enrollFromProfileChange(deps(), { workspace_id: WS, profile_id: prof, change: 'updated' });
    expect(res.enrolled).toBe(2);
    expect(await count(WS, updated, prof)).toBe(1);
    expect(await count(WS, any, prof)).toBe(1);
    expect(await count(WS, created, prof)).toBe(0);
  });

  it('no profileChange field defaults to ANY (created + updated both enroll)', async () => {
    const camp = await newAutomation(WS, profDef());
    const pc = await newProfile(WS, 'p-default-c');
    const pu = await newProfile(WS, 'p-default-u');
    await enrollFromProfileChange(deps(), { workspace_id: WS, profile_id: pc, change: 'created' });
    await enrollFromProfileChange(deps(), { workspace_id: WS, profile_id: pu, change: 'updated' });
    expect(await count(WS, camp, pc)).toBe(1);
    expect(await count(WS, camp, pu)).toBe(1);
  });

  it('REPLAY: re-running the same change enrolls exactly ONE row (ON CONFLICT once)', async () => {
    const camp = await newAutomation(WS, profDef('any'));
    const prof = await newProfile(WS, 'p-replay');
    await enrollFromProfileChange(deps(), { workspace_id: WS, profile_id: prof, change: 'updated' });
    await enrollFromProfileChange(deps(), { workspace_id: WS, profile_id: prof, change: 'updated' });
    await enrollFromProfileChange(deps(), { workspace_id: WS, profile_id: prof, change: 'created' });
    expect(await count(WS, camp, prof)).toBe(1);
  });

  it('a DRAFT profile-trigger automation enrolls nobody', async () => {
    const camp = await newAutomation(WS, profDef('any'), 'draft');
    const prof = await newProfile(WS, 'p-draft');
    const res = await enrollFromProfileChange(deps(), { workspace_id: WS, profile_id: prof, change: 'created' });
    expect(res.enrolled).toBe(0);
    expect(await count(WS, camp, prof)).toBe(0);
  });

  it('a NON-profile trigger (event) is never enrolled by a profile change', async () => {
    const camp = await newAutomation(WS, EVENT_DEF);
    const prof = await newProfile(WS, 'p-evt');
    const res = await enrollFromProfileChange(deps(), { workspace_id: WS, profile_id: prof, change: 'created' });
    expect(res.enrolled).toBe(0);
    expect(await count(WS, camp, prof)).toBe(0);
  });

  it('TENANT ISOLATION: a WS-B profile-trigger automation is NOT enrolled by a WS-A change', async () => {
    const campB = await newAutomation(WS_B, profDef('any'));
    const profA = await newProfile(WS, 'p-iso-a');
    await enrollFromProfileChange(deps(), { workspace_id: WS, profile_id: profA, change: 'created' });
    const c = await admin.query('SELECT count(*)::int n FROM automation_enrollments WHERE automation_id = $1', [campB]);
    expect(c.rows[0].n).toBe(0);
  });
});
