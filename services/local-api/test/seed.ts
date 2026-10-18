// Shared integration-test seeding helpers (§16A). Seeds users + memberships +
// workspaces against a REAL Postgres via the admin (service-role) pool, mints
// dev tokens, and drives the SAME dispatch() pipeline the HTTP server uses. All
// ids are unique UUIDs so the integration files stay parallel-safe.
import { adminPool, encryptSecret } from '@cdp/db';
import type { Pool } from 'pg';
import { encodeDevToken, makePgLookups, makeLocalDeps, dispatch } from '../src/index.js';
import type { ApiRequest, DispatchEnv } from '../src/index.js';

export interface TestWorld {
  readonly pool: Pool;
  readonly env: DispatchEnv;
}

/** Build a TestWorld over adminPool() with PG-backed lookups + local deps. */
export function makeWorld(): TestWorld {
  const pool = adminPool();
  const env: DispatchEnv = {
    pool,
    lookups: makePgLookups(pool),
    deps: makeLocalDeps(pool),
  };
  return { pool, env };
}

/** Mint a dev bearer token for (sub, activeWorkspace). */
export function tokenFor(sub: string, workspaceId: string | null): string {
  return `Bearer ${encodeDevToken({ sub, workspace_id: workspaceId })}`;
}

/** Issue a request through the dispatch pipeline with a bearer token. */
export async function call(
  env: DispatchEnv,
  method: string,
  path: string,
  opts: { token?: string | null; body?: unknown; query?: Record<string, string> } = {},
): Promise<{ status: number; body: unknown }> {
  const req: ApiRequest = {
    method,
    path,
    authorization: opts.token ?? null,
    query: opts.query ?? {},
    body: opts.body,
  };
  return dispatch(req, env);
}

/**
 * Connect a workspace's WhatsApp number directly in the DB (the PUT route calls Meta,
 * which tests that only need a configured workspace should not have to fake).
 */
export async function seedWorkspaceWhatsapp(
  pool: Pool,
  workspaceId: string,
  cfg: { phoneNumberId: string; accessToken: string; wabaId?: string | null; apiVersion?: string | null },
): Promise<void> {
  await pool.query(
    `INSERT INTO workspace_whatsapp_config (workspace_id, phone_number_id, waba_id, access_token, api_version)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (workspace_id) DO UPDATE SET phone_number_id = $2, waba_id = $3, access_token = $4, api_version = $5`,
    [workspaceId, cfg.phoneNumberId, cfg.wabaId ?? null, encryptSecret(cfg.accessToken), cfg.apiVersion ?? null],
  );
}
