// Local API HTTP server entry (`pnpm dev:api`). Boots the Hono app on a fixed
// port (LOCAL_API_PORT, default 8787) over a real pg pool, applying migrations
// if the DB is fresh so a cold `pnpm dev:api` works against a blank Postgres.
// The Vite SPA points its apiClient at this origin (or proxies /api to it).
import { serve } from '@hono/node-server';
import { getPool, applyMigrations } from '@cdp/db';
import { createApp } from './app.js';

const PORT = Number(process.env.LOCAL_API_PORT ?? 8787);

async function main(): Promise<void> {
  const pool = getPool();
  // Ensure schema exists (idempotent guard: only apply if `workspaces` is absent).
  const { rows } = await pool.query(
    "SELECT to_regclass('public.workspaces') IS NOT NULL AS exists",
  );
  if (!rows[0]?.exists) {
    await applyMigrations(pool);
    // eslint-disable-next-line no-console
    console.log('[local-api] applied migrations to fresh database');
  }

  const app = createApp({ pool });
  serve({ fetch: app.fetch, port: PORT });
  // eslint-disable-next-line no-console
  console.log(`[local-api] listening on http://localhost:${PORT}`);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[local-api] failed to start', err);
  process.exit(1);
});
