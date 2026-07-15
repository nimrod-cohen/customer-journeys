// The Hono app (§12). A thin HTTP shell over the pure dispatch() pipeline. It:
//   - adds permissive CORS so the Vite SPA (browser) can call it in e2e,
//   - handles the two pre-auth/session routes (dev-login, switch) directly,
//   - routes everything else through dispatch() (auth → enforce → handle).
// The app is given its DispatchEnv (pool + lookups + deps) so tests can inject a
// test pool + local deps and drive the SAME server the SPA talks to.
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { readFileSync, existsSync } from 'node:fs';
import { join, extname, normalize, sep } from 'node:path';
import type { Pool } from 'pg';
import { dispatch, type ApiRequest, type DispatchEnv } from './dispatch.js';
import {
  devLogin,
  registerOwner,
  switchWorkspace,
  createFirstWorkspace,
  acceptInvite,
  forgotPassword,
  resetPassword,
} from './session.js';
import { makePgLookups } from './lookups.js';
import { makeLocalDeps, type LocalApiDeps } from './deps.js';
import type { AuthorizerLookups } from './auth.js';
import { buildHealth, type HealthDeps } from './health.js';
import { ingestTrack, ingestIdentify, r2StorageForWorkspace } from './handlers.js';
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
  /**
   * Absolute path to the built SPA (`web/dist`). When set, this ONE service also
   * serves the admin SPA — `/` → index.html, `/static/*` → the hashed bundles — so
   * production can run a single container for the SPA + API + public endpoints.
   * Unset in dev/tests (Vite serves the SPA).
   */
  readonly webDistDir?: string;
}

