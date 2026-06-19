import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { Pool } from 'pg';
import { adminPool, hasDatabaseUrl } from '@cdp/db';
import type { WebhookHttpClient, WebhookRequest } from '@cdp/runner-webhook';
import { runEnrollment, MAX_STEPS_PER_TICK, type RunDeps, type Reader } from '../src/run.js';
import { buildWebhookActivityInsert } from '../src/core.js';
import { runStatementsInWorkspaceTx, withWorkspaceTx } from '../src/deps.js';
import type { CampaignDefinition } from '../src/dsl.js';

// §9B AC: concurrency/idempotency. Two CONCURRENT runs on the same due webhook
// enrollment → exactly ONE advances (FOR UPDATE single winner) → the injected
// client fires AT MOST ONCE. A crash-recovery re-write of the activity row is
// de-duped by the per-(campaign,profile,node) marker (ON CONFLICT DO NOTHING).
const RUN = hasDatabaseUrl();
const WS = 'ca110000-0000-0000-0000-00000000ee01';
const CAMP = 'ca110000-0000-0000-0000-00000000ee02';
const PROF = 'ca110000-0000-0000-0000-00000000ee03';
const ALLOWED = 'hooks.example.com';

const WEBHOOK_DEF: CampaignDefinition = {
  startNode: 't',
  nodes: {
    t: { type: 'trigger', kind: 'manual', next: 'wh' },
    wh: { type: 'action', kind: 'webhook', url: `https://${ALLOWED}/hook`, method: 'POST', next: 'x' },
    x: { type: 'exit' },
  },
};

const noopSqs = { async send() { return {}; } } as unknown as RunDeps['sqs'];

function fakeClient(): WebhookHttpClient & { calls: WebhookRequest[] } {
  const calls: WebhookRequest[] = [];
  return {
    calls,
    async request(req: WebhookRequest): Promise<{ status: number }> {
      calls.push(req);
      return { status: 200 };
    },
  };
}

