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
import { devLogin, registerOwner, switchWorkspace } from './session.js';
import { makePgLookups } from './lookups.js';
import { makeLocalDeps, type LocalApiDeps } from './deps.js';
import type { AuthorizerLookups } from './auth.js';
import { buildHealth, type HealthDeps } from './health.js';

export interface CreateAppOptions {
  readonly pool: Pool;
  readonly lookups?: AuthorizerLookups;
  readonly deps?: LocalApiDeps;
  /** Optional health deps (DB ping + DLQ probe). Defaults to a pool `SELECT 1`. */
  readonly health?: HealthDeps;
}

/** Build the Hono app bound to a pool + (optional) injected lookups/deps. */
export function createApp(opts: CreateAppOptions): Hono {
  const lookups = opts.lookups ?? makePgLookups(opts.pool);
  const deps = opts.deps ?? makeLocalDeps(opts.pool);
  const env: DispatchEnv = { pool: opts.pool, lookups, deps };

  const app = new Hono();
  app.use('*', cors());

  // Health check (no auth) — real DB ping (§16). Returns 200 healthy / 503
  // degraded so the e2e readiness probe + ops monitoring reflect real state.
  const healthDeps: HealthDeps = opts.health ?? {
    async pingDb() {
      await opts.pool.query('SELECT 1');
    },
  };
  app.get('/health', async (c) => {
    const r = await buildHealth(healthDeps);
    return c.json(r.body, r.status);
  });

  // --- pre-auth / session routes (outside the capability route table) ---
  app.post('/auth/dev-login', async (c) => {
    const body = await safeJson(c);
    const r = await devLogin(lookups, env.pool, body);
    return c.json(r.body as object, r.status as 200 | 400 | 401 | 403);
  });

  app.post('/auth/register', async (c) => {
    const body = await safeJson(c);
    const r = await registerOwner(env.pool, body);
    return c.json(r.body as object, r.status as 200 | 201 | 400 | 409);
  });

  app.post('/workspace/switch', async (c) => {
    const body = await safeJson(c);
    const r = await switchWorkspace(lookups, c.req.header('authorization') ?? null, body);
    return c.json(r.body as object, r.status as 200 | 400 | 401 | 403);
  });

  // Serve an uploaded asset (email image) as BINARY — public-by-uuid, no auth:
  // the CloudFront model (possession of the unguessable URL grants read, exactly
  // like a CDN image link inside a delivered email). Uploads are capability-gated
  // (POST /assets via dispatch); only serving is public.
  app.get('/assets/:id', async (c) => {
    const id = c.req.param('id');
    if (!/^[0-9a-f-]{36}$/i.test(id)) return c.notFound();
    const { rows } = await opts.pool.query('SELECT mime, data FROM assets WHERE id = $1', [id]);
    const row = rows[0] as { mime: string; data: string } | undefined;
    if (!row) return c.notFound();
    const bytes = Buffer.from(row.data, 'base64');
    return c.body(bytes, 200, {
      'content-type': row.mime,
      'cache-control': 'public, max-age=31536000, immutable',
    });
  });

  // Click tracking (§10): a tracked link is `/t/<token>` — look it up, count the
  // click, and 302 to the real destination. Public (the token is in delivered
  // mail); unknown tokens 404.
  app.get('/t/:token', async (c) => {
    const token = c.req.param('token');
    if (!/^[a-z0-9]{6,64}$/i.test(token)) return c.notFound();
    const { rows } = await opts.pool.query<{ url: string }>(
      'UPDATE tracked_links SET clicks = clicks + 1 WHERE token = $1 RETURNING url',
      [token],
    );
    const url = rows[0]?.url;
    if (!url) return c.notFound();
    return c.redirect(url, 302);
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
