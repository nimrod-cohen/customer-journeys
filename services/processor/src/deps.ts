// Real (production) processor dependencies (§7).
//
// The Processor connects with the SERVICE ROLE which BYPASSES RLS — so isolation
// comes from in-code workspace_id scoping (every statement in the plan binds
// workspace_id at $1) and the (workspace_id, external_id) key, NOT RLS. All of a
// message's statements run in ONE transaction so a record is applied atomically;
// a failure rolls back and the handler reports a batch item failure (→ DLQ).
import type { Pool, PoolClient } from 'pg';
import { getPool } from '@cdp/db';
import { evaluateRealtimeSegmentsForProfile, type EvaluateDeps } from '@cdp/segments';
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
    // Phase 5 (§8, §7 step 4/5): re-evaluate active dynamic_realtime segments for
    // the CHANGED profile in the SAME tx, AFTER the feature upsert (post-update
    // features). The evaluator's reads + writes all go through THIS client so the
    // whole record — profile, features, membership, change_log — commits/rolls
    // back atomically. workspace_id is bound at $1 throughout (service role
    // bypasses RLS → in-code scoping is the guard).
    if (plan.segmentReeval) {
      await runSegmentReevalInTx(client, plan.segmentReeval);
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

/**
 * Run realtime segment re-eval for the changed profile on an OPEN tx client.
 *
 * Resolves the concrete profile id from (workspace_id, external_id) within the tx
 * (a progress-first stub is already upserted by the time we get here), then calls
 * the shared evaluator. Both the reader and the tx-runner are bound to THIS
 * client so the evaluator's membership/change_log writes join the SAME
 * transaction — no nested BEGIN/COMMIT. If the profile somehow doesn't exist
 * (shouldn't happen post-upsert), the re-eval is a no-op.
 */
async function runSegmentReevalInTx(
  client: PoolClient,
  reeval: NonNullable<ProcessingPlan['segmentReeval']>,
): Promise<void> {
  const { rows } = await client.query(
    'SELECT id FROM profiles WHERE workspace_id = $1 AND external_id = $2',
    [reeval.workspaceId, reeval.profileExternalId],
  );
  const profileId = rows[0]?.id as string | undefined;
  if (!profileId) return;

  const deps: EvaluateDeps = {
    reader: { query: (text, values) => client.query(text, values) },
    // Already inside a tx on this client → just run the statements, no new tx.
    runInWorkspaceTx: async (_ws, statements) => {
      for (const s of statements) await client.query(s.text, s.values);
    },
  };
  await evaluateRealtimeSegmentsForProfile(deps, reeval.workspaceId, profileId);
}

/** Assemble the production dependency set (pooled pg, service role). */
export function makeProdDeps(): ProcessorDeps {
  const pool: Pool = getPool();
  return {
    runInWorkspaceTx: (workspaceId, plan) => runPlanInWorkspaceTx(pool, workspaceId, plan),
  };
}
