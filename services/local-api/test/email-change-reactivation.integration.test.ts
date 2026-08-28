// Editing a profile's email address and what that does to deliverability state.
//
// The governing rule: A BOUNCE IS A PROPERTY OF THE ADDRESS; A REFUSAL IS A
// PROPERTY OF THE PERSON.
//
//   - hard bounce  -> the new address starts clean and becomes sendable again
//   - complaint    -> carries forward; reporting spam is about the person
//   - unsubscribe  -> carries forward, via profile-keyed channel_optouts
//
// Before this, changing a bounced profile's email actively made things WORSE: the
// suppression reconcile read the stale `email_status='bounced'` and suppressed the
// NEW address too. REAL Postgres.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { hasDatabaseUrl } from '@cdp/db';
import { makeWorld, tokenFor, call, type TestWorld } from './seed.js';

const WS = '0c0d0f11-0000-4000-8000-000000000a01';
const USER = '0c0d0f11-0000-4000-8000-0000000000b1';
const P_BOUNCED = '0c0d0f11-0000-4000-8000-0000000000c1';
const P_COMPLAINED = '0c0d0f11-0000-4000-8000-0000000000c2';

const describeMaybe = hasDatabaseUrl() ? describe : describe.skip;

describeMaybe('email change resets bounce state but never consent (real Postgres)', () => {
  let world: TestWorld;
  const tok = () => tokenFor(USER, WS);

  async function cleanup(): Promise<void> {
    await world.pool.query('DELETE FROM suppressions WHERE workspace_id=$1', [WS]);
    await world.pool.query('DELETE FROM channel_optouts WHERE workspace_id=$1', [WS]);
    await world.pool.query('DELETE FROM profiles WHERE workspace_id=$1', [WS]);
    await world.pool.query('DELETE FROM workspace_users WHERE workspace_id=$1', [WS]);
    await world.pool.query('DELETE FROM workspaces WHERE id=$1', [WS]);
  }

  beforeAll(async () => {
    world = makeWorld();
    await cleanup();
    await world.pool.query("INSERT INTO workspaces (id, name, status) VALUES ($1,'W','active')", [WS]);
    await world.pool.query(
      "INSERT INTO workspace_users (workspace_id, user_id, role) VALUES ($1,$2,'owner')",
      [WS, USER],
    );
    // A profile whose address hard-bounced, exactly as the feedback path leaves it.
    await world.pool.query(
      "INSERT INTO profiles (id, workspace_id, email, email_status) VALUES ($1,$2,'dead@old.com','bounced')",
      [P_BOUNCED, WS],
    );
    await world.pool.query(
      "INSERT INTO suppressions (workspace_id, email, reason, source) VALUES ($1,'dead@old.com','hard_bounce','mta')",
      [WS],
    );
    // A profile whose owner reported the mail as spam.
    await world.pool.query(
      "INSERT INTO profiles (id, workspace_id, email, email_status) VALUES ($1,$2,'angry@old.com','complained')",
      [P_COMPLAINED, WS],
    );
    await world.pool.query(
      "INSERT INTO suppressions (workspace_id, email, reason, source) VALUES ($1,'angry@old.com','complaint','mta')",
      [WS],
    );
  });

  afterAll(async () => {
    if (world) {
      await cleanup();
      await world.pool.end();
    }
  });

  const suppressed = async (email: string): Promise<boolean> => {
    const { rows } = await world.pool.query('SELECT 1 FROM suppressions WHERE workspace_id=$1 AND email=$2', [WS, email]);
    return rows.length > 0;
  };
  const statusOf = async (id: string): Promise<string> => {
    const { rows } = await world.pool.query<{ email_status: string }>(
      'SELECT email_status FROM profiles WHERE id=$1',
      [id],
    );
    return rows[0]!.email_status;
  };

  it('reactivates a bounced profile when its address is corrected', async () => {
    const res = await call(world.env, 'PATCH', `/profiles/${P_BOUNCED}`, {
      token: tok(),
      body: {
      email: 'alive@new.com',
      },
    });
    expect(res.status).toBe(200);

    // The address was bad, not the person.
    expect(await statusOf(P_BOUNCED)).toBe('active');
    expect(await suppressed('alive@new.com')).toBe(false);
    // The old address genuinely bounced and stays on the list.
    expect(await suppressed('dead@old.com')).toBe(true);
  });

  it('keeps a complaint when the address changes — that was about the person', async () => {
    const res = await call(world.env, 'PATCH', `/profiles/${P_COMPLAINED}`, {
      token: tok(),
      body: {
      email: 'angry@new.com',
      },
    });
    expect(res.status).toBe(200);

    expect(await statusOf(P_COMPLAINED)).toBe('complained');
    expect(await suppressed('angry@new.com')).toBe(true);
  });

  it('leaves email_status alone when the address is unchanged', async () => {
    await world.pool.query("UPDATE profiles SET email_status='bounced' WHERE id=$1", [P_BOUNCED]);
    const res = await call(world.env, 'PATCH', `/profiles/${P_BOUNCED}`, {
      token: tok(),
      body: {
      email: 'alive@new.com', // same as it already is
      external_id: 'x1',
      },
    });
    expect(res.status).toBe(200);
    expect(await statusOf(P_BOUNCED)).toBe('bounced');
  });

  it('still honours an explicitly requested email_status', async () => {
    const res = await call(world.env, 'PATCH', `/profiles/${P_BOUNCED}`, {
      token: tok(),
      body: {
      email: 'another@new.com',
      email_status: 'bounced',
      },
    });
    expect(res.status).toBe(200);
    expect(await statusOf(P_BOUNCED)).toBe('bounced');
  });
});