/** Content types for the small set of static file extensions the SPA emits. */
const STATIC_CONTENT_TYPES: Record<string, string> = {
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

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

  // System-auth flows (pre-auth): accept an invite (set password → logged in),
  // request a password reset (always 200), and complete a reset (→ logged in).
  app.post('/auth/accept-invite', async (c) => {
    const body = await safeJson(c);
    const r = await acceptInvite(lookups, env.pool, body);
    return c.json(r.body as object, r.status as 200 | 400 | 401 | 403);
  });
  app.post('/auth/forgot-password', async (c) => {
    const body = await safeJson(c);
    const r = await forgotPassword({ mailer: deps.mailer, appBaseUrl: deps.appBaseUrl, pool: env.pool }, body);
    return c.json(r.body as object, r.status as 200 | 400);
  });
  app.post('/auth/reset-password', async (c) => {
    const body = await safeJson(c);
    const r = await resetPassword(lookups, env.pool, body);
    return c.json(r.body as object, r.status as 200 | 400 | 401 | 403);
  });

  // Serve an uploaded asset (email image) as BINARY — public-by-uuid, no auth:
  // the CloudFront model (possession of the unguessable URL grants read, exactly
  // like a CDN image link inside a delivered email). Uploads are capability-gated
  // (POST /assets via dispatch); only serving is public.
  app.get('/assets/:id', async (c) => {
    const id = c.req.param('id');
    if (!/^[0-9a-f-]{36}$/i.test(id)) return c.notFound();
    const { rows } = await opts.pool.query('SELECT workspace_id, mime, data, storage, r2_key FROM assets WHERE id = $1', [id]);
    const row = rows[0] as
      | { workspace_id: string; mime: string; data: string | null; storage: string; r2_key: string | null }
      | undefined;
    if (!row) return c.notFound();
    // R2-backed: STREAM the bytes from the company's bucket back through this same
    // domain (no separate assets.* domain). Keeps the /assets/:id URL working for
    // links frozen into already-saved templates; email image proxies cache it.
    if (row.storage === 'r2' && row.r2_key) {
      const storage = await r2StorageForWorkspace(opts.pool, row.workspace_id, deps.makeR2Storage);
      const obj = storage ? await storage.get(row.r2_key) : null;
      if (!obj) return c.notFound();
      return c.body(new Uint8Array(obj.body), 200, {
        'content-type': obj.contentType ?? row.mime,
        'cache-control': 'public, max-age=31536000, immutable',
      });
    }
    if (row.data == null) return c.notFound();
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

  // Ingest API (§7): PUBLIC, key-authed (no session) — safe to call from front-end
  // JS. The write key resolves the workspace; it can ONLY upsert a profile + record
  // an event for that workspace. CORS is already permissive (app.use('*', cors())),
  // so browsers can call these cross-origin. The key comes from an Authorization:
  // Bearer header, an X-API-Key header, or a body field (for sendBeacon).
  const ingestKeyFrom = (c: { req: { header: (n: string) => string | undefined } }, body: unknown): string => {
    const auth = c.req.header('authorization') ?? '';
    if (auth.toLowerCase().startsWith('bearer ')) return auth.slice(7).trim();
    const xkey = c.req.header('x-api-key');
    if (xkey) return xkey.trim();
    const b = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
    const v = b.writeKey ?? b.write_key ?? b.api_key;
    return typeof v === 'string' ? v.trim() : '';
  };
  app.post('/v1/track', async (c) => {
    const body = await safeJson(c);
    const r = await ingestTrack(opts.pool, ingestKeyFrom(c, body), body);
    return c.json(r.body as object, r.status as 200 | 202 | 400 | 401);
  });
  app.post('/v1/identify', async (c) => {
    const body = await safeJson(c);
    const r = await ingestIdentify(opts.pool, ingestKeyFrom(c, body), body);
    return c.json(r.body as object, r.status as 200 | 202 | 400 | 401);
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
  const runUnsubscribe = async (
    method: 'GET' | 'POST',
    c: { req: { url: string; text: () => Promise<string>; header: (n: string) => string | undefined } },
  ) => {
    const unsubscribe = makeUnsubscribeHandler({
      runInWorkspaceTx: (workspaceId, statements) => runUnsubscribeInWorkspaceTx(opts.pool, workspaceId, statements),
      reader: opts.pool,
      assetsBaseUrl: new URL(c.req.url).origin,
    });
    const qs = new URL(c.req.url).search.replace(/^\?/, '');
    // Thread the recipient's browser language through (front_facing_language='auto').
    const acceptLanguage = c.req.header('accept-language') ?? null;
    const base = { httpMethod: method, path: '/unsubscribe', rawQueryString: qs, acceptLanguage };
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
    c: { req: { url: string; text: () => Promise<string>; header: (n: string) => string | undefined } },
  ) => {
    const preferenceCenter = makePreferenceCenterHandler({
      reader: opts.pool,
      runInWorkspaceTx: (workspaceId, statements) => runUnsubscribeInWorkspaceTx(opts.pool, workspaceId, statements),
      assetsBaseUrl: new URL(c.req.url).origin,
    });
    const qs = new URL(c.req.url).search.replace(/^\?/, '');
    // Thread the recipient's browser language through (front_facing_language='auto').
    const acceptLanguage = c.req.header('accept-language') ?? null;
    const base = { httpMethod: method, path: '/manage-subscription', rawQueryString: qs, acceptLanguage };
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

  // --- static SPA (production single-container) ---
  // Served BEFORE the dispatch catch-all so `/` + `/static/*` resolve to files.
  // The SPA is HASH-routed (#/…), so the server only ever serves `/` (index.html)
  // and the hashed bundles under `/static/*`; every API path falls through to
  // dispatch below. Skipped entirely when webDistDir is unset (dev/tests).
  const webDistDir = opts.webDistDir;
  if (webDistDir) {
    const indexPath = join(webDistDir, 'index.html');
    const indexHtml = existsSync(indexPath) ? readFileSync(indexPath, 'utf8') : null;
    // Hashed, immutable bundles.
    app.get('/static/*', (c) => {
      const file = normalize(join(webDistDir, c.req.path.replace(/^\/+/, '')));
      // Path-traversal guard: the resolved file must stay under webDistDir.
      if (!file.startsWith(webDistDir + sep) || !existsSync(file)) return c.notFound();
      const type = STATIC_CONTENT_TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream';
      return new Response(new Uint8Array(readFileSync(file)), {
        status: 200,
        headers: { 'content-type': type, 'cache-control': 'public, max-age=31536000, immutable' },
      });
    });
    // A few well-known root files (favicon, manifest, robots) if the SPA emits them.
    for (const name of ['favicon.svg', 'favicon.ico', 'robots.txt', 'site.webmanifest', 'manifest.json']) {
      app.get(`/${name}`, (c) => {
        const file = join(webDistDir, name);
        if (!existsSync(file)) return c.notFound();
        const type = STATIC_CONTENT_TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream';
        return new Response(new Uint8Array(readFileSync(file)), { status: 200, headers: { 'content-type': type } });
      });
    }
    // The SPA entry (index.html) — never cached, so a new deploy is picked up.
    // '/docs' also serves the shell so the PUBLIC API-reference route (rendered by
    // the SPA before its auth gate) loads on a clean URL without a 401.
    if (indexHtml !== null) {
      app.get('/', (c) => c.html(indexHtml, 200, { 'cache-control': 'no-store' }));
      app.get('/docs', (c) => c.html(indexHtml, 200, { 'cache-control': 'no-store' }));
    }
  }

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
