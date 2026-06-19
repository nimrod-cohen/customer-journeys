#!/usr/bin/env node
// Repeatable DEVELOPMENT reset.
//
// Wipes ALL tenant data (companies → workspaces → every workspace-scoped table,
// via FK cascade) and every non-platform-admin user from a LOCAL dev/e2e
// database, keeping ONLY the platform (system) admin login. Then clears local
// test/build artifacts. Idempotent — safe to run repeatedly.
//
// Usage:
//   node scripts/reset-dev-db.mjs                 # resets the default dev DB (cdp)
//   DATABASE_URL=postgres://postgres:postgres@localhost:5433/cdp_e2e node scripts/reset-dev-db.mjs
//   pnpm db:reset:dev
//
// SAFETY: refuses to run unless the target is a known LOCAL dev/e2e database
// (cdp / cdp_e2e on localhost). It will never touch a remote/production DB.
import pg from 'pg';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const url = process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5433/cdp';
const { hostname, pathname } = new URL(url);
const dbName = pathname.replace(/^\//, '');
const ALLOWED_DBS = new Set(['cdp', 'cdp_e2e']);
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '']);

if (!LOCAL_HOSTS.has(hostname) || !ALLOWED_DBS.has(dbName)) {
  console.error(
    `[31mRefusing to reset database "${dbName}" at "${hostname || 'localhost'}".[0m\n` +
      `This script only resets LOCAL dev/e2e databases (${[...ALLOWED_DBS].join(', ')}) on localhost.\n` +
      `If this really is your local dev DB, point DATABASE_URL at it (e.g. postgres://postgres:postgres@localhost:5433/cdp).`,
  );
  process.exit(1);
}

const client = new pg.Client({ connectionString: url });
await client.connect();
try {
  await client.query('BEGIN');
  // companies cascades to workspaces and to every table carrying workspace_id
  // (profiles, events, segments, broadcasts, templates, assets, suppressions, …).
  await client.query('TRUNCATE companies CASCADE');
  // Drop every non-platform-admin user. companies referenced users.owner_user_id,
  // already cleared above, so this won't trip an FK.
  const delUsers = await client.query('DELETE FROM users WHERE id NOT IN (SELECT user_id FROM platform_admins)');
  await client.query('COMMIT');

  const { rows } = await client.query(`SELECT
      (SELECT count(*) FROM companies)::int       AS companies,
      (SELECT count(*) FROM workspaces)::int       AS workspaces,
      (SELECT count(*) FROM profiles)::int         AS profiles,
      (SELECT count(*) FROM users)::int            AS users,
      (SELECT count(*) FROM platform_admins)::int  AS platform_admins`);
  console.log(`[32mReset "${dbName}":[0m removed ${delUsers.rowCount ?? 0} non-admin user(s); kept the system-admin login.`);
  console.table(rows[0]);
} catch (e) {
  await client.query('ROLLBACK').catch(() => {});
  throw e;
} finally {
  await client.end();
}

// Clear local test/build artifacts ("files"). Uploaded email images live in the
// DB (assets table) and were wiped above; these are the on-disk leftovers.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const artifacts = ['web/test-results', 'web/playwright-report', 'web/blob-report'];
for (const rel of artifacts) {
  await rm(path.join(root, rel), { recursive: true, force: true });
}
console.log(`Cleared on-disk artifacts: ${artifacts.join(', ')}.`);

console.log(
  '\nNote: browser-persisted state (localStorage: login session + profile-table column choices) is NOT\n' +
    'touched by this script. Sign in fresh after a reset; the profile column picker self-heals stale\n' +
    'attribute columns on load. To fully clear it, use the browser devtools → Application → Clear site data.',
);
