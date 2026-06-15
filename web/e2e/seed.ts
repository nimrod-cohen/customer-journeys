// Deterministic e2e seed (real Postgres). Run by Playwright globalSetup before
// the browser specs. Seeds two workspaces, a multi-workspace user, a marketer, a
// platform admin, plus profiles/templates so the SPA flows (segment preview,
// broadcast, campaign, switching, role visibility, admin console) have data.
// Uses the admin (service-role) pool to seed across workspaces. Idempotent:
// deletes its own rows first.
import { adminPool, applyMigrations } from '@cdp/db';

// Stable UUIDs (unique namespace for the SPA e2e).
// Two companies: "Acme" owns TWO workspaces (A + A-West); "Beta" owns one.
export const CO_ACME = '0e2efe00-0000-4000-8000-0000000000f1';
export const CO_BETA = '0e2efe00-0000-4000-8000-0000000000f2';
export const WS_A = '0e2efe00-0000-4000-8000-000000000a01';
export const WS_A2 = '0e2efe00-0000-4000-8000-000000000a03'; // 2nd Acme workspace
export const WS_B = '0e2efe00-0000-4000-8000-000000000a02';
export const USER_MULTI = '0e2efe00-0000-4000-8000-0000000000b1'; // owner of A + B
export const USER_MKT = '0e2efe00-0000-4000-8000-0000000000b2'; // marketer of A
export const USER_ADMIN = '0e2efe00-0000-4000-8000-0000000000b3'; // platform admin

// Dev-login credential handles (email+password fixtures in @cdp/shared), mapped
// to the seeded user UUIDs so the e2e logs in exactly like a real user.
import { DEV_USERS } from '@cdp/shared';
export const DEV_OWNER = DEV_USERS.find((u) => u.userId === USER_MULTI)!;
export const DEV_MKT = DEV_USERS.find((u) => u.userId === USER_MKT)!;
export const DEV_ADMIN = DEV_USERS.find((u) => u.userId === USER_ADMIN)!;
export const TPL_A = '0e2efe00-0000-4000-8000-0000000000c1';
export const SEG_A = '0e2efe00-0000-4000-8000-0000000000c2';
export const SEG_B = '0e2efe00-0000-4000-8000-0000000000c3';
export const SEG_DYN_A = '0e2efe00-0000-4000-8000-0000000000c4'; // dynamic: attributes.tier = vip
export const SEG_A2 = '0e2efe00-0000-4000-8000-0000000000c5'; // segment in the 2nd Acme workspace

/** Segment names — asserted present/absent after switching workspaces. WS_A and
 * WS_A2 are BOTH in the Acme company (a user belongs to ONE company, which may
 * own several workspaces), so the switch test moves between two Acme workspaces. */
export const SEG_A_NAME = 'Manual VIPs';
export const SEG_A2_NAME = 'Acme West Club';
export const SEG_B_NAME = 'Beta Loyalty Club';
/** A dynamic (rule-based) segment in A — has NO materialized memberships. */
export const SEG_DYN_A_NAME = 'VIP (dynamic)';

