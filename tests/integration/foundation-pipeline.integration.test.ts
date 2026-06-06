// Cross-phase foundation integration (§16A, §18).
//
// Proves phases 2–5 work TOGETHER against a REAL local Postgres, driving the
// ACTUAL production code paths (no re-implementation):
//   ingest core (resolveWorkspaceId + buildProfileUpsert + buildSqsMessage)
//     -> the SQS message body (SQS itself mocked at the boundary)
//     -> processor core (parseProcessorMessage -> planProcessing)
//     -> runPlanInWorkspaceTx (event insert + profile upsert + feature
//        aggregates + realtime segment re-eval), all in one workspace-scoped tx.
//
// The Processor runs as the SERVICE ROLE (bypasses RLS), so isolation here is
// proven IN CODE (workspace_id bound at $1 + the (workspace_id, external_id)
// key), exactly as in production — we run on adminPool() and never SET ROLE.
//
// Gated on DATABASE_URL; skips cleanly when no Postgres is reachable.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminPool, applyMigrations, hasDatabaseUrl } from '@cdp/db';

type Pool = ReturnType<typeof adminPool>;
import type { EventEnvelope } from '@cdp/shared';
import { resolveWorkspaceId, buildProfileUpsert, buildSqsMessage } from '@cdp/service-ingest';
import { parseProcessorMessage, planProcessing, runPlanInWorkspaceTx } from '@cdp/service-processor';

// File-local namespace — events.event_id is a GLOBAL PK, so each integration
// file must use unique workspace ids + event ids to stay parallel-safe.
const WS_A = '0e2e0001-0000-4000-8000-000000000001';
const WS_B = '0e2e0001-0000-4000-8000-000000000002';
const KEY_A = 'e2e-key-A';
const KEY_B = 'e2e-key-B';
const SEG_A = '0e2e0001-0000-4000-8000-0000000000a1'; // "fewer than 3 events" — matchable then not
let evSeq = 0;
const evId = () => `0e2e0001-0000-4000-8000-${String(++evSeq).padStart(12, '0')}`;

const KEY_ROWS: Record<string, { api_key_id: string; workspace_id: string }> = {
  [KEY_A]: { api_key_id: KEY_A, workspace_id: WS_A },
  [KEY_B]: { api_key_id: KEY_B, workspace_id: WS_B },
};

const describeMaybe = hasDatabaseUrl() ? describe : describe.skip;

/**
 * Drive the FULL production pipeline for one event, exactly as ingest+processor
 * would in prod. Returns the processor message that was applied.
 */
async function ingestThenProcess(
  pool: Pool,
  apiKeyId: string,
  externalId: string,
  type: string,
  occurredAt: string,
  attributes: Record<string, unknown> = {},
  eventId = evId(),
): Promise<void> {
  // --- INGEST (real core) ---
  const envelope: EventEnvelope = {
    event_id: eventId,
    external_id: externalId,
    type,
    occurred_at: occurredAt,
    attributes,
  };
  const workspaceId = resolveWorkspaceId(apiKeyId, KEY_ROWS[apiKeyId]); // never from payload
  const upsert = buildProfileUpsert(workspaceId, externalId, type === 'profile_created' ? attributes : {});
  const { rows } = await pool.query(upsert.text, upsert.values);
  const profileId = rows[0].id as string;
  const sqs = buildSqsMessage(workspaceId, profileId, envelope, 'https://sqs.local/q.fifo');
  const body = sqs.input.MessageBody as string; // SQS mocked at the boundary: take the body ingest enqueued

  // --- PROCESSOR (real core + prod tx path, incl. realtime segment re-eval) ---
  const msg = parseProcessorMessage(body);
  await runPlanInWorkspaceTx(pool, msg.workspace_id, planProcessing(msg));
}

async function features(pool: Pool, ws: string, externalId: string) {
  const { rows } = await pool.query(
    `SELECT pf.total_events, pf.monetary_total, pf.counters
       FROM profile_features pf
       JOIN profiles p ON p.id = pf.profile_id
      WHERE p.workspace_id = $1 AND p.external_id = $2`,
    [ws, externalId],
  );
  return rows[0];
}

async function profileCount(pool: Pool, ws: string, externalId: string): Promise<number> {
  const { rows } = await pool.query(
    'SELECT count(*)::int AS n FROM profiles WHERE workspace_id = $1 AND external_id = $2',
    [ws, externalId],
  );
  return rows[0].n;
}

