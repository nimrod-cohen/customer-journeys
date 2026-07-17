// Phase 3 (real Postgres): event-trigger enrollment is wired at processor/ingest
// time. This test reproduces the SAME shape the processor / local dev path uses —
// the event row is written, then the enroll hook fires ON THE SAME tx client
// (no nested BEGIN/COMMIT). It proves: the hook fires after the event lands; it's
// idempotent even when the event insert was an ON CONFLICT no-op; a non-matching
// event leaves automation_enrollments empty and never throws.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { adminPool, hasDatabaseUrl } from '@cdp/db';
import { enrollFromEvent, type EnrollDeps, type Reader } from '../src/enroll.js';
import type { EventRow } from '../src/core.js';
import type { AutomationDefinition } from '../src/dsl.js';

const RUN = hasDatabaseUrl();
const WS = 'ca110002-0000-0000-0000-0000000000f5';

const eventDef = (eventType: string): AutomationDefinition =>
  ({
    startNode: 'trig',
    nodes: { trig: { type: 'trigger', kind: 'event', eventType, next: 'x' }, x: { type: 'exit' } },
  }) as unknown as AutomationDefinition;

describe.skipIf(!RUN)('event enrollment from a processor-style tx (real Postgres)', () => {
  let admin: Pool;

  beforeAll(async () => {
    admin = adminPool();
    await cleanup();
    await admin.query("INSERT INTO workspaces (id, name, status) VALUES ($1,'W','active')", [WS]);
  });

  afterAll(async () => {
    if (admin) {
      await cleanup();
      await admin.end();
    }
  });

  async function cleanup(): Promise<void> {
    await admin.query('DELETE FROM automation_enrollments WHERE workspace_id = $1', [WS]);
    await admin.query('DELETE FROM events WHERE workspace_id = $1', [WS]);
    await admin.query('DELETE FROM automations WHERE workspace_id = $1', [WS]);
    await admin.query('DELETE FROM profiles WHERE workspace_id = $1', [WS]);
    await admin.query('DELETE FROM workspaces WHERE id = $1', [WS]);
  }

  async function newProfile(ext: string): Promise<string> {
    const r = await admin.query('INSERT INTO profiles (workspace_id, external_id) VALUES ($1,$2) RETURNING id', [WS, ext]);
    return r.rows[0].id as string;
  }
  async function newAutomation(def: AutomationDefinition): Promise<string> {
    const r = await admin.query(
      "INSERT INTO automations (workspace_id, name, definition, status) VALUES ($1,'C',$2::jsonb,'active') RETURNING id",
      [WS, JSON.stringify(def)],
    );
    return r.rows[0].id as string;
  }

  /**
   * Mirror the processor / local dev path: in ONE tx on a single client, write the
   * event row (ON CONFLICT(event_id) DO NOTHING) then run enrollFromEvent on the
   * SAME client (deps bound to that client, NOT a fresh pool/tx).
   */
  async function recordEventAndEnroll(profileId: string, type: string, payload: Record<string, unknown>, eventId: string) {
    const client = await admin.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO events (event_id, workspace_id, profile_id, type, occurred_at, payload)
         VALUES ($1,$2,$3,$4, now(), $5::jsonb) ON CONFLICT (event_id) DO NOTHING`,
        [eventId, WS, profileId, type, JSON.stringify(payload)],
      );
      const deps: EnrollDeps = {
        reader: { query: (t, v) => client.query(t, v as unknown[]) as never } as Reader,
        runInWorkspaceTx: async (_w, statements) => {
          for (const s of statements) await client.query(s.text, s.values);
        },
      };
      const ev: EventRow = { workspace_id: WS, profile_id: profileId, type, payload, event_id: eventId };
      await enrollFromEvent(deps, ev);
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  }

  async function enrollCount(profileId: string): Promise<number> {
    const r = await admin.query('SELECT count(*)::int n FROM automation_enrollments WHERE workspace_id = $1 AND profile_id = $2', [WS, profileId]);
    return r.rows[0].n as number;
  }

  it('the hook fires after the event lands — both the event row and the enrollment exist', async () => {
    await newAutomation(eventDef('signup'));
    const prof = await newProfile('p-proc');
    await recordEventAndEnroll(prof, 'signup', {}, 'ca110002-0000-0000-0000-000000000001');
    const ev = await admin.query('SELECT 1 FROM events WHERE workspace_id = $1 AND event_id = $2', [WS, 'ca110002-0000-0000-0000-000000000001']);
    expect(ev.rowCount).toBe(1);
    expect(await enrollCount(prof)).toBe(1);
  });

  it('a replayed event_id (event insert is a no-op) does NOT cause a second enrollment', async () => {
    await newAutomation(eventDef('replay2'));
    const prof = await newProfile('p-proc-replay');
    await recordEventAndEnroll(prof, 'replay2', {}, 'ca110002-0000-0000-0000-000000000002');
    await recordEventAndEnroll(prof, 'replay2', {}, 'ca110002-0000-0000-0000-000000000002'); // same event_id
    expect(await enrollCount(prof)).toBe(1);
  });

  it('an event with no matching automation leaves automation_enrollments empty (no-op, never throws)', async () => {
    const prof = await newProfile('p-proc-nomatch');
    await recordEventAndEnroll(prof, 'unmatched', {}, 'ca110002-0000-0000-0000-000000000003');
    expect(await enrollCount(prof)).toBe(0);
  });
});
