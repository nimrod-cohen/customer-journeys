import { Pool, type PoolConfig } from 'pg';

/**
 * Pooled `pg` client helper.
 *
 * Connection management only — this module intentionally contains NO queries.
 * Query logic (and mandatory `workspace_id` scoping) lives in the service code
 * and the segments compiler. See CDP-BUILD-SPEC.md §3, §6, §8.
 *
 * NOTE (tenancy invariant): service-role connections bypass Postgres RLS, so
 * every query issued through this pool MUST scope by `workspace_id` in code.
 * RLS is the guard for user-context (admin app) connections only.
 */

let pool: Pool | undefined;

/** Resolve the pooled connection string (Supabase pgbouncer / Lambda parity). */
function resolveConnectionString(): string {
  const url = process.env.DATABASE_POOL_URL ?? process.env.DATABASE_URL;
  if (!url) {
    throw new Error('DATABASE_POOL_URL or DATABASE_URL must be set');
  }
  return url;
}

/**
 * Get the process-wide pooled client, creating it on first use.
 * Lambda containers are reused, so a module-level singleton pool keeps
 * connection counts bounded across warm invocations.
 */
export function getPool(overrides: PoolConfig = {}): Pool {
  if (!pool) {
    pool = new Pool({
      connectionString: resolveConnectionString(),
      // Conservative ceiling: many concurrent Lambda containers share the
      // Supabase pooler, so keep per-container pools small.
      max: 5,
      idleTimeoutMillis: 10_000,
      connectionTimeoutMillis: 5_000,
      ...overrides,
    });
  }
  return pool;
}

/** Close the pool (tests / graceful shutdown). */
export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = undefined;
  }
}
