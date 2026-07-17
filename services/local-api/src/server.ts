// Local API HTTP server entry (`pnpm dev:api`). Boots the Hono app on a fixed
// port (LOCAL_API_PORT, default 8787) over a real pg pool, applying migrations
// if the DB is fresh so a cold `pnpm dev:api` works against a blank Postgres.
// The Vite SPA points its apiClient at this origin (or proxies /api to it).
import { serve } from '@hono/node-server';
import { getPool, runPendingMigrations } from '@cdp/db';
import { createApp } from './app.js';
import { makeLocalDeps } from './deps.js';
import { sweepDueScheduledBroadcasts, sweepDueAutomationEnrollments } from './handlers.js';

const PORT = Number(process.env.PORT ?? process.env.LOCAL_API_PORT ?? 8787);
// Process role (production runs a `web` service — HTTP, no sweeps — plus ONE
// `worker` service — HTTP for health + the background sweeps/drain). `all` (the
// dev default) does both in one process. Splitting keeps the sweeps single-runner
// while the web tier scales horizontally (the DB claims make it safe either way).
const MODE = (process.env.APP_MODE ?? 'all') as 'web' | 'worker' | 'all';
const RUN_SWEEPS = MODE === 'worker' || MODE === 'all';
// Only the single-runner role applies migrations (the `worker` in prod; `all` in
// dev), avoiding a multi-web-instance race — plus runPendingMigrations takes an
// advisory lock. On every boot it applies any OUTSTANDING migrations to the DB
// (tracked in schema_migrations), so a deploy carries its own schema changes.
const MAY_MIGRATE = MODE === 'worker' || MODE === 'all';
// Absolute path to the built SPA (web/dist). When set, this service also serves
// the admin SPA (single-container production). Unset in dev (Vite serves it).
const WEB_DIST_DIR = process.env.WEB_DIST_DIR;
// How often the dev server sweeps for scheduled broadcasts whose time arrived
// (the local stand-in for the production EventBridge cron). 0 disables it.
const SWEEP_MS = Number(process.env.LOCAL_SCHEDULE_SWEEP_MS ?? 30_000);
// How often the dev server advances due automation enrollments (the local stand-in
// for the production EventBridge automation sweep / scheduledSweepHandler — without
// it enrollments are created but never advance). 0 disables it.
const AUTOMATION_SWEEP_MS = Number(process.env.LOCAL_AUTOMATION_SWEEP_MS ?? 30_000);

async function main(): Promise<void> {
  const pool = getPool();
  // Apply any OUTSTANDING migrations on boot (tracked in schema_migrations) — so a
  // deploy carries its own DB changes and no migration is ever hand-run. A fresh DB
  // gets everything; an existing untracked DB is baselined then caught up; an
  // up-to-date DB is a no-op. Gated to the single migrator role + advisory-locked.
  // A failing migration throws here → boot fails → the deploy's health check fails
  // and Fly keeps the previous version (never a half-applied schema).
  if (MAY_MIGRATE) {
    const { applied, baselined } = await runPendingMigrations(pool);
    // eslint-disable-next-line no-console
    if (baselined.length) console.log(`[local-api] baselined ${baselined.length} pre-existing migration(s)`);
    // eslint-disable-next-line no-console
    console.log(
      applied.length
        ? `[local-api] applied ${applied.length} pending migration(s): ${applied.join(', ')}`
        : '[local-api] database schema up to date',
    );
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

  // Automation-enrollment sweep: advance any enrollment whose next_run_at has passed
  // (production runs this on an EventBridge cron via scheduledSweepHandler; the dev
  // server has no scheduler). Runs ONLY in this long-lived server, never createApp.
  if (RUN_SWEEPS && AUTOMATION_SWEEP_MS > 0) {
    const sweepAutomations = async (): Promise<void> => {
      try {
        const n = await sweepDueAutomationEnrollments(pool, deps);
        // eslint-disable-next-line no-console
        if (n > 0) console.log(`[local-api] advanced ${n} due automation enrollment(s)`);
      } catch (e) {
        // eslint-disable-next-line no-console
        console.error('[local-api] automation sweep failed', e);
      }
    };
    void sweepAutomations(); // catch any already-due enrollment on boot
    setInterval(() => void sweepAutomations(), AUTOMATION_SWEEP_MS);
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[local-api] failed to start', err);
  process.exit(1);
});
