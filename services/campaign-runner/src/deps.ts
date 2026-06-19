// Real (production) campaign-runner dependencies (§9B).
//
// The Campaign-runner Lambda connects with the SERVICE ROLE which BYPASSES RLS —
// so isolation comes from in-code workspace_id scoping (every statement binds
// workspace_id at $1), NOT RLS. This module supplies the pooled service-role
// reader, the prod SQS sender (the dispatch queue), the clock, and the
// workspace-scoped tx runner that asserts each statement is scoped to the
// requested workspace before committing.
import type { Pool, PoolClient } from 'pg';
import { getPool, decryptSecret, isEncryptedSecret } from '@cdp/db';
import { fetchWebhookClient } from '@cdp/runner-webhook';
import { SQSClient } from '@aws-sdk/client-sqs';
import type { SqlStatement } from './core.js';
import type { RunDeps, Reader, TxClient } from './run.js';

/** Minimal pool surface so tests can pass an `adminPool()` directly. */
export interface PoolLike {
  connect(): Promise<PoolClient>;
  query(text: string, values?: readonly unknown[]): Promise<{ rows: unknown[] }>;
}

/**
 * Run `fn` inside ONE transaction on a single dedicated connection, giving it a
 * tx-scoped client used for BOTH reads and writes of the whole tick (so a
 * `SELECT … FOR UPDATE` row lock taken inside `fn` is held until COMMIT). Commits
 * when `fn` resolves; rolls back (and rethrows) if it throws. Exported so the
 * integration tests exercise the EXACT production single-tx tick path against
 * real Postgres.
 */
export async function withWorkspaceTx<T>(
  pool: PoolLike,
  fn: (tx: TxClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  const tx: TxClient = {
    async query<R>(text: string, values?: readonly unknown[]): Promise<{ rows: R[] }> {
      const res = await client.query(text, values as unknown[]);
      return { rows: res.rows as R[] };
    },
  };
  try {
    await client.query('BEGIN');
    const out = await fn(tx);
    await client.query('COMMIT');
    return out;
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
 * Run a list of workspace-scoped statements in ONE transaction. Each statement
 * already binds workspace_id at $1 (in-code scoping; service role bypasses RLS).
 * We assert each statement's first value matches the requested workspace as a
 * defensive guard. Exported standalone so integration tests exercise the EXACT
 * production write path against real Postgres (the claim/advance + outbox
 * atomicity).
 */
export async function runStatementsInWorkspaceTx(
  pool: PoolLike,
  workspaceId: string,
  statements: readonly SqlStatement[],
): Promise<void> {
  for (const s of statements) {
    if (s.values[0] !== workspaceId) {
      throw new Error(
        'runStatementsInWorkspaceTx: statement not scoped to the requested workspace',
      );
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

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} must be set`);
  return v;
}

/** Assemble the production dependency set (pooled pg, service role, real SQS). */
export function makeProdDeps(): RunDeps {
  const pool: Pool = getPool();
  const reader: Reader = {
    async query<T>(text: string, values?: readonly unknown[]): Promise<{ rows: T[] }> {
      const res = await pool.query(text, values as unknown[]);
      return { rows: res.rows as T[] };
    },
  };
  const sqs = new SQSClient({});
  return {
    reader,
    sqs,
    // Production tick path: the whole tick runs in ONE tx holding the enrollment
    // row lock (FOR UPDATE), so concurrent runs serialize and only one advances.
    withTx: (fn) => withWorkspaceTx(pool, fn),
    runInWorkspaceTx: (workspaceId, statements) =>
      runStatementsInWorkspaceTx(pool, workspaceId, statements),
    now: () => new Date(),
    dispatchQueueUrl: requireEnv('DISPATCH_QUEUE_URL'),
    // The real fetch-based webhook client (timeout via AbortController) behind the
    // injected interface — tests inject a fake; this NEVER runs in tests. An
    // encrypted auth-header secret is decrypted at call time only (never persisted).
    webhookClient: fetchWebhookClient(),
    decryptSecret,
    isEncryptedSecret,
  };
}
