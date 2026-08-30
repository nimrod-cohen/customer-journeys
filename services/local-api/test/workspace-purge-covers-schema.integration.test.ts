// Deleting a workspace must delete ALL of its data — and the hand-maintained list
// of child tables must not drift from the schema.
//
// It had drifted badly: eleven tables were missing, so deleting any workspace that
// had ever had a sending domain, a topic, an asset or a tracked link failed with a
// foreign-key violation and left the workspace undeletable. Nothing caught it
// because nothing compared the list to the database.
//
// So this asserts the list against the live catalog rather than against another
// hand-written list — a new workspace-scoped table makes this test fail until it is
// either added to the purge or given ON DELETE CASCADE.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { hasDatabaseUrl, adminPool } from '@cdp/db';
import { WORKSPACE_CHILD_TABLES } from '../src/handlers.js';
import type { Pool } from 'pg';

const describeMaybe = hasDatabaseUrl() ? describe : describe.skip;

describeMaybe('workspace purge covers the whole schema (real Postgres)', () => {
  let pool: Pool;

  beforeAll(() => {
    pool = adminPool();
  });
  afterAll(async () => {
    if (pool) await pool.end();
  });

  /** Tables whose workspace_id FK blocks a delete until the rows are gone. */
  async function tablesNeedingExplicitDelete(): Promise<string[]> {
    const { rows } = await pool.query<{ tbl: string }>(
      `SELECT DISTINCT c.conrelid::regclass::text AS tbl
         FROM pg_constraint c
        WHERE c.contype = 'f'
          AND c.confrelid = 'workspaces'::regclass
          AND c.confdeltype = 'a'   -- NO ACTION: must be deleted first
        ORDER BY 1`,
    );
    return rows.map((r) => r.tbl);
  }

  it('lists every table that blocks a workspace delete', async () => {
    const needed = await tablesNeedingExplicitDelete();
    const listed = new Set<string>(WORKSPACE_CHILD_TABLES);
    const missing = needed.filter((t) => !listed.has(t));
    expect(
      missing,
      `WORKSPACE_CHILD_TABLES is missing ${missing.length} table(s). Add them (in FK-safe order) or give the FK ON DELETE CASCADE.`,
    ).toEqual([]);
  });

  it('lists nothing that no longer exists', async () => {
    const { rows } = await pool.query<{ tbl: string }>(
      `SELECT table_name AS tbl FROM information_schema.tables WHERE table_schema = 'public'`,
    );
    const real = new Set(rows.map((r) => r.tbl));
    const stale = WORKSPACE_CHILD_TABLES.filter((t) => !real.has(t));
    expect(stale, `WORKSPACE_CHILD_TABLES names table(s) that do not exist: ${stale.join(', ')}`).toEqual([]);
  });

  // Order is as load-bearing as membership: a table must be deleted before anything
  // it points at, or the delete fails halfway through the transaction.
  it('orders every table before the ones it references', async () => {
    const { rows } = await pool.query<{ child: string; parent: string }>(
      `SELECT DISTINCT c.conrelid::regclass::text AS child,
                       c.confrelid::regclass::text AS parent
         FROM pg_constraint c
        WHERE c.contype = 'f'
          AND c.confrelid <> 'workspaces'::regclass
          AND c.conrelid <> c.confrelid
          -- Only NO ACTION constrains the order. A CASCADE parent takes its
          -- children with it, so the child may safely be listed later (and
          -- automations <-> automation_versions is a genuine cycle that only
          -- resolves because one side cascades).
          AND c.confdeltype = 'a'`,
    );
    const pos = new Map(WORKSPACE_CHILD_TABLES.map((t, i) => [t as string, i]));
    const wrong: string[] = [];
    for (const { child, parent } of rows) {
      const ci = pos.get(child);
      const pi = pos.get(parent);
      // Only meaningful when BOTH are purged explicitly.
      if (ci === undefined || pi === undefined) continue;
      if (ci > pi) wrong.push(`${child} (#${ci}) is deleted after ${parent} (#${pi})`);
    }
    expect(wrong, `Wrong delete order:\n  ${wrong.join('\n  ')}`).toEqual([]);
  });
});
