// Apply the SQL migrations in order against a pooled connection (§6).
//
// Used by the integration tests when bootstrapping a fresh Postgres (e.g. a
// Testcontainers instance) without the Supabase CLI. The Supabase CLI applies
// the same files via `supabase db reset`; this is the CLI-less path.
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { Pool, PoolClient } from 'pg';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Absolute path to the migrations directory (works from src and dist). */
export const MIGRATIONS_DIR = join(__dirname, '..', 'supabase', 'migrations');

/**
 * Read and execute every `*.sql` migration in lexical order. Idempotent only if
 * the migrations themselves are; intended for a fresh database. Used by the test
 * tiers to bootstrap a clean Postgres. For the SERVER boot use
 * `runPendingMigrations`, which tracks + applies only what's outstanding.
 */
export async function applyMigrations(
  conn: Pool | PoolClient,
  dir: string = MIGRATIONS_DIR,
): Promise<string[]> {
  const entries = (await readdir(dir))
    .filter((f) => f.endsWith('.sql'))
    .sort((a, b) => a.localeCompare(b));
  for (const file of entries) {
    const sql = await readFile(join(dir, file), 'utf8');
    await conn.query(sql);
  }
  return entries;
}

/** Advisory-lock key so only ONE instance migrates at a time (belt-and-suspenders
 *  atop the single-runner APP_MODE gate). Arbitrary fixed bigint. */
const MIGRATION_LOCK_KEY = 4242000055;

/**
 * The last migration prefix applied to the PROD DB before this tracked runner
 * existed. That DB has the full schema through 0053 but no `schema_migrations`
 * rows, so on first run we BASELINE — record every migration ≤ this prefix as
 * already-applied WITHOUT re-running it — then apply 0054+. A FRESH DB (baseline
 * table absent) skips baselining and applies everything.
 */
const BASELINE_MIGRATION_PREFIX = 53;

export interface RunMigrationsOptions {
  readonly dir?: string;
  /** Tracking table name (default `schema_migrations`). */
  readonly trackingTable?: string;
  /** If tracking is empty AND this table exists, baseline (see BASELINE_MIGRATION_PREFIX). Default `workspaces`. */
  readonly baselineTable?: string;
  /** Record migrations with a numeric prefix ≤ this as already-applied when baselining. */
  readonly baselinePrefix?: number;
  readonly lockKey?: number;
}

/** Numeric prefix of a migration filename (`0053_x.sql` → 53); NaN-safe → -1. */
function migrationPrefix(file: string): number {
  const n = Number.parseInt(file.slice(0, 4), 10);
  return Number.isNaN(n) ? -1 : n;
}

/**
 * Apply only the migrations not yet recorded in the tracking table, in lexical
 * order, each in its OWN transaction (a failure rolls that migration back and
 * throws — the caller should fail the boot so a bad migration never half-applies
 * or lets new code run on old schema). Safe to call on every deploy: an
 * up-to-date DB applies nothing. Serialized by an advisory lock. See
 * BASELINE_MIGRATION_PREFIX for how a pre-existing (untracked) DB is adopted.
 */
export async function runPendingMigrations(
  pool: Pool,
  opts: RunMigrationsOptions = {},
): Promise<{ applied: string[]; baselined: string[] }> {
  const dir = opts.dir ?? MIGRATIONS_DIR;
  const tracking = opts.trackingTable ?? 'schema_migrations';
  const baselineTable = opts.baselineTable ?? 'workspaces';
  const baselinePrefix = opts.baselinePrefix ?? BASELINE_MIGRATION_PREFIX;
  const lockKey = opts.lockKey ?? MIGRATION_LOCK_KEY;

  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [lockKey]);
    await client.query(
      `CREATE TABLE IF NOT EXISTS ${tracking} (
         version    text PRIMARY KEY,
         applied_at timestamptz NOT NULL DEFAULT now()
       )`,
    );
    // Backend-only bookkeeping table in the `public` schema → enable RLS (no policy)
    // so it isn't exposed through Supabase's PostgREST anon API (Security Advisor:
    // "RLS Disabled in Public"). The migrator role bypasses RLS, so this doesn't
    // affect the runner's own reads/writes. Idempotent.
    await client.query(`ALTER TABLE ${tracking} ENABLE ROW LEVEL SECURITY`);
    const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort((a, b) => a.localeCompare(b));
    const { rows } = await client.query<{ version: string }>(`SELECT version FROM ${tracking}`);
    const applied = new Set(rows.map((r) => r.version));

    // BASELINE an existing, untracked DB (has the schema but no tracking rows).
    const baselined: string[] = [];
    if (applied.size === 0) {
      const { rows: ex } = await client.query<{ exists: boolean }>(
        'SELECT to_regclass($1) IS NOT NULL AS exists',
        [`public.${baselineTable}`],
      );
      if (ex[0]?.exists) {
        for (const f of files) {
          if (migrationPrefix(f) <= baselinePrefix) {
            await client.query(`INSERT INTO ${tracking}(version) VALUES ($1) ON CONFLICT DO NOTHING`, [f]);
            applied.add(f);
            baselined.push(f);
          }
        }
      }
    }

    const appliedNow: string[] = [];
    for (const f of files) {
      if (applied.has(f)) continue;
      const sql = await readFile(join(dir, f), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query(`INSERT INTO ${tracking}(version) VALUES ($1)`, [f]);
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        throw new Error(`migration ${f} failed: ${(e as Error).message}`);
      }
      appliedNow.push(f);
    }
    return { applied: appliedNow, baselined };
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [lockKey]).catch(() => {});
    client.release();
  }
}
