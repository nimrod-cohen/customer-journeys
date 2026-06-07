import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { adminPool, hasDatabaseUrl } from '@cdp/db';
import { runEnrollment, type RunDeps, type Reader } from '../src/run.js';
import { buildSweepQuery } from '../src/core.js';
import { runStatementsInWorkspaceTx, withWorkspaceTx } from '../src/deps.js';
import type { CampaignDefinition } from '../src/dsl.js';

// §9B AC: a wait defers via next_run_at honored by the REAL sweep query (no app
// timers). The parked row is not due until next_run_at, and the real sweep picks
// it up only after that instant.
const RUN = hasDatabaseUrl();
const WS = 'ca110000-0000-0000-0000-0000000000f2';
const CAMP = 'ca110000-0000-0000-0000-0000000000c2';
const PROF = 'ca110000-0000-0000-0000-0000000000d2';

const DEF: CampaignDefinition = {
  startNode: 't',
  nodes: {
    t: { type: 'trigger', kind: 'manual', next: 'w' },
    w: { type: 'wait', delay: 'PT2H', next: 'x' },
    x: { type: 'exit' },
  },
};

const noopSqs = { async send() { return {}; } } as unknown as RunDeps['sqs'];

describe.skipIf(!RUN)('wait deferral via the real sweep (real Postgres)', () => {
  let admin: Pool;

  beforeAll(async () => {
    admin = adminPool();
    await cleanup();
    await admin.query("INSERT INTO workspaces (id, name, status) VALUES ($1,'W','active')", [WS]);
    await admin.query(
      'INSERT INTO profiles (id, workspace_id, external_id) VALUES ($1,$2,$3)',
      [PROF, WS, 'ext'],
    );
    await admin.query(
      "INSERT INTO campaigns (id, workspace_id, name, definition, status) VALUES ($1,$2,'C',$3::jsonb,'active')",
      [CAMP, WS, JSON.stringify(DEF)],
    );
  });

  afterAll(async () => {
    if (admin) {
      await cleanup();
      await admin.end();
    }
  });

  async function cleanup() {
    await admin.query('DELETE FROM campaign_enrollments WHERE workspace_id = $1', [WS]);
    await admin.query('DELETE FROM campaigns WHERE workspace_id = $1', [WS]);
    await admin.query('DELETE FROM profiles WHERE workspace_id = $1', [WS]);
    await admin.query('DELETE FROM workspaces WHERE id = $1', [WS]);
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

  it('parks at the wait with next_run_at = now+2h; the sweep defers until then', async () => {
    const enr = await admin.query(
      "INSERT INTO campaign_enrollments (workspace_id, campaign_id, profile_id, current_node, status, next_run_at) VALUES ($1,$2,$3,'t','active', now()) RETURNING id",
      [WS, CAMP, PROF],
    );
    const id = enr.rows[0].id;

    const t0 = new Date('2026-06-07T12:00:00.000Z');
    const r1 = await runEnrollment(deps(t0), id);
    expect(r1.result).toBe('parked');
    expect((r1 as { nextRunAt: Date }).nextRunAt.toISOString()).toBe('2026-06-07T14:00:00.000Z');

    // Sweep 1h later: NOT due.
    const s1 = buildSweepQuery(new Date('2026-06-07T13:00:00.000Z'));
    const due1 = await admin.query(s1.text, s1.values);
    expect(due1.rows.find((x) => x.id === id)).toBeUndefined();

    // Sweep 2h later: due.
    const s2 = buildSweepQuery(new Date('2026-06-07T14:00:01.000Z'));
    const due2 = await admin.query(s2.text, s2.values);
    expect(due2.rows.find((x) => x.id === id)).toBeDefined();

    // Running after the wait completes.
    const r2 = await runEnrollment(deps(new Date('2026-06-07T14:00:01.000Z')), id);
    expect(r2.result).toBe('completed');
  });
});
