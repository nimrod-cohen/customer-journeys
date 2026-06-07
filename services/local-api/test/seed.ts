// Shared integration-test seeding helpers (§16A). Seeds users + memberships +
// workspaces against a REAL Postgres via the admin (service-role) pool, mints
// dev tokens, and drives the SAME dispatch() pipeline the HTTP server uses. All
// ids are unique UUIDs so the integration files stay parallel-safe.
import { adminPool } from '@cdp/db';
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
