// Real (production) feedback dependencies (§10).
//
// The Feedback Lambda connects with the SERVICE ROLE which BYPASSES RLS — so
// isolation comes from in-code workspace_id scoping. Every statement in a plan
// binds the workspace at $1 EXCEPT the deliberate cross-workspace exception,
// global_hard_bounces (keyed by email only, §10). The tx runner therefore
// asserts each statement is scoped to the requested workspace OR is the
// global_hard_bounces write — and runs them all in ONE transaction so a
// notification's writes commit/roll back atomically.
import type { Pool, PoolClient } from 'pg';
import { getPool } from '@cdp/db';
import type { SqlStatement } from './core.js';
import type { FeedbackDeps, Reader } from './feedback.js';

/** Minimal pool surface so tests can pass an `adminPool()` directly. */
export interface PoolLike {
  connect(): Promise<PoolClient>;
  query(text: string, values?: readonly unknown[]): Promise<{ rows: unknown[] }>;
}

/** True if a statement is the cross-workspace global_hard_bounces write (§10). */
function isGlobalHardBounce(s: SqlStatement): boolean {
  return /global_hard_bounces/i.test(s.text);
}

/**
 * Run a list of feedback statements in ONE transaction. Each statement is
 * asserted to either bind the requested workspace at $1 (in-code scoping; the
 * service role bypasses RLS) OR be the deliberate cross-workspace
 * global_hard_bounces write. Exported standalone so the integration tests
 * exercise the EXACT production write path against real Postgres.
 */
export async function runFeedbackStatementsInTx(
  pool: PoolLike,
  workspaceId: string,
  statements: readonly SqlStatement[],
): Promise<void> {
  for (const s of statements) {
    if (!isGlobalHardBounce(s) && s.values[0] !== workspaceId) {
      throw new Error('runFeedbackStatementsInTx: statement not scoped to the requested workspace');
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
export function makeProdDeps(): FeedbackDeps {
  const pool: Pool = getPool();
  const reader: Reader = {
    async query<T>(text: string, values?: readonly unknown[]): Promise<{ rows: T[] }> {
      const res = await pool.query(text, values as unknown[]);
      return { rows: res.rows as T[] };
    },
  };
  return {
    reader,
    runInWorkspaceTx: (workspaceId, statements) =>
      runFeedbackStatementsInTx(pool, workspaceId, statements),
  };
}
