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
import { devLogin, registerOwner, switchWorkspace, createFirstWorkspace } from './session.js';
import { makePgLookups } from './lookups.js';
import { makeLocalDeps, type LocalApiDeps } from './deps.js';
import type { AuthorizerLookups } from './auth.js';
import { buildHealth, type HealthDeps } from './health.js';
import {
  makeUnsubscribeHandler,
  makePreferenceCenterHandler,
  runUnsubscribeInWorkspaceTx,
} from '@cdp/service-unsubscribe';

/** A 1x1 fully-transparent GIF (the canonical 43-byte tracking pixel). */
const TRANSPARENT_GIF = Buffer.from(
  'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
  'base64',
);

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

  // A company owner creates their FIRST workspace (the workspace-less token can't
  // reach the capability-gated POST /workspaces) and is logged into it. Session
  // route: authenticates the token directly and re-mints it, like /workspace/switch.
  app.post('/workspace/bootstrap', async (c) => {
    const body = await safeJson(c);
    const r = await createFirstWorkspace(env.pool, c.req.header('authorization') ?? null, body);
    return c.json(r.body as object, r.status as 201 | 400 | 401 | 403);
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

  // Open tracking (§10): a 1x1 pixel `/o/<token>` embedded in delivered mail.
  // ALWAYS returns the transparent gif (a pixel must never error to the client —
  // mail clients would show a broken image), and best-effort records the open
  // (bump opens + first/last_open_at). Public; an unknown/foreign token still
  // returns the gif but records nothing. The token already encodes the
  // workspace/broadcast/profile, so the UPDATE is scoped by the token PK.
  app.get('/o/:token', async (c) => {
    const token = c.req.param('token');
    if (/^[a-z0-9]{6,64}$/i.test(token)) {
      try {
        await opts.pool.query(
          `UPDATE tracked_opens
              SET opens = opens + 1,
                  first_open_at = COALESCE(first_open_at, now()),
                  last_open_at = now()
            WHERE token = $1`,
          [token],
        );
      } catch {
        /* never let a pixel error reach the client */
      }
    }
    return c.body(TRANSPARENT_GIF, 200, {
      'content-type': 'image/gif',
      'cache-control': 'no-store, no-cache, must-revalidate, private',
      pragma: 'no-cache',
    });
  });

  // Unsubscribe (§10): public, no auth — the link lands here from a delivered
  // email. GET shows a re-affirm CONFIRMATION page (changes nothing — GET is
  // prefetchable); POST (the page's Confirm button, or an RFC 8058 one-click)
  // writes the per-workspace suppression + sets the profile `unsubscribed=true`.
  // Reuses the SAME handler the production Lambda runs, bound to the local pool.
  // The public asset ORIGIN for the optional company logo atop the page is the
  // SAME origin the request arrived on (which is the origin of the unsubscribe
  // link). The logo URL is `<origin>/assets/<id>` — exactly the public binary
  // route below. Resolved per request so it matches whatever host served the
  // link; the handler is rebuilt per request to carry that origin into the logo.
  const runUnsubscribe = async (method: 'GET' | 'POST', c: { req: { url: string; text: () => Promise<string> } }) => {
    const unsubscribe = makeUnsubscribeHandler({
      runInWorkspaceTx: (workspaceId, statements) => runUnsubscribeInWorkspaceTx(opts.pool, workspaceId, statements),
      reader: opts.pool,
      assetsBaseUrl: new URL(c.req.url).origin,
    });
    const qs = new URL(c.req.url).search.replace(/^\?/, '');
    const base = { httpMethod: method, path: '/unsubscribe', rawQueryString: qs };
    if (method === 'POST') return unsubscribe({ ...base, body: await c.req.text().catch(() => '') });
    return unsubscribe(base);
  };
  app.get('/unsubscribe', async (c) => {
    const r = await runUnsubscribe('GET', c);
    return c.body(r.body, r.statusCode as 200, r.headers ?? {});
  });
  app.post('/unsubscribe', async (c) => {
    const r = await runUnsubscribe('POST', c);
    return c.body(r.body, r.statusCode as 200, r.headers ?? {});
  });

  // Preference center (CLAUDE.md topic-subscriptions): public, no auth — the
  // "manage your subscription" page the `{{unsubscribe}}` body link points to.
  // GET renders the topics + channel checkboxes; POST writes the granular prefs
  // (a partial opt-out keeps the person reachable on still-subscribed channels;
  // "unsubscribe from everything" sets the full suppression). workspace_id + email
  // come ONLY from the scoped link. Reuses the SAME handler the Lambda runs.
  const runPrefCenter = async (
    method: 'GET' | 'POST',
    c: { req: { url: string; text: () => Promise<string> } },
  ) => {
    const preferenceCenter = makePreferenceCenterHandler({
      reader: opts.pool,
      runInWorkspaceTx: (workspaceId, statements) => runUnsubscribeInWorkspaceTx(opts.pool, workspaceId, statements),
      assetsBaseUrl: new URL(c.req.url).origin,
    });
    const qs = new URL(c.req.url).search.replace(/^\?/, '');
    const base = { httpMethod: method, path: '/manage-subscription', rawQueryString: qs };
    if (method === 'POST') return preferenceCenter({ ...base, body: await c.req.text().catch(() => '') });
    return preferenceCenter(base);
  };
  app.get('/manage-subscription', async (c) => {
    const r = await runPrefCenter('GET', c);
    return c.body(r.body, r.statusCode as 200, r.headers ?? {});
  });
  app.post('/manage-subscription', async (c) => {
    const r = await runPrefCenter('POST', c);
    return c.body(r.body, r.statusCode as 200, r.headers ?? {});
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
