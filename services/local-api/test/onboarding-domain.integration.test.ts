// Guided domain onboarding through the API (§10A, §18 "Sending gated on
// verification"). REAL Postgres; SES + DNS are MOCKED at the boundary via the
// injected local deps. We drive start → check → activate for a workspace and
// prove the workspace flips to `active` ONLY when the (mocked) SES DKIM is
// verified and required DNS resolves. We also prove the gate stays CLOSED when
// SES reports PENDING.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { hasDatabaseUrl } from '@cdp/db';
import {
  makePgLookups,
  makeLocalDeps,
  makeLocalSes,
  makeLocalDns,
  dispatch,
  type DispatchEnv,
} from '../src/index.js';
import { adminPool } from '@cdp/db';
import { configSetNameFor, makeWorkspaceTxRunner } from '@cdp/service-onboarding';
import { tokenFor } from './seed.js';
import type { Pool } from 'pg';
import type { SesEmailClient } from '@cdp/email';

const WS = '0c0d0e04-0000-4000-8000-000000000a01';
const OWNER = '0c0d0e04-0000-4000-8000-0000000000b1';

const describeMaybe = hasDatabaseUrl() ? describe : describe.skip;

function envWith(pool: Pool, ses: SesEmailClient): DispatchEnv {
  const base = makeLocalDeps(pool);
  const deps = {
    ...base,
    onboarding: {
      ses,
      dns: makeLocalDns(),
      identity: base.onboarding.identity,
      runInWorkspaceTx: makeWorkspaceTxRunner(pool),
      region: 'us-east-1',
      configSetName: configSetNameFor,
    },
  };
  return { pool, lookups: makePgLookups(pool), deps };
}

describeMaybe('onboarding domain wizard via API (real Postgres)', () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = adminPool();
    await cleanup();
    await pool.query("INSERT INTO workspaces (id, name, status) VALUES ($1,'W','onboarding')", [WS]);
    await pool.query(
      "INSERT INTO workspace_users (workspace_id, user_id, role) VALUES ($1,$2,'owner')",
      [WS, OWNER],
    );
  });

  afterAll(async () => {
    if (pool) {
      await cleanup();
      await pool.end();
    }
  });

  async function cleanup(): Promise<void> {
    await pool.query('DELETE FROM workspace_users WHERE workspace_id = $1', [WS]);
    await pool.query('DELETE FROM workspaces WHERE id = $1', [WS]);
  }

  async function status(): Promise<string> {
    const { rows } = await pool.query<{ status: string }>(
      'SELECT status FROM workspaces WHERE id = $1',
      [WS],
    );
    return rows[0]!.status;
  }

  it('start → check → activate flips status to active when SES DKIM is verified', async () => {
    const env = envWith(pool, makeLocalSes()); // local SES defaults to SUCCESS
    const t = tokenFor(OWNER, WS);

    const start = await dispatch(
      { method: 'POST', path: '/sending-domain/start', authorization: t, query: {}, body: { from_domain: 'mail.acme.com' } },
      env,
    );
    expect(start.status).toBe(200);
    expect((start.body as { records: { records: unknown[] } }).records.records.length).toBeGreaterThan(0);
    expect(await status()).toBe('onboarding');

    const check = await dispatch(
      { method: 'POST', path: '/sending-domain/check', authorization: t, query: {}, body: {} },
      env,
    );
    expect(check.status).toBe(200);
    expect((check.body as { dkimVerified: boolean }).dkimVerified).toBe(true);

    const activate = await dispatch(
      { method: 'POST', path: '/sending-domain/activate', authorization: t, query: {}, body: {} },
      env,
    );
    expect(activate.status).toBe(200);
    expect((activate.body as { decision: { allowed: boolean } }).decision.allowed).toBe(true);
    expect(await status()).toBe('active');
  });

  it('activate is DENIED (status unchanged) when SES DKIM is PENDING', async () => {
    // Re-seed onboarding state for a clean gate test.
    await pool.query("UPDATE workspaces SET status='onboarding' WHERE id=$1", [WS]);
    const pendingSes: SesEmailClient = {
      ...makeLocalSes(),
      async getIdentityVerificationAttributes() {
        return { dkimStatus: 'PENDING', signingEnabled: false, dkimTokens: ['tok1', 'tok2', 'tok3'] };
      },
    };
    const env = envWith(pool, pendingSes);
    const t = tokenFor(OWNER, WS);

    await dispatch(
      { method: 'POST', path: '/sending-domain/start', authorization: t, query: {}, body: { from_domain: 'mail.acme.com' } },
      env,
    );
    const activate = await dispatch(
      { method: 'POST', path: '/sending-domain/activate', authorization: t, query: {}, body: {} },
      env,
    );
    expect((activate.body as { decision: { allowed: boolean } }).decision.allowed).toBe(false);
    expect(await status()).toBe('onboarding');
  });
});
