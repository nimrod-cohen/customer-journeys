import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { Pool } from 'pg';
import { adminPool, hasDatabaseUrl } from '@cdp/db';
import { zonedInputToUtcIso } from '@cdp/shared';
import { runEnrollment, type RunDeps, type Reader } from '../src/run.js';
import { buildSweepQuery } from '../src/core.js';
import { runStatementsInWorkspaceTx, withWorkspaceTx } from '../src/deps.js';
import type { AutomationDefinition } from '../src/dsl.js';

// §9B AC: an enrollment parked on an hour_of_day_window resumes at the next window
// OPENING in the WORKSPACE timezone (DST-correct). The next_run_at gate is honored
// by the REAL sweep query (no app timer). Two workspaces with different tz park at
// DIFFERENT UTC instants for the SAME wall-clock window (per-workspace tz proof).
const RUN = hasDatabaseUrl();
const NY = 'America/New_York';
// Unique, file-local UUIDs (avoid cross-file collisions).
const WS_NY = 'ca110000-0000-0000-0000-00000000aa01';
const WS_UTC = 'ca110000-0000-0000-0000-00000000aa02';
const CAMP_NY = 'ca110000-0000-0000-0000-00000000bb01';
const CAMP_UTC = 'ca110000-0000-0000-0000-00000000bb02';
const PROF_NY = 'ca110000-0000-0000-0000-00000000cc01';
const PROF_UTC = 'ca110000-0000-0000-0000-00000000cc02';

// trigger → hour_of_day_window(9..17) → exit.
const DEF: AutomationDefinition = {
  startNode: 't',
  nodes: {
    t: { type: 'trigger', kind: 'manual', next: 'win' },
    win: { type: 'hour_of_day_window', startHour: 9, endHour: 17, next: 'x' },
    x: { type: 'exit' },
  },
};

const noopSqs = { async send() { return {}; } } as unknown as RunDeps['sqs'];