export async function seed(): Promise<void> {
  const pool = adminPool();
  try {
    // Ensure schema exists on a fresh DB.
    const { rows } = await pool.query(
      "SELECT to_regclass('public.workspaces') IS NOT NULL AS exists",
    );
    if (!rows[0]?.exists) await applyMigrations(pool);

    await cleanup(pool);

    // Companies (the parent of workspaces).
    await pool.query("INSERT INTO companies (id, name, status) VALUES ($1,'Acme','active')", [CO_ACME]);
    await pool.query("INSERT INTO companies (id, name, status) VALUES ($1,'Beta','active')", [CO_BETA]);
    for (const [ws, name, company] of [
      [WS_A, 'Acme (A)', CO_ACME],
      [WS_A2, 'Acme (A) — West', CO_ACME],
      [WS_B, 'Beta (B)', CO_BETA],
    ] as const) {
      await pool.query("INSERT INTO workspaces (id, name, status, company_id) VALUES ($1,$2,'active',$3)", [
        ws,
        name,
        company,
      ]);
    }
    // Memberships. The multi-workspace user belongs to ONE company (Acme) and is
    // an owner of BOTH its workspaces (WS_A + WS_A2) — never another company's.
    await pool.query(
      "INSERT INTO workspace_users (workspace_id, user_id, role) VALUES ($1,$2,'owner')",
      [WS_A, USER_MULTI],
    );
    await pool.query(
      "INSERT INTO workspace_users (workspace_id, user_id, role) VALUES ($1,$2,'owner')",
      [WS_A2, USER_MULTI],
    );
    await pool.query(
      "INSERT INTO workspace_users (workspace_id, user_id, role) VALUES ($1,$2,'marketer')",
      [WS_A, USER_MKT],
    );
    await pool.query('INSERT INTO platform_admins (user_id) VALUES ($1)', [USER_ADMIN]);

    // A template + a saved segment + a couple of profiles in WS_A.
    await pool.query(
      "INSERT INTO email_templates (id, workspace_id, name, mjml, compiled_html) VALUES ($1,$2,'Welcome','<mjml/>','<html>Hi</html>')",
      [TPL_A, WS_A],
    );
    // A VERIFIED sending domain so WS_A broadcasts can be sent (the send gate).
    await pool.query(
      "INSERT INTO sending_domains (workspace_id, domain, verified, verified_at) VALUES ($1,'mail.acme.test',true,now())",
      [WS_A],
    );
    await pool.query(
      'INSERT INTO segments (id, workspace_id, name, kind) VALUES ($1,$2,$3,$4)',
      [SEG_A, WS_A, SEG_A_NAME, 'manual'],
    );
    // A segment in the 2nd Acme workspace so switching WS_A→WS_A2 surfaces its
    // data and drops WS_A's (the same-company switch).
    await pool.query(
      'INSERT INTO segments (id, workspace_id, name, kind) VALUES ($1,$2,$3,$4)',
      [SEG_A2, WS_A2, SEG_A2_NAME, 'manual'],
    );
    // A Beta-only segment so the Beta company/workspace isn't empty (admin view).
    await pool.query(
      'INSERT INTO segments (id, workspace_id, name, kind) VALUES ($1,$2,$3,$4)',
      [SEG_B, WS_B, SEG_B_NAME, 'manual'],
    );
    // A DYNAMIC segment in A (rule attributes.tier = vip) with NO materialized
    // memberships — the Profiles filter must live-evaluate it.
    await pool.query(
      `INSERT INTO segments (id, workspace_id, name, kind, definition)
       VALUES ($1,$2,$3,'dynamic_realtime','{"field":"attributes.tier","operator":"=","value":"vip"}'::jsonb)`,
      [SEG_DYN_A, WS_A, SEG_DYN_A_NAME],
    );
    let firstProfileId = '';
    // a1/a2/a3 are ESTABLISHED accounts (created long ago) — their events date to
    // early 2026, so a months-old created_at is the faithful value. a4 is a
    // BRAND-NEW account (created_at = now()): it exists to prove the segment
    // tenure guard — absence-based windowed rules ("did NOT do X within N days")
    // must NOT count a profile too new to have had the chance.
    const ESTABLISHED = '2025-06-01T00:00:00Z';
    for (const [ext, email, tier, createdAt] of [
      ['a1', 'a1@acme.com', 'vip', ESTABLISHED],
      ['a2', 'a2@acme.com', 'vip', ESTABLISHED],
      ['a3', 'a3@acme.com', 'std', ESTABLISHED],
      ['a4', 'a4@acme.com', 'free', null], // null → defaults to now() (too new for any window)
    ] as const) {
      const { rows: pr } = await pool.query<{ id: string }>(
        'INSERT INTO profiles (workspace_id, external_id, email, attributes, created_at) ' +
          'VALUES ($1,$2,$3,$4::jsonb, COALESCE($5::timestamptz, now())) RETURNING id',
        [WS_A, ext, email, JSON.stringify({ tier }), createdAt],
      );
      if (!firstProfileId) firstProfileId = pr[0]!.id;
      await pool.query(
        'INSERT INTO profile_features (profile_id, workspace_id) VALUES ($1,$2)',
        [pr[0]!.id, WS_A],
      );
    }
    // a3 is unsubscribed — flag the boolean attribute so "attributes.unsubscribed
    // = true" matches exactly one profile (mirrors the real unsubscribe flow).
    await pool.query(
      `UPDATE profiles SET attributes = attributes || '{"unsubscribed": true}'::jsonb
        WHERE workspace_id = $1 AND external_id = 'a3'`,
      [WS_A],
    );
    // a2 carries an extra "plan" key so the workspace has >1 attribute key — lets
    // the profile "quick-add" panel offer a key not yet on another profile.
    await pool.query(
      `UPDATE profiles SET attributes = attributes || '{"plan": "pro"}'::jsonb
        WHERE workspace_id = $1 AND external_id = 'a2'`,
      [WS_A],
    );
    // Give the first profile (a1) past events + a manual segment membership so the
    // Profile detail screen's Events/Segments tabs render live data in the e2e.
    await pool.query('UPDATE profile_features SET total_events = 2 WHERE profile_id = $1', [
      firstProfileId,
    ]);
    await pool.query(
      "INSERT INTO events (event_id, workspace_id, profile_id, type, occurred_at, payload) VALUES (gen_random_uuid(),$1,$2,'page_view','2026-01-01T10:00:00Z','{}'::jsonb)",
      [WS_A, firstProfileId],
    );
    await pool.query(
      "INSERT INTO events (event_id, workspace_id, profile_id, type, occurred_at, payload) VALUES (gen_random_uuid(),$1,$2,'purchase','2026-02-01T10:00:00Z','{\"amount\":50,\"sku\":\"book\"}'::jsonb)",
      [WS_A, firstProfileId],
    );
    await pool.query(
      "INSERT INTO segment_memberships (segment_id, profile_id, workspace_id, source) VALUES ($1,$2,$3,'manual')",
      [SEG_A, firstProfileId, WS_A],
    );
    // Delivery activity for a1 — a successful delivery, a failed bounce, and a
    // send — so the Activity log has email + send rows with success/failure.
    await pool.query(
      "INSERT INTO email_events (workspace_id, profile_id, type, occurred_at) VALUES ($1,$2,'delivery','2026-02-02T10:00:00Z')",
      [WS_A, firstProfileId],
    );
    await pool.query(
      "INSERT INTO email_events (workspace_id, profile_id, type, sub_type, occurred_at) VALUES ($1,$2,'bounce','Transient','2026-02-03T10:00:00Z')",
      [WS_A, firstProfileId],
    );
    await pool.query(
      "INSERT INTO messages_log (workspace_id, profile_id, status, sent_at) VALUES ($1,$2,'sent','2026-02-04T10:00:00Z')",
      [WS_A, firstProfileId],
    );
    // One profile in WS_B (must never appear in WS_A views).
    const { rows: pb } = await pool.query<{ id: string }>(
      'INSERT INTO profiles (workspace_id, external_id, email) VALUES ($1,$2,$3) RETURNING id',
      [WS_B, 'b1', 'b1@beta.com'],
    );
    await pool.query('INSERT INTO profile_features (profile_id, workspace_id) VALUES ($1,$2)', [
      pb[0]!.id,
      WS_B,
    ]);
  } finally {
    await pool.end();
  }
}

