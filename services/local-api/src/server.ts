// Local API HTTP server entry (`pnpm dev:api`). Boots the Hono app on a fixed
// port (LOCAL_API_PORT, default 8787) over a real pg pool, applying migrations
// if the DB is fresh so a cold `pnpm dev:api` works against a blank Postgres.
// The Vite SPA points its apiClient at this origin (or proxies /api to it).
import { serve } from '@hono/node-server';
import { getPool, applyMigrations } from '@cdp/db';
import { createApp } from './app.js';
import { makeLocalDeps } from './deps.js';
import { sweepDueScheduledBroadcasts, sweepDueCampaignEnrollments } from './handlers.js';

const PORT = Number(process.env.PORT ?? process.env.LOCAL_API_PORT ?? 8787);
// Process role (production runs a `web` service — HTTP, no sweeps — plus ONE
// `worker` service — HTTP for health + the background sweeps/drain). `all` (the
// dev default) does both in one process. Splitting keeps the sweeps single-runner
// while the web tier scales horizontally (the DB claims make it safe either way).
const MODE = (process.env.APP_MODE ?? 'all') as 'web' | 'worker' | 'all';
const RUN_SWEEPS = MODE === 'worker' || MODE === 'all';
// Only the sweep-running role may auto-apply migrations to a fresh DB (avoids a
// multi-web-instance migration race). In production migrations are applied
// explicitly before deploy, so this is a no-op guard there.
const MAY_MIGRATE = MODE === 'worker' || MODE === 'all';
// Absolute path to the built SPA (web/dist). When set, this service also serves
// the admin SPA (single-container production). Unset in dev (Vite serves it).
const WEB_DIST_DIR = process.env.WEB_DIST_DIR;
// How often the dev server sweeps for scheduled broadcasts whose time arrived
// (the local stand-in for the production EventBridge cron). 0 disables it.
const SWEEP_MS = Number(process.env.LOCAL_SCHEDULE_SWEEP_MS ?? 30_000);
// How often the dev server advances due campaign enrollments (the local stand-in
// for the production EventBridge campaign sweep / scheduledSweepHandler — without
// it enrollments are created but never advance). 0 disables it.
const CAMPAIGN_SWEEP_MS = Number(process.env.LOCAL_CAMPAIGN_SWEEP_MS ?? 30_000);

async function main(): Promise<void> {
  const pool = getPool();
  // Ensure schema exists (idempotent guard: only apply if `workspaces` is absent).
  if (MAY_MIGRATE) {
    const { rows } = await pool.query(
      "SELECT to_regclass('public.workspaces') IS NOT NULL AS exists",
    );
    if (!rows[0]?.exists) {
      await applyMigrations(pool);
      // eslint-disable-next-line no-console
      console.log('[local-api] applied migrations to fresh database');
    }
  }

  const deps = makeLocalDeps(pool);
  const app = createApp({ pool, deps, ...(WEB_DIST_DIR ? { webDistDir: WEB_DIST_DIR } : {}) });
  serve({ fetch: app.fetch, port: PORT });
  // eslint-disable-next-line no-console
  console.log(`[local-api] listening on http://localhost:${PORT} (mode=${MODE}${WEB_DIST_DIR ? ', serving SPA' : ''})`);

  // Scheduled-broadcast sweep: send any broadcast whose scheduled time has passed
  // (production runs this on an EventBridge cron; the dev server has no scheduler).
  if (RUN_SWEEPS && SWEEP_MS > 0) {
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

  // Campaign-enrollment sweep: advance any enrollment whose next_run_at has passed
  // (production runs this on an EventBridge cron via scheduledSweepHandler; the dev
  // server has no scheduler). Runs ONLY in this long-lived server, never createApp.
  if (RUN_SWEEPS && CAMPAIGN_SWEEP_MS > 0) {
    const sweepCampaigns = async (): Promise<void> => {
      try {
        const n = await sweepDueCampaignEnrollments(pool, deps);
        // eslint-disable-next-line no-console
        if (n > 0) console.log(`[local-api] advanced ${n} due campaign enrollment(s)`);
      } catch (e) {
        // eslint-disable-next-line no-console
        console.error('[local-api] campaign sweep failed', e);
      }
    };
    void sweepCampaigns(); // catch any already-due enrollment on boot
    setInterval(() => void sweepCampaigns(), CAMPAIGN_SWEEP_MS);
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[local-api] failed to start', err);
  process.exit(1);
});
