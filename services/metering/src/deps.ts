// Real (production) metering dependencies (§20, §10). Connects with the SERVICE
// ROLE which BYPASSES RLS — isolation is in-code workspace_id=$1 scoping (every
// statement binds it). Mirrors the batch-eval/dispatcher deps pattern: a pooled
// reader, a workspace-scoped tx runner, and an active-workspace lister. The prod
// SES client is wired here for the dedicated-IP provisioning boundary (mocked in
// tests).
import type { Pool, PoolClient } from 'pg';
import { getPool } from '@cdp/db';
import { ProdSesEmailClient, type SqlStatement } from '@cdp/email';
import type { MeteringHandlerDeps } from './handler.js';

/** Minimal pool surface so tests can pass an `adminPool()` directly. */
export interface PoolLike {
  connect(): Promise<PoolClient>;
  query(text: string, values: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

/**
 * Apply a set of workspace-scoped statements in ONE tx. Each statement binds
 * workspace_id at $1 (in-code scoping; service role bypasses RLS); we assert
 * that defensively so a mis-scoped statement can never run. Exported standalone
 * so integration tests exercise the EXACT production write path against real PG.
 */
export async function runStatementsInWorkspaceTx(
  pool: PoolLike,
  workspaceId: string,
  statements: readonly SqlStatement[],
): Promise<void> {
  for (const s of statements) {
    if (s.values[0] !== workspaceId) {
      throw new Error('runStatementsInWorkspaceTx: statement not scoped to the requested workspace');
    }
  }
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

/** Assemble the production dependency set (pooled pg, service role, prod SES). */
export function makeProdDeps(): MeteringHandlerDeps {
  const pool: Pool = getPool();
  // Constructed for the dedicated-IP provisioning boundary (§10); the scheduled
  // sweeps don't provision, but the prod deps own the SES client so the upgrade
  // orchestrator can reuse it.
  const ses = new ProdSesEmailClient();
  void ses;
  return {
    reader: { query: (text, values) => pool.query(text, values) },
    runInWorkspaceTx: (workspaceId, statements) =>
      runStatementsInWorkspaceTx(pool, workspaceId, statements),
    listActiveWorkspaceIds: async () => {
      const { rows } = await pool.query("SELECT id FROM workspaces WHERE status = 'active'", []);
      return rows.map((r) => r.id as string);
    },
    now: () => new Date(),
  };
}