export async function cleanup(pool: ReturnType<typeof adminPool>): Promise<void> {
  for (const ws of [WS_A, WS_A2, WS_B]) {
    await pool.query('DELETE FROM segment_change_log WHERE workspace_id = $1', [ws]);
    await pool.query('DELETE FROM segment_memberships WHERE workspace_id = $1', [ws]);
    await pool.query('DELETE FROM suppressions WHERE workspace_id = $1', [ws]);
    await pool.query('DELETE FROM messages_log WHERE workspace_id = $1', [ws]);
    await pool.query('DELETE FROM email_events WHERE workspace_id = $1', [ws]);
    await pool.query('DELETE FROM events WHERE workspace_id = $1', [ws]);
    await pool.query('DELETE FROM outbox WHERE workspace_id = $1', [ws]);
    await pool.query('DELETE FROM broadcasts WHERE workspace_id = $1', [ws]);
    await pool.query('DELETE FROM campaigns WHERE workspace_id = $1', [ws]);
    await pool.query('DELETE FROM segments WHERE workspace_id = $1', [ws]);
    await pool.query('DELETE FROM email_templates WHERE workspace_id = $1', [ws]);
    await pool.query('DELETE FROM profile_features WHERE workspace_id = $1', [ws]);
    await pool.query('DELETE FROM profiles WHERE workspace_id = $1', [ws]);
    await pool.query('DELETE FROM assets WHERE workspace_id = $1', [ws]);
    await pool.query('DELETE FROM asset_folders WHERE workspace_id = $1', [ws]);
    await pool.query('DELETE FROM domain_senders WHERE workspace_id = $1', [ws]);
    await pool.query('DELETE FROM sending_domains WHERE workspace_id = $1', [ws]);
    await pool.query('DELETE FROM workspace_users WHERE workspace_id = $1', [ws]);
    await pool.query('DELETE FROM workspaces WHERE id = $1', [ws]);
  }
  // Remove any EXTRA workspaces created by tests under the seeded companies (e.g.
  // the "owner adds a workspace" e2e), so they don't keep the company alive.
  await pool.query(
    'DELETE FROM workspace_users WHERE workspace_id IN (SELECT id FROM workspaces WHERE company_id = ANY($1::uuid[]))',
    [[CO_ACME, CO_BETA]],
  );
  await pool.query('DELETE FROM workspaces WHERE company_id = ANY($1::uuid[])', [[CO_ACME, CO_BETA]]);
  // Companies are the parent of workspaces — once their workspaces are gone, drop
  // any company with no remaining workspaces. This clears the seeded companies,
  // the admin-console test's 'Globex', AND any stale companies left by an earlier
  // migration backfill — keeping the e2e db clean.
  await pool.query('DELETE FROM companies WHERE id NOT IN (SELECT company_id FROM workspaces)');
  await pool.query('DELETE FROM admin_audit_log WHERE user_id = $1', [USER_ADMIN]);
  await pool.query('DELETE FROM platform_admins WHERE user_id = $1', [USER_ADMIN]);
  // App-owned user profiles (display names set via /account).
  await pool.query('DELETE FROM users WHERE id = ANY($1)', [[USER_MULTI, USER_MKT, USER_ADMIN]]);
}