describe.skipIf(!RUN)('webhook idempotency + concurrency (real Postgres)', () => {
  let admin: Pool;

  beforeAll(async () => {
    admin = adminPool();
    await cleanup();
    await admin.query(
      "INSERT INTO workspaces (id, name, status, settings) VALUES ($1,'W','active',$2::jsonb)",
      [WS, JSON.stringify({ webhook_allowlist: [ALLOWED] })],
    );
    await admin.query('INSERT INTO profiles (id, workspace_id, email) VALUES ($1,$2,$3)', [
      PROF,
      WS,
      'rec@e.test',
    ]);
  });

  afterAll(async () => {
    if (admin) {
      await cleanup();
      await admin.end();
    }
  });

  async function cleanup() {
    await admin.query('DELETE FROM activity_log WHERE workspace_id = $1', [WS]);
    await admin.query('DELETE FROM campaign_enrollments WHERE workspace_id = $1', [WS]);
    await admin.query('DELETE FROM campaigns WHERE workspace_id = $1', [WS]);
    await admin.query('DELETE FROM profiles WHERE workspace_id = $1', [WS]);
    await admin.query('DELETE FROM workspaces WHERE id = $1', [WS]);
  }

  beforeEach(async () => {
    await admin.query('DELETE FROM activity_log WHERE workspace_id = $1', [WS]);
    await admin.query('DELETE FROM campaign_enrollments WHERE workspace_id = $1', [WS]);
    await admin.query('DELETE FROM campaigns WHERE workspace_id = $1', [WS]);
  });

  function deps(client: WebhookHttpClient): RunDeps {
    const reader: Reader = { query: (t, v) => admin.query(t, v as unknown[]) as never };
    return {
      reader,
      sqs: noopSqs,
      withTx: (fn) => withWorkspaceTx(admin, fn),
      runInWorkspaceTx: (w, s) => runStatementsInWorkspaceTx(admin, w, s),
      now: () => new Date('2026-06-19T12:00:00.000Z'),
      dispatchQueueUrl: 'q',
      webhookClient: client,
    };
  }

  async function seed(d: CampaignDefinition): Promise<string> {
    await admin.query(
      "INSERT INTO campaigns (id, workspace_id, name, definition, status) VALUES ($1,$2,'C',$3::jsonb,'active')",
      [CAMP, WS, JSON.stringify(d)],
    );
    const r = await admin.query(
      "INSERT INTO campaign_enrollments (workspace_id, campaign_id, profile_id, current_node, status, next_run_at) VALUES ($1,$2,$3,'t','active', now()) RETURNING id",
      [WS, CAMP, PROF],
    );
    return r.rows[0].id as string;
  }

  it('two concurrent runs → single winner advances; the webhook fires AT MOST ONCE', async () => {
    const id = await seed(WEBHOOK_DEF);
    const client = fakeClient();

    const [a, b] = await Promise.all([
      runEnrollment(deps(client), id),
      runEnrollment(deps(client), id),
    ]);

    const results = [a.result, b.result].sort();
    // Exactly one advanced/completed; the loser skipped (status no longer active).
    expect(results).toContain('completed');
    expect(results).toContain('skipped');

    // The injected client fired AT MOST ONCE (single winner → single webhook).
    expect(client.calls.length).toBeLessThanOrEqual(1);
    expect(client.calls.length).toBe(1);

    // Exactly one webhook activity row (the dedupe marker enforces it).
    const act = await admin.query(
      "SELECT count(*)::int AS n FROM activity_log WHERE workspace_id = $1 AND source = 'webhook' AND dedupe_key = $2",
      [WS, `campaign:${CAMP}:${PROF}:wh`],
    );
    expect(act.rows[0].n).toBe(1);
  });

  it('crash-recovery dedupe: writing the SAME webhook activity twice yields exactly one row', async () => {
    // Simulate the post-commit activity write running twice (a recovery re-run):
    // ON CONFLICT (workspace_id, dedupe_key) WHERE source='webhook' DO NOTHING.
    await admin.query('INSERT INTO profiles (id, workspace_id, email) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [
      PROF,
      WS,
      'rec@e.test',
    ]);
    const stmt = buildWebhookActivityInsert(WS, PROF, CAMP, 'wh', { ok: true, status: 200, attempts: 1 });
    await runStatementsInWorkspaceTx(admin, WS, [stmt]);
    await runStatementsInWorkspaceTx(admin, WS, [stmt]); // re-run (recovery) — no double row
    const act = await admin.query(
      "SELECT count(*)::int AS n FROM activity_log WHERE workspace_id = $1 AND source = 'webhook' AND dedupe_key = $2",
      [WS, `campaign:${CAMP}:${PROF}:wh`],
    );
    expect(act.rows[0].n).toBe(1);
  });

  it('MAX_STEPS_PER_TICK guard: a long chain of inside-window no-ops still terminates (parks as failed)', async () => {
    // Build a chain of >MAX hour_of_day_window(0..23 = always inside → advance)
    // nodes, ending at exit. The tick must hit the loop guard and park-as-failed,
    // never spin. (A webhook is irrelevant here — proves the guard is intact.)
    const nodes: Record<string, unknown> = { t: { type: 'trigger', kind: 'manual', next: 'n0' } };
    const count = MAX_STEPS_PER_TICK + 5;
    for (let i = 0; i < count; i += 1) {
      nodes[`n${i}`] = {
        type: 'hour_of_day_window',
        startHour: 0,
        endHour: 23,
        next: i + 1 < count ? `n${i + 1}` : 'x',
      };
    }
    nodes.x = { type: 'exit' };
    const longDef = { startNode: 't', nodes } as unknown as CampaignDefinition;

    const id = await seed(longDef);
    const client = fakeClient();
    const r = await runEnrollment(deps(client), id);
    expect(r.result).toBe('skipped'); // 'max steps per tick exceeded'

    const row = await admin.query('SELECT status FROM campaign_enrollments WHERE id = $1', [id]);
    expect(row.rows[0].status).toBe('failed');
  });
});