async function changeLog(pool: Pool, ws: string, externalId: string): Promise<string[]> {
  const { rows } = await pool.query(
    `SELECT scl.action
       FROM segment_change_log scl
       JOIN profiles p ON p.id = scl.profile_id
      WHERE scl.workspace_id = $1 AND p.external_id = $2
      ORDER BY scl.occurred_at, scl.id`,
    [ws, externalId],
  );
  return rows.map((r: { action: string }) => r.action);
}

async function membershipCount(pool: Pool, ws: string, externalId: string): Promise<number> {
  const { rows } = await pool.query(
    `SELECT count(*)::int AS n
       FROM segment_memberships sm
       JOIN profiles p ON p.id = sm.profile_id
      WHERE sm.workspace_id = $1 AND p.external_id = $2`,
    [ws, externalId],
  );
  return rows[0].n;
}

describeMaybe('foundation pipeline (ingest -> processor -> features -> segments)', () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = adminPool();
    // Apply migrations only on a fresh DB; the shared local DB is already migrated.
    const { rows } = await pool.query(
      "SELECT to_regclass('public.workspaces') IS NOT NULL AS exists",
    );
    if (!rows[0].exists) await applyMigrations(pool);
    // Clean this file's namespace.
    await pool.query('DELETE FROM segment_change_log WHERE workspace_id = ANY($1)', [[WS_A, WS_B]]);
    await pool.query('DELETE FROM segment_memberships WHERE workspace_id = ANY($1)', [[WS_A, WS_B]]);
    await pool.query('DELETE FROM segments WHERE workspace_id = ANY($1)', [[WS_A, WS_B]]);
    await pool.query('DELETE FROM profile_features WHERE workspace_id = ANY($1)', [[WS_A, WS_B]]);
    await pool.query('DELETE FROM events WHERE workspace_id = ANY($1)', [[WS_A, WS_B]]);
    await pool.query('DELETE FROM profiles WHERE workspace_id = ANY($1)', [[WS_A, WS_B]]);
    await pool.query('DELETE FROM workspace_api_keys WHERE workspace_id = ANY($1)', [[WS_A, WS_B]]);
    await pool.query('DELETE FROM workspaces WHERE id = ANY($1)', [[WS_A, WS_B]]);

    await pool.query(
      `INSERT INTO workspaces (id, name, status) VALUES ($1,'WS A','active'),($2,'WS B','active')`,
      [WS_A, WS_B],
    );
    await pool.query(
      `INSERT INTO workspace_api_keys (api_key_id, workspace_id) VALUES ($1,$2),($3,$4)`,
      [KEY_A, WS_A, KEY_B, WS_B],
    );
    // A realtime segment that matches "fewer than 3 events" — matchable early,
    // then NOT once a 3rd event lands (lets us prove enter-once/exit-once purely
    // from monotonic event-driven aggregates).
    await pool.query(
      `INSERT INTO segments (id, workspace_id, name, definition, kind, status)
       VALUES ($1,$2,'few-events',$3::jsonb,'dynamic_realtime','active')`,
      [
        SEG_A,
        WS_A,
        JSON.stringify({ op: 'and', conditions: [{ field: 'total_events', operator: '<', value: 3 }] }),
      ],
    );
  });

  afterAll(async () => {
    await pool.end();
  });

  it('AC1 — tenant isolation across the full pipeline (A and B share an external_id/email)', async () => {
    const ext = 'shared-customer';
    const t = '2026-01-01T00:00:00.000Z';
    await ingestThenProcess(pool, KEY_A, ext, 'profile_created', t, { email: 'same@x.com', plan: 'gold' });
    await ingestThenProcess(pool, KEY_B, ext, 'profile_created', t, { email: 'same@x.com', plan: 'silver' });
    // One more event for A only.
    await ingestThenProcess(pool, KEY_A, ext, 'progress', '2026-01-01T01:00:00.000Z');

    // Distinct profiles, one per workspace.
    expect(await profileCount(pool, WS_A, ext)).toBe(1);
    expect(await profileCount(pool, WS_B, ext)).toBe(1);

    // A saw 2 events, B saw exactly 1 — no cross-bleed.
    expect((await features(pool, WS_A, ext)).total_events).toBe(2);
    expect((await features(pool, WS_B, ext)).total_events).toBe(1);

    // A's attributes are A's, B's are B's.
    const aPlan = (
      await pool.query('SELECT attributes->>$2 AS plan FROM profiles WHERE workspace_id=$1 AND external_id=$3', [
        WS_A,
        'plan',
        ext,
      ])
    ).rows[0].plan;
    const bPlan = (
      await pool.query('SELECT attributes->>$2 AS plan FROM profiles WHERE workspace_id=$1 AND external_id=$3', [
        WS_B,
        'plan',
        ext,
      ])
    ).rows[0].plan;
    expect(aPlan).toBe('gold');
    expect(bPlan).toBe('silver');
  });

  it('AC2 — ordering convergence: created->progress AND progress-first both yield ONE profile', async () => {
    // created -> progress
    const e1 = 'order-created-first';
    await ingestThenProcess(pool, KEY_A, e1, 'profile_created', '2026-02-01T00:00:00.000Z', { k: 'v' });
    await ingestThenProcess(pool, KEY_A, e1, 'progress', '2026-02-01T01:00:00.000Z');
    expect(await profileCount(pool, WS_A, e1)).toBe(1);
    expect((await features(pool, WS_A, e1)).total_events).toBe(2);

    // progress-first (stub) -> created
    const e2 = 'order-progress-first';
    await ingestThenProcess(pool, KEY_A, e2, 'progress', '2026-02-02T01:00:00.000Z');
    await ingestThenProcess(pool, KEY_A, e2, 'profile_created', '2026-02-02T00:00:00.000Z', { k: 'late' });
    expect(await profileCount(pool, WS_A, e2)).toBe(1);
    expect((await features(pool, WS_A, e2)).total_events).toBe(2);
    const plan = (
      await pool.query('SELECT attributes->>$2 AS k FROM profiles WHERE workspace_id=$1 AND external_id=$3', [
        WS_A,
        'k',
        e2,
      ])
    ).rows[0].k;
    expect(plan).toBe('late'); // profile_created attributes merged onto the stub
  });

  it('AC3 — idempotency: replaying the same event_id changes nothing', async () => {
    const ext = 'idem-customer';
    const fixedId = evId();
    await ingestThenProcess(pool, KEY_A, ext, 'purchase', '2026-03-01T00:00:00.000Z', { amount: 40 }, fixedId);
    const before = await features(pool, WS_A, ext);
    expect(before.total_events).toBe(1);
    expect(Number(before.monetary_total)).toBe(40);

    // Replay the SAME event_id (at-least-once delivery).
    await ingestThenProcess(pool, KEY_A, ext, 'purchase', '2026-03-01T00:00:00.000Z', { amount: 40 }, fixedId);
    const after = await features(pool, WS_A, ext);
    expect(after.total_events).toBe(1); // not 2
    expect(Number(after.monetary_total)).toBe(40); // not 80

    const { rows } = await pool.query(
      'SELECT count(*)::int AS n FROM events WHERE workspace_id=$1 AND event_id=$2',
      [WS_A, fixedId],
    );
    expect(rows[0].n).toBe(1);
  });

  it('AC4 — segment enter-once / exit-once end-to-end, never another workspace', async () => {
    const ext = 'seg-customer';
    // Event 1 -> total_events=1 (<3) -> ENTERS the "few-events" segment.
    await ingestThenProcess(pool, KEY_A, ext, 'progress', '2026-04-01T00:00:00.000Z');
    expect(await membershipCount(pool, WS_A, ext)).toBe(1);
    expect(await changeLog(pool, WS_A, ext)).toEqual(['entered']);

    // Event 2 -> total_events=2 (<3) -> still matches -> NO change.
    await ingestThenProcess(pool, KEY_A, ext, 'progress', '2026-04-01T01:00:00.000Z');
    expect(await membershipCount(pool, WS_A, ext)).toBe(1);
    expect(await changeLog(pool, WS_A, ext)).toEqual(['entered']);

    // Event 3 -> total_events=3 (NOT <3) -> EXITS once.
    await ingestThenProcess(pool, KEY_A, ext, 'progress', '2026-04-01T02:00:00.000Z');
    expect(await membershipCount(pool, WS_A, ext)).toBe(0);
    expect(await changeLog(pool, WS_A, ext)).toEqual(['entered', 'exited']);

    // Workspace B has the same external_id and a matching feature count, but no
    // segment of its own -> never enters A's segment, no membership/change_log.
    await ingestThenProcess(pool, KEY_B, ext, 'progress', '2026-04-01T00:00:00.000Z');
    expect(await membershipCount(pool, WS_B, ext)).toBe(0);
    expect(await changeLog(pool, WS_B, ext)).toEqual([]);
  });
});
