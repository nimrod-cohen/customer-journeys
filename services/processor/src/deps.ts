// Real (production) processor dependencies (§7).
//
// The Processor connects with the SERVICE ROLE which BYPASSES RLS — so isolation
// comes from in-code workspace_id scoping (every statement in the plan binds
// workspace_id at $1) and the (workspace_id, external_id) key, NOT RLS. All of a
// message's statements run in ONE transaction so a record is applied atomically;
// a failure rolls back and the handler reports a batch item failure (→ DLQ).
import type { Pool, PoolClient } from 'pg';
import { getPool } from '@cdp/db';
import type { ProcessingPlan } from './core.js';
import type { ProcessorDeps } from './handler.js';

/** Minimal pool surface so tests can pass an `adminPool()` directly. */
export interface PoolLike {
  connect(): Promise<PoolClient>;
}

/**
 * Apply a processing plan inside a single workspace-scoped transaction.
 *
 * Every statement is already workspace-scoped (workspace_id bound at $1 in the
 * pure core). We additionally assert the plan's workspaceId matches the requested
 * workspace as a defensive guard. Exported standalone so the integration tests
 * exercise the EXACT production code path against real Postgres.
 */
export async function runPlanInWorkspaceTx(
  pool: PoolLike,
  workspaceId: string,
  plan: ProcessingPlan,
): Promise<void> {
  if (plan.workspaceId !== workspaceId) {
    throw new Error('runPlanInWorkspaceTx: plan workspace does not match requested workspace');
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const stmt of plan.statements) {
      await client.query(stmt.text, stmt.values);
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
export function makeProdDeps(): ProcessorDeps {
  const pool: Pool = getPool();
  return {
    runInWorkspaceTx: (workspaceId, plan) => runPlanInWorkspaceTx(pool, workspaceId, plan),
  };
}
