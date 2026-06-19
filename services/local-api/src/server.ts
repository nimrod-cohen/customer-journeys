// Local API HTTP server entry (`pnpm dev:api`). Boots the Hono app on a fixed
// port (LOCAL_API_PORT, default 8787) over a real pg pool, applying migrations
// if the DB is fresh so a cold `pnpm dev:api` works against a blank Postgres.
// The Vite SPA points its apiClient at this origin (or proxies /api to it).
import { serve } from '@hono/node-server';
import { getPool, applyMigrations } from '@cdp/db';
import { createApp } from './app.js';
import { makeLocalDeps } from './deps.js';
import { sweepDueScheduledBroadcasts } from './handlers.js';

const PORT = Number(process.env.LOCAL_API_PORT ?? 8787);
// How often the dev server sweeps for scheduled broadcasts whose time arrived
// (the local stand-in for the production EventBridge cron). 0 disables it.
const SWEEP_MS = Number(process.env.LOCAL_SCHEDULE_SWEEP_MS ?? 30_000);

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

  const deps = makeLocalDeps(pool);
  const app = createApp({ pool, deps });
  serve({ fetch: app.fetch, port: PORT });
  // eslint-disable-next-line no-console
  console.log(`[local-api] listening on http://localhost:${PORT}`);

  // Scheduled-broadcast sweep: send any broadcast whose scheduled time has passed
  // (production runs this on an EventBridge cron; the dev server has no scheduler).
  if (SWEEP_MS > 0) {
    const sweep = async (): Promise<void> => {
      try {
        const n = await sweepDueScheduledBroadcasts(pool, deps);
        // eslint-disable-next-line no-console
        if (n > 0) console.log(`[local-api] sent ${n} due scheduled broadcast(s)`);
      } catch (e) {
        // eslint-disable-next-line no-console
        console.error('[local-api] scheduled sweep failed', e);
      }
    };
    void sweep(); // catch any already-overdue broadcast on boot
    setInterval(() => void sweep(), SWEEP_MS);
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[local-api] failed to start', err);
  process.exit(1);
});
