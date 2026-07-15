// runPendingMigrations (real Postgres): the deploy-time tracked migration runner.
// Proves it applies only outstanding migrations (recorded in a tracking table),
// is idempotent, applies newly-added ones incrementally, fails atomically on a bad
// migration, and BASELINES a pre-existing untracked DB (records ≤prefix as applied
// WITHOUT re-running them, then catches up). Uses a temp dir of fake migrations +
// custom tracking/baseline names so it never touches the real schema.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { hasDatabaseUrl, adminPool, runPendingMigrations } from '../src/index.js';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Pool } from 'pg';

const describeMaybe = hasDatabaseUrl() ? describe : describe.skip;

describeMaybe('runPendingMigrations (real Postgres)', () => {
  let pool: Pool;
  let dir: string;
  const TRACK = 'schema_migrations_rpm_test';
  const T1 = 'rpm_test_t1';
  const T2 = 'rpm_test_t2';
  const T3 = 'rpm_test_t3';
  // baselineTable = T1, baselinePrefix = 1 → 0001_* baselines, 0002+/0003+ apply.
  const opts = () => ({ dir, trackingTable: TRACK, baselineTable: T1, baselinePrefix: 1 });
  const regclass = async (t: string) =>
    (await pool.query<{ x: string | null }>(`SELECT to_regclass('public.${t}') AS x`)).rows[0]!.x;

  beforeAll(async () => {
    pool = adminPool();
    dir = await mkdtemp(join(tmpdir(), 'rpm-'));
    await cleanup();
    await writeFile(join(dir, '0001_a.sql'), `CREATE TABLE ${T1} (id int);`);
    await writeFile(join(dir, '0002_b.sql'), `CREATE TABLE ${T2} (id int);`);
  });
  afterAll(async () => {
    if (pool) {
      await cleanup();
      await pool.end();
    }
    if (dir) await rm(dir, { recursive: true, force: true });
  });
  async function cleanup(): Promise<void> {
    for (const t of [T1, T2, T3]) await pool.query(`DROP TABLE IF EXISTS ${t}`);
    await pool.query(`DROP TABLE IF EXISTS ${TRACK}`);
  }

  it('fresh DB: applies all migrations in order and records them', async () => {
    const r = await runPendingMigrations(pool, opts()); // T1 (baselineTable) absent → no baseline
    expect(r.baselined).toEqual([]);
    expect(r.applied).toEqual(['0001_a.sql', '0002_b.sql']);
    expect(await regclass(T1)).toBeTruthy();
    expect(await regclass(T2)).toBeTruthy();
    const tracked = await pool.query<{ version: string }>(`SELECT version FROM ${TRACK} ORDER BY version`);
    expect(tracked.rows.map((x) => x.version)).toEqual(['0001_a.sql', '0002_b.sql']);
  });

  it('idempotent: a second run applies nothing', async () => {
    const r = await runPendingMigrations(pool, opts());
    expect(r.applied).toEqual([]);
    expect(r.baselined).toEqual([]);
  });

  it('incremental: a newly added migration is applied, earlier ones skipped', async () => {
    await writeFile(join(dir, '0003_c.sql'), `CREATE TABLE ${T3} (id int);`);
    const r = await runPendingMigrations(pool, opts());
    expect(r.applied).toEqual(['0003_c.sql']);
    expect(await regclass(T3)).toBeTruthy();
  });

  it('a failing migration throws and rolls back (nothing recorded, no half-apply)', async () => {
    await writeFile(join(dir, '0004_bad.sql'), `CREATE TABLE ${T3} (id int);`); // T3 exists → error
    await expect(runPendingMigrations(pool, opts())).rejects.toThrow(/0004_bad\.sql failed/);
    const tracked = await pool.query(`SELECT 1 FROM ${TRACK} WHERE version='0004_bad.sql'`);
    expect(tracked.rowCount).toBe(0);
    await rm(join(dir, '0004_bad.sql')); // don't disturb the baseline test
  });

  it('baseline: a pre-existing untracked DB records ≤prefix WITHOUT running, applies the rest', async () => {
    // Simulate a DB that predates the runner: the schema (T1) is already present,
    // T2/T3 are gone, and there is NO tracking table.
    await pool.query(`DROP TABLE IF EXISTS ${TRACK}`);
    await pool.query(`DROP TABLE IF EXISTS ${T2}`);
    await pool.query(`DROP TABLE IF EXISTS ${T3}`);
    // dir now holds 0001_a, 0002_b, 0003_c. T1 (baselineTable) EXISTS → baseline fires.
    const r = await runPendingMigrations(pool, opts());
    expect(r.baselined).toEqual(['0001_a.sql']); // ≤ prefix 1 → recorded, NOT run
    expect(r.applied).toEqual(['0002_b.sql', '0003_c.sql']); // > 1 → applied
    // 0001 was NOT executed — had it run, CREATE TABLE T1 would have errored (T1 exists).
    expect(await regclass(T2)).toBeTruthy();
    expect(await regclass(T3)).toBeTruthy();
    const tracked = await pool.query<{ version: string }>(`SELECT version FROM ${TRACK} ORDER BY version`);
    expect(tracked.rows.map((x) => x.version)).toEqual(['0001_a.sql', '0002_b.sql', '0003_c.sql']);
  });
});
