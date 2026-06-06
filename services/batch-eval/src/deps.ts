// Real (production) batch-eval dependencies (§8). Connects with the SERVICE ROLE
// which BYPASSES RLS — isolation is in-code workspace_id=$1 scoping (every
// statement from the @cdp/segments builders binds it). Each segment's apply runs
// in its own workspace-scoped tx.
import type { Pool, PoolClient } from 'pg';
import { getPool } from '@cdp/db';
import type { SqlStatement } from '@cdp/segments';
import type { BatchEvalHandlerDeps } from './handler.js';

/** Minimal pool surface so tests can pass an `adminPool()` directly. */
export interface PoolLike {
  connect(): Promise<PoolClient>;
  query(text: string, values: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

/** Apply a set of segment statements in one workspace-scoped tx. */
export async function runStatementsInWorkspaceTx(
  pool: PoolLike,
  _workspaceId: string,
  statements: readonly SqlStatement[],
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const s of statements) await client.query(s.text, s.values);
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
export function makeProdDeps(): BatchEvalHandlerDeps {
  const pool: Pool = getPool();
  return {
    reader: { query: (text, values) => pool.query(text, values) },
    runInWorkspaceTx: (workspaceId, statements) =>
      runStatementsInWorkspaceTx(pool, workspaceId, statements),
    listWorkspaceIds: async () => {
      const { rows } = await pool.query("SELECT id FROM workspaces WHERE status = 'active'", []);
      return rows.map((r) => r.id as string);
    },
  };
}
