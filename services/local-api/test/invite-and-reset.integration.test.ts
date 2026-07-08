// Invite + password-reset flows (real Postgres, mock transactional mailer). An
// owner invites a NEW email → a pending account + an invite email carrying a
// one-time token → the invitee sets a password and is logged in. Plus forgot/reset.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { hasDatabaseUrl, adminPool } from '@cdp/db';
import { MockTransactionalMailer } from '@cdp/email';
import type { Pool } from 'pg';
import { makePgLookups, makeLocalDeps, type DispatchEnv } from '../src/index.js';
import { acceptInvite, forgotPassword, resetPassword, devLogin } from '../src/session.js';
import { tokenFor, call } from './seed.js';

const P = '0c0d0e0d-0000-4000-8000-';
const CO = `${P}0000000000f1`;
const WS = `${P}000000000a01`;
const OWNER = `${P}0000000000b1`;
const NEW_EMAIL = 'invited-newbie@example.test';

const tokenFromLink = (text: string, path: string): string => {
  const m = new RegExp(`${path}\\?token=([^\\s"&]+)`).exec(text);
  return m ? decodeURIComponent(m[1]!) : '';
};

const describeMaybe = hasDatabaseUrl() ? describe : describe.skip;

describeMaybe('invite + password reset (real Postgres)', () => {
  let pool: Pool;
  let mailer: MockTransactionalMailer;
  let env: DispatchEnv;

  beforeAll(async () => {
    pool = adminPool();
    mailer = new MockTransactionalMailer();
    env = { pool, lookups: makePgLookups(pool), deps: makeLocalDeps(pool, undefined, undefined, mailer) };
    await cleanup();
    await pool.query("INSERT INTO companies (id, name) VALUES ($1,'Acme')", [CO]);
    await pool.query("INSERT INTO workspaces (id, name, status, company_id) VALUES ($1,'WS','active',$2)", [WS, CO]);
    await pool.query("INSERT INTO users (id, email, name) VALUES ($1,'owner-inv@invitetest.example','Owner')", [OWNER]);
    await pool.query("INSERT INTO company_users (company_id, user_id, role) VALUES ($1,$2,'owner')", [CO, OWNER]);
  });

  afterAll(async () => {
    await cleanup();
  });

  async function cleanup(): Promise<void> {
    await pool.query('DELETE FROM user_auth_tokens WHERE user_id IN (SELECT id FROM users WHERE email = ANY($1))', [
      [NEW_EMAIL, 'owner-inv@invitetest.example'],
    ]);
    await pool.query('DELETE FROM company_users WHERE company_id = $1', [CO]);
    await pool.query('DELETE FROM workspace_users WHERE workspace_id = $1', [WS]);
    await pool.query('DELETE FROM workspaces WHERE id = $1', [WS]);
    await pool.query('DELETE FROM companies WHERE id = $1', [CO]);
    await pool.query('DELETE FROM users WHERE email = ANY($1)', [[NEW_EMAIL, 'owner-inv@invitetest.example']]);
  }

  it('inviting a NEW email creates a pending account + sends an invite email', async () => {
    const r = await call(env, 'POST', '/company/users', {
      token: tokenFor(OWNER, WS),
      body: { email: NEW_EMAIL, role: 'marketer', workspace_ids: [WS] },
    });
    expect(r.status).toBe(201);
    expect((r.body as { invited: boolean }).invited).toBe(true);
    // A pending user exists with NO password yet.
    const u = await pool.query<{ id: string; password_hash: string | null }>(
      'SELECT id, password_hash FROM users WHERE email = $1',
      [NEW_EMAIL],
    );
    expect(u.rows[0]).toBeTruthy();
    expect(u.rows[0]!.password_hash).toBeNull();
    // An invite email was sent to them.
    const sent = mailer.sends.filter((s) => s.to === NEW_EMAIL);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.subject).toMatch(/invited to Acme/i);
    expect(tokenFromLink(sent[0]!.text ?? '', '/accept-invite')).toBeTruthy();
  });

  it('accepting the invite sets a password + logs in; the token is single-use', async () => {
    const invite = mailer.sends.find((s) => s.to === NEW_EMAIL)!;
    const token = tokenFromLink(invite.text ?? '', '/accept-invite');
    // Too-short password rejected.
    expect((await acceptInvite(env.lookups, pool, { token, password: 'short' })).status).toBe(400);
    // Valid acceptance logs them in (marketer with a WS grant → active workspace).
    const ok = await acceptInvite(env.lookups, pool, { token, password: 'a-good-password' });
    expect(ok.status).toBe(200);
    const body = ok.body as { token: string; role: string; workspace_id: string | null };
    expect(body.token).toBeTruthy();
    expect(body.role).toBe('marketer');
    expect(body.workspace_id).toBe(WS);
    // Re-using the token now fails (single-use).
    expect((await acceptInvite(env.lookups, pool, { token, password: 'another-password' })).status).toBe(400);
    // They can log in with the new password.
    expect((await devLogin(env.lookups, pool, { email: NEW_EMAIL, password: 'a-good-password' })).status).toBe(200);
  });

  it('forgot-password emails a reset link (existing user) and 200s silently for unknown emails', async () => {
    const before = mailer.sends.length;
    // Unknown email → 200, no email.
    const unknown = await forgotPassword(
      { mailer, appBaseUrl: env.deps.appBaseUrl, pool },
      { email: 'nobody@nowhere.test' },
    );
    expect(unknown.status).toBe(200);
    expect(mailer.sends.length).toBe(before);
    // Known email → 200 + a reset email.
    const known = await forgotPassword({ mailer, appBaseUrl: env.deps.appBaseUrl, pool }, { email: NEW_EMAIL });
    expect(known.status).toBe(200);
    const reset = mailer.sends.filter((s) => s.to === NEW_EMAIL && /reset/i.test(s.subject));
    expect(reset.length).toBeGreaterThanOrEqual(1);
    const token = tokenFromLink(reset.at(-1)!.text ?? '', '/reset-password');
    expect(token).toBeTruthy();

    // Complete the reset → logged in, and the new password works.
    const done = await resetPassword(env.lookups, pool, { token, password: 'brand-new-pass' });
    expect(done.status).toBe(200);
    expect((await devLogin(env.lookups, pool, { email: NEW_EMAIL, password: 'brand-new-pass' })).status).toBe(200);
    // Old password no longer valid.
    expect((await devLogin(env.lookups, pool, { email: NEW_EMAIL, password: 'a-good-password' })).status).toBe(401);
  });
});
