// Real (production) ingest dependencies (§7).
//
// All Postgres access lives here so the pure core and the thin handler stay
// I/O-free and unit-testable. The Processor/ingest service role BYPASSES RLS, so
// every query MUST scope by workspace_id in code — the api-key lookup is by its
// primary key, and the profile upsert binds workspace_id explicitly.
import type { Pool } from 'pg';
import { getPool } from '@cdp/db';
import { SQSClient } from '@aws-sdk/client-sqs';
import type { WorkspaceApiKeyRow } from '@cdp/shared';
import { buildProfileUpsert } from './core.js';
import type { IngestDeps } from './handler.js';

/** Pool-compatible query surface (real `pg.Pool` or a `PoolClient`). */
export interface Queryable {
  query<R = Record<string, unknown>>(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: R[]; rowCount: number | null }>;
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} must be set`);
  return v;
}

/** Look up the workspace_api_keys row for an API Gateway key id. */
export async function lookupApiKeyRow(
  db: Queryable,
  apiKeyId: string,
): Promise<WorkspaceApiKeyRow | null> {
  const { rows } = await db.query<WorkspaceApiKeyRow>(
    'SELECT api_key_id, workspace_id, label FROM workspace_api_keys WHERE api_key_id = $1',
    [apiKeyId],
  );
  return rows[0] ?? null;
}

/** Upsert a profile by (workspace_id, external_id), returning its id. */
export async function upsertProfileForKey(
  db: Queryable,
  workspaceId: string,
  externalId: string,
  attributes: Record<string, unknown>,
): Promise<string> {
  const q = buildProfileUpsert(workspaceId, externalId, attributes);
  const { rows } = await db.query<{ id: string }>(q.text, q.values);
  if (!rows[0]) throw new Error('upsertProfileForKey: no id returned');
  return rows[0].id;
}

/** Assemble the production dependency set (pooled pg + real SQS client). */
export function makeProdDeps(): IngestDeps {
  const pool: Pool = getPool();
  const sqs = new SQSClient({});
  const queueUrl = requireEnv('INGEST_QUEUE_URL');
  return {
    sqs,
    queueUrl,
    lookupApiKey: (apiKeyId) => lookupApiKeyRow(pool, apiKeyId),
    upsertProfile: (ws, ext, attrs) => upsertProfileForKey(pool, ws, ext, attrs),
  };
}