describe.skipIf(!RUN)('hour_of_day_window parking via the real tick (real Postgres)', () => {
  let admin: Pool;

  beforeAll(async () => {
    admin = adminPool();
    await cleanup();
    await admin.query(
      "INSERT INTO workspaces (id, name, status, settings) VALUES ($1,'W-NY','active',$2::jsonb)",
      [WS_NY, JSON.stringify({ timezone: NY })],
    );
    // WS_UTC has NO timezone setting → runner defaults to UTC.
    await admin.query("INSERT INTO workspaces (id, name, status) VALUES ($1,'W-UTC','active')", [WS_UTC]);
    for (const [ws, prof] of [[WS_NY, PROF_NY], [WS_UTC, PROF_UTC]] as const) {
      await admin.query('INSERT INTO profiles (id, workspace_id, email) VALUES ($1,$2,$3)', [
        prof,
        ws,
        `${prof}@e.test`,
      ]);
    }
    for (const [camp, ws] of [[CAMP_NY, WS_NY], [CAMP_UTC, WS_UTC]] as const) {
      await admin.query(
        "INSERT INTO automations (id, workspace_id, name, definition, status) VALUES ($1,$2,'C',$3::jsonb,'active')",
        [camp, ws, JSON.stringify(DEF)],
      );
    }
  });

  beforeEach(async () => {
    // Each test re-enrolls the same (automation, profile) — clear prior enrollments
    // so the UNIQUE(automation_id, profile_id) re-enrollment guard doesn't collide.
    for (const ws of [WS_NY, WS_UTC]) {
      await admin.query('DELETE FROM automation_enrollments WHERE workspace_id = $1', [ws]);
    }
  });

  afterAll(async () => {
    if (admin) {
      await cleanup();
      await admin.end();
    }
  });

  async function cleanup() {
    for (const ws of [WS_NY, WS_UTC]) {
      await admin.query('DELETE FROM automation_enrollments WHERE workspace_id = $1', [ws]);
      await admin.query('DELETE FROM automations WHERE workspace_id = $1', [ws]);
      await admin.query('DELETE FROM profiles WHERE workspace_id = $1', [ws]);
      await admin.query('DELETE FROM workspaces WHERE id = $1', [ws]);
    }
  }

  function deps(now: Date): RunDeps {
    const reader: Reader = { query: (t, v) => admin.query(t, v as unknown[]) as never };
    return {
      reader,
      sqs: noopSqs,
      withTx: (fn) => withWorkspaceTx(admin, fn),
      runInWorkspaceTx: (w, s) => runStatementsInWorkspaceTx(admin, w, s),
      now: () => now,
      dispatchQueueUrl: 'q',
    };
  }

  async function enroll(ws: string, camp: string, prof: string): Promise<string> {
    const r = await admin.query(
      "INSERT INTO automation_enrollments (workspace_id, automation_id, profile_id, current_node, status, next_run_at) VALUES ($1,$2,$3,'t','active', now()) RETURNING id",
      [ws, camp, prof],
    );
    return r.rows[0].id as string;
  }

  it('parks until next opening (ws tz); sweep gate honors next_run_at; resumes inside the window', async () => {
    const id = await enroll(WS_NY, CAMP_NY, PROF_NY);

    // 03:00 UTC on 2026-06-19 == 23:00 NY the PRIOR day (before 09:00 NY) → park.
    const before = new Date('2026-06-19T03:00:00.000Z');
    const r1 = await runEnrollment(deps(before), id);
    expect(r1.result).toBe('parked');
    expect((r1 as { node: string }).node).toBe('win');

    // next_run_at == 2026-06-19 09:00 NY → UTC (EDT, -4 ⇒ 13:00Z). Read back as text.
    const row = await admin.query('SELECT next_run_at::text AS t FROM automation_enrollments WHERE id = $1', [id]);
    const expectedIso = new Date(zonedInputToUtcIso('2026-06-19T09:00', NY)).toISOString();
    expect(new Date(row.rows[0].t).toISOString()).toBe(expectedIso);
    expect(expectedIso).toBe('2026-06-19T13:00:00.000Z');

    // REAL sweep gate: not due before 13:00Z, due at/after.
    const sBefore = buildSweepQuery(new Date('2026-06-19T12:59:00.000Z'));
    const dueBefore = await admin.query(sBefore.text, sBefore.values);
    expect(dueBefore.rows.find((x) => x.id === id)).toBeUndefined();
    const sAfter = buildSweepQuery(new Date('2026-06-19T13:00:01.000Z'));
    const dueAfter = await admin.query(sAfter.text, sAfter.values);
    expect(dueAfter.rows.find((x) => x.id === id)).toBeDefined();

    // Resume inside the window (14:00 NY == 18:00Z) → advances past win to exit.
    const inside = new Date('2026-06-19T18:00:00.000Z');
    const r2 = await runEnrollment(deps(inside), id);
    expect(r2.result).toBe('completed');
    const done = await admin.query('SELECT status, next_run_at FROM automation_enrollments WHERE id = $1', [id]);
    expect(done.rows[0].status).toBe('completed');
    expect(done.rows[0].next_run_at).toBeNull();
  });

  it('per-workspace tz: NY vs default-UTC park at DIFFERENT UTC instants for the same wall-clock window', async () => {
    // now = 2026-06-19 07:00 UTC. For UTC ws: 07:00 local < 09:00 → opening today 09:00Z.
    // For NY ws: 07:00 UTC == 03:00 NY < 09:00 NY → opening today 09:00 NY == 13:00Z.
    const now = new Date('2026-06-19T07:00:00.000Z');
    const idNy = await enroll(WS_NY, CAMP_NY, PROF_NY);
    const idUtc = await enroll(WS_UTC, CAMP_UTC, PROF_UTC);

    const rNy = await runEnrollment(deps(now), idNy);
    const rUtc = await runEnrollment(deps(now), idUtc);
    expect(rNy.result).toBe('parked');
    expect(rUtc.result).toBe('parked');

    const ny = await admin.query('SELECT next_run_at::text AS t FROM automation_enrollments WHERE id = $1', [idNy]);
    const utc = await admin.query('SELECT next_run_at::text AS t FROM automation_enrollments WHERE id = $1', [idUtc]);
    const nyIso = new Date(ny.rows[0].t).toISOString();
    const utcIso = new Date(utc.rows[0].t).toISOString();
    expect(utcIso).toBe('2026-06-19T09:00:00.000Z'); // UTC default
    expect(nyIso).toBe('2026-06-19T13:00:00.000Z'); // NY (EDT -4)
    expect(nyIso).not.toBe(utcIso); // per-workspace tz, not a constant
  });

  it('DST: a March spring-forward parking lands on the POST-transition (EDT) offset', async () => {
    // US DST 2026 begins Sun 2026-03-08 02:00 (EST→EDT). A window opening at 09:00
    // NY on 2026-03-08 is in EDT (-4) ⇒ 13:00Z (NOT 14:00Z, which would be the naive
    // EST -5 guess). now = 2026-03-08 06:00 UTC == 01:00 EST, before the opening.
    const id = await enroll(WS_NY, CAMP_NY, PROF_NY);
    const now = new Date('2026-03-08T06:00:00.000Z');
    const r = await runEnrollment(deps(now), id);
    expect(r.result).toBe('parked');
    const row = await admin.query('SELECT next_run_at::text AS t FROM automation_enrollments WHERE id = $1', [id]);
    const iso = new Date(row.rows[0].t).toISOString();
    expect(iso).toBe(new Date(zonedInputToUtcIso('2026-03-08T09:00', NY)).toISOString());
    expect(iso).toBe('2026-03-08T13:00:00.000Z'); // EDT (-4), post-transition
  });
});
