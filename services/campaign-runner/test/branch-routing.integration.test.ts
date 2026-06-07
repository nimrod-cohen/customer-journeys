import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { adminPool, hasDatabaseUrl } from '@cdp/db';
import { runEnrollment, type RunDeps, type Reader } from '../src/run.js';
import { runStatementsInWorkspaceTx, withWorkspaceTx } from '../src/deps.js';
import type { CampaignDefinition } from '../src/dsl.js';

// §9B AC: a condition routes via the §8 compiler against REAL profile_features.
// Two profiles: one matches the branch AST (gets the send), one doesn't (exits).
const RUN = hasDatabaseUrl();
const WS = 'ca110000-0000-0000-0000-0000000000f3';
const CAMP = 'ca110000-0000-0000-0000-0000000000c3';
const PROF_MATCH = 'ca110000-0000-0000-0000-0000000000d3';
const PROF_NO = 'ca110000-0000-0000-0000-0000000000d4';
const TPL = 'ca110000-0000-0000-0000-0000000000e3';

const DEF: CampaignDefinition = {
  startNode: 't',
  nodes: {
    t: { type: 'trigger', kind: 'manual', next: 'c' },
    c: {
      type: 'condition',
      ast: { field: 'features.counters.purchase', operator: '>=', value: 1 },
      onTrue: 'a',
      onFalse: 'x',
    },
    a: { type: 'action', kind: 'send', template_id: TPL, next: 'x' },
    x: { type: 'exit' },
  },
};

const noopSqs = { async send() { return {}; } } as unknown as RunDeps['sqs'];

describe.skipIf(!RUN)('branch routing against real profile_features (real Postgres)', () => {
  let admin: Pool;

  beforeAll(async () => {
    admin = adminPool();
    await cleanup();
    await admin.query("INSERT INTO workspaces (id, name, status) VALUES ($1,'W','active')", [WS]);
    await admin.query(
      "INSERT INTO email_templates (id, workspace_id, name, mjml, compiled_html) VALUES ($1,$2,'t','<m/>','<h/>')",
      [TPL, WS],
    );
    for (const [pid, ext, counters] of [
      [PROF_MATCH, 'm', { purchase: 3 }],
      [PROF_NO, 'n', { purchase: 0 }],
    ] as const) {
      await admin.query('INSERT INTO profiles (id, workspace_id, external_id) VALUES ($1,$2,$3)', [
        pid,
        WS,
        ext,
      ]);
      await admin.query(
        "INSERT INTO profile_features (profile_id, workspace_id, counters) VALUES ($1,$2,$3::jsonb)",
        [pid, WS, JSON.stringify(counters)],
      );
    }
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
    await admin.query('DELETE FROM outbox WHERE workspace_id = $1', [WS]);
    await admin.query('DELETE FROM campaign_enrollments WHERE workspace_id = $1', [WS]);
    await admin.query('DELETE FROM campaigns WHERE workspace_id = $1', [WS]);
    await admin.query('DELETE FROM profile_features WHERE workspace_id = $1', [WS]);
    await admin.query('DELETE FROM profiles WHERE workspace_id = $1', [WS]);
    await admin.query('DELETE FROM email_templates WHERE workspace_id = $1', [WS]);
    await admin.query('DELETE FROM workspaces WHERE id = $1', [WS]);
  }

  function deps(): RunDeps {
    const reader: Reader = { query: (t, v) => admin.query(t, v as unknown[]) as never };
    return {
      reader,
      sqs: noopSqs,
      withTx: (fn) => withWorkspaceTx(admin, fn),
      runInWorkspaceTx: (w, s) => runStatementsInWorkspaceTx(admin, w, s),
      now: () => new Date('2026-06-07T12:00:00.000Z'),
      dispatchQueueUrl: 'q',
    };
  }

  async function enroll(profileId: string): Promise<string> {
    const r = await admin.query(
      "INSERT INTO campaign_enrollments (workspace_id, campaign_id, profile_id, current_node, status, next_run_at) VALUES ($1,$2,$3,'t','active', now()) RETURNING id",
      [WS, CAMP, profileId],
    );
    return r.rows[0].id;
  }

  it('matching profile takes onTrue (send); non-matching takes onFalse (no send)', async () => {
    const idMatch = await enroll(PROF_MATCH);
    const idNo = await enroll(PROF_NO);

    expect((await runEnrollment(deps(), idMatch)).result).toBe('completed');
    expect((await runEnrollment(deps(), idNo)).result).toBe('completed');

    const ob = await admin.query(
      'SELECT profile_id FROM outbox WHERE workspace_id = $1 ORDER BY profile_id',
      [WS],
    );
    // exactly one send — for the matching profile only
    expect(ob.rows).toHaveLength(1);
    expect(ob.rows[0].profile_id).toBe(PROF_MATCH);
  });
});
