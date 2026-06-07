// The Hono app (§12). A thin HTTP shell over the pure dispatch() pipeline. It:
//   - adds permissive CORS so the Vite SPA (browser) can call it in e2e,
//   - handles the two pre-auth/session routes (dev-login, switch) directly,
//   - routes everything else through dispatch() (auth → enforce → handle).
// The app is given its DispatchEnv (pool + lookups + deps) so tests can inject a
// test pool + local deps and drive the SAME server the SPA talks to.
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { Pool } from 'pg';
import { dispatch, type ApiRequest, type DispatchEnv } from './dispatch.js';
import { devLogin, switchWorkspace } from './session.js';
import { makePgLookups } from './lookups.js';
import { makeLocalDeps, type LocalApiDeps } from './deps.js';
import type { AuthorizerLookups } from './auth.js';

export interface CreateAppOptions {
  readonly pool: Pool;
  readonly lookups?: AuthorizerLookups;
  readonly deps?: LocalApiDeps;
}

/** Build the Hono app bound to a pool + (optional) injected lookups/deps. */
export function createApp(opts: CreateAppOptions): Hono {
  const lookups = opts.lookups ?? makePgLookups(opts.pool);
  const deps = opts.deps ?? makeLocalDeps(opts.pool);
  const env: DispatchEnv = { pool: opts.pool, lookups, deps };

  const app = new Hono();
  app.use('*', cors());

  // Health check (no auth) — used by the e2e webServer readiness probe.
  app.get('/health', (c) => c.json({ ok: true }));

  // --- pre-auth / session routes (outside the capability route table) ---
  app.post('/auth/dev-login', async (c) => {
    const body = await safeJson(c);
    const r = await devLogin(lookups, body);
    return c.json(r.body as object, r.status as 200 | 400 | 403);
  });

  app.post('/workspace/switch', async (c) => {
    const body = await safeJson(c);
    const r = await switchWorkspace(lookups, c.req.header('authorization') ?? null, body);
    return c.json(r.body as object, r.status as 200 | 400 | 401 | 403);
  });

  // --- everything else flows through the dispatch pipeline ---
  app.all('*', async (c) => {
    const url = new URL(c.req.url);
    const query: Record<string, string> = {};
    url.searchParams.forEach((v, k) => {
      query[k] = v;
    });
    const body = await safeJson(c);
    const apiReq: ApiRequest = {
      method: c.req.method,
      path: url.pathname,
      authorization: c.req.header('authorization') ?? null,
      query,
      body,
    };
    const res = await dispatch(apiReq, env);
    return c.json(res.body as object, res.status as 200);
  });

  return app;
}

/** Parse a JSON body, tolerating empty/non-JSON bodies (GET/DELETE). */
async function safeJson(c: { req: { json: () => Promise<unknown> } }): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    return undefined;
  }
}
