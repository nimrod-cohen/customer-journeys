// Integration-test utilities for the DB tier (§16A, §3).
//
// IMPORTANT: these helpers are for tests only — they are NOT used by service
// code. They let an integration test:
//   1. set the per-session `request.jwt.claims` (so RLS policies see a
//      workspace_id / sub / is_platform_admin claim), and
//   2. seed cross-workspace fixtures via a service-role/superuser connection
//      that bypasses RLS, then prove that a NON-BYPASSRLS role is correctly
//      blocked from reading another workspace's rows.
//
// The RLS integration tests MUST run as a role WITHOUT BYPASSRLS or they pass
// vacuously (the superuser/owner used by Supabase CLI bypasses RLS).
import { Pool, type PoolClient } from 'pg';

/** Claims to inject into `request.jwt.claims` for a session (§3, §6). */
export interface SessionClaims {
  readonly workspace_id?: string | null;
  readonly sub?: string | null;
  readonly is_platform_admin?: boolean;
}

/**
 * Set `request.jwt.claims` for the current session/transaction via set_config.
 * Mirrors what Supabase/PostgREST does per request so RLS policies resolve the
 * caller's workspace. Use `local = true` inside a transaction to scope to it.
 */
export async function setSessionClaims(
  client: PoolClient,
  claims: SessionClaims,
  local = false,
): Promise<void> {
  const json = JSON.stringify({
    ...(claims.workspace_id !== undefined ? { workspace_id: claims.workspace_id } : {}),
    ...(claims.sub !== undefined ? { sub: claims.sub } : {}),
    ...(claims.is_platform_admin !== undefined
      ? { is_platform_admin: claims.is_platform_admin }
      : {}),
  });
  await client.query('SELECT set_config($1, $2, $3)', [
    'request.jwt.claims',
    json,
    local,
  ]);
}

/** Clear any session claims (simulate an unauthenticated connection). */
export async function clearSessionClaims(client: PoolClient): Promise<void> {
  await client.query('SELECT set_config($1, $2, $3)', ['request.jwt.claims', '', false]);
}

/**
 * The name of the test-only NON-BYPASSRLS application role. Created by
 * `ensureTestAppRole`. RLS integration tests connect/SET ROLE to this so the
 * policies are actually exercised.
 */
export const TEST_APP_ROLE = 'cdp_app_test';

/**
 * A stable, arbitrary advisory-lock key for serializing the role/grant DDL
 * below. Integration test files run in parallel (within a package and across
 * packages) and each call `ensureTestAppRole` against the SAME shared Postgres.
 * Concurrent `ALTER ROLE` / `GRANT` mutate the same `pg_authid` / catalog
 * tuples and race with `tuple concurrently updated` (XX000). Holding a single
 * transaction-scoped advisory lock around the whole DDL sequence serializes
 * those mutations so the work is performed safely under contention. The DDL is
 * also fully idempotent, so repeated calls are no-ops after the first.
 */
const ROLE_SETUP_LOCK_KEY = 0x6364705f74737421n; // 'cdp_tst!' as bigint

/**
 * Create (idempotently) a NON-superuser, NON-BYPASSRLS role for RLS tests and
 * grant it DML on the public schema. Must be called with a superuser connection.
 * The role has NOLOGIN by default — tests `SET ROLE` to it within a transaction
 * on the superuser connection, or it can be granted LOGIN for a separate pool.
 *
 * Concurrency-safe: the role-creation / `ALTER ROLE` / `GRANT` DDL runs inside a
 * single transaction guarded by `pg_advisory_xact_lock`, so parallel callers
 * (multiple test files / packages sharing the same database) are serialized and
 * never hit `tuple concurrently updated`. We acquire a dedicated client so the
 * transaction + xact-scoped lock are correctly bound to one connection.
 */
export async function ensureTestAppRole(admin: PoolClient | Pool): Promise<void> {
  // `Pool` has `connect()`; a `PoolClient` is already a single connection.
  const isPool = typeof (admin as Pool).connect === 'function';
  const client: PoolClient | Pool = isPool ? await (admin as Pool).connect() : admin;
  try {
    await client.query('BEGIN');
    // Serialize all catalog-mutating DDL below across concurrent callers. The
    // lock is released automatically at COMMIT/ROLLBACK.
    await client.query('SELECT pg_advisory_xact_lock($1)', [ROLE_SETUP_LOCK_KEY.toString()]);
    await client.query(`DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${TEST_APP_ROLE}') THEN
          CREATE ROLE ${TEST_APP_ROLE} NOLOGIN NOBYPASSRLS;
        END IF;
      END $$;`);
    // Ensure it never bypasses RLS even if it pre-existed with other attributes.
    await client.query(`ALTER ROLE ${TEST_APP_ROLE} NOBYPASSRLS`);
    await client.query(`GRANT USAGE ON SCHEMA public TO ${TEST_APP_ROLE}`);
    await client.query(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${TEST_APP_ROLE}`,
    );
    await client.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${TEST_APP_ROLE}`);
    await client.query(`GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO ${TEST_APP_ROLE}`);
    await client.query('COMMIT');
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* ignore rollback errors */
    }
    throw err;
  } finally {
    if (isPool) (client as PoolClient).release();
  }
}

/** Whether a DATABASE_URL is configured (gate for the integration tier). */
export function hasDatabaseUrl(): boolean {
  return Boolean(process.env.DATABASE_URL ?? process.env.DATABASE_POOL_URL);
}

/** Open an admin (service-role/superuser) pool for seeding + role setup. */
export function adminPool(): Pool {
  const connectionString = process.env.DATABASE_URL ?? process.env.DATABASE_POOL_URL;
  if (!connectionString) throw new Error('DATABASE_URL is required for integration tests');
  return new Pool({ connectionString, max: 4 });
}
