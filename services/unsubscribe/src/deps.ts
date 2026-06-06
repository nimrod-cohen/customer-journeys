// Real (production) unsubscribe dependencies (§10).
//
// The Unsubscribe Lambda connects with the SERVICE ROLE which BYPASSES RLS — so
// isolation comes from in-code workspace_id scoping: the suppression statement
// binds workspace_id (from the workspace-scoped link) at $1. We run it in ONE
// transaction and assert the statement is scoped to the requested workspace.
import type { Pool, PoolClient } from 'pg';
import { getPool } from '@cdp/db';
import type { SqlStatement } from './core.js';
import type { UnsubscribeDeps } from './handler.js';

/** Minimal pool surface so tests can pass an `adminPool()` directly. */
export interface PoolLike {
  connect(): Promise<PoolClient>;
}

/**
 * Run the unsubscribe statement(s) in ONE transaction. Each statement is
 * asserted to bind the requested workspace at $1 (in-code scoping; the service
 * role bypasses RLS). Exported standalone so the integration test exercises the
 * EXACT production write path against real Postgres.
 */
export async function runUnsubscribeInWorkspaceTx(
  pool: PoolLike,
  workspaceId: string,
  statements: readonly SqlStatement[],
): Promise<void> {
  for (const s of statements) {
    if (s.values[0] !== workspaceId) {
      throw new Error('runUnsubscribeInWorkspaceTx: statement not scoped to the requested workspace');
    }
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const s of statements) {
      await client.query(s.text, s.values);
    }
    await client.query('COMMIT');
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* ignore rollback errors */
    }
    throw err;
  } finally {
    client.release();
  }
}

/** Assemble the production dependency set (pooled pg, service role). */
export function makeProdDeps(): UnsubscribeDeps {
  const pool: Pool = getPool();
  return {
    runInWorkspaceTx: (workspaceId, statements) =>
      runUnsubscribeInWorkspaceTx(pool, workspaceId, statements),
  };
}
