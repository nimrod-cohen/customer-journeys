// The last-owner guard (real Postgres): a company must ALWAYS keep ≥1 owner. This
// is enforced server-side against EVERY actor — including a system-admin (platform
// admin), who acts cross-tenant but is NOT a company owner and must not be able to
// remove/demote the sole owner and strand the company.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { hasDatabaseUrl } from '@cdp/db';
import { makeWorld, tokenFor, call, type TestWorld } from './seed.js';

const P = '0c0d0e0e-0000-4000-8000-';
const CO = `${P}0000000000f1`;
const WS = `${P}000000000a01`;
const OWNER = `${P}0000000000b1`; // the sole company owner
const OWNER2 = `${P}0000000000b2`; // a second owner added later
const ADMIN = `${P}0000000000b9`; // a platform (system) admin — NOT a company member

const describeMaybe = hasDatabaseUrl() ? describe : describe.skip;

describeMaybe('last-owner guard (real Postgres)', () => {
  let world: TestWorld;

  beforeAll(async () => {
    world = makeWorld();
    await cleanup();
    await world.pool.query("INSERT INTO companies (id, name) VALUES ($1,'Acme')", [CO]);
    await world.pool.query("INSERT INTO workspaces (id, name, status, company_id) VALUES ($1,'WS','active',$2)", [WS, CO]);
    await world.pool.query("INSERT INTO users (id, email) VALUES ($1,'o@acme.test'),($2,'o2@acme.test'),($3,'admin@sys.test')", [OWNER, OWNER2, ADMIN]);
    await world.pool.query("INSERT INTO company_users (company_id, user_id, role) VALUES ($1,$2,'owner')", [CO, OWNER]);
    // ADMIN is a platform admin (cross-tenant), NOT in company_users.
    await world.pool.query('INSERT INTO platform_admins (user_id) VALUES ($1) ON CONFLICT DO NOTHING', [ADMIN]);
  });

  afterAll(async () => {
    if (world) {
      await cleanup();
      await world.pool.end();
    }
  });

  async function cleanup(): Promise<void> {
    await world.pool.query('DELETE FROM platform_admins WHERE user_id = $1', [ADMIN]);
    await world.pool.query('DELETE FROM company_users WHERE company_id = $1', [CO]);
    await world.pool.query('DELETE FROM workspace_users WHERE workspace_id = $1', [WS]);
    await world.pool.query('DELETE FROM workspaces WHERE id = $1', [WS]);
    await world.pool.query('DELETE FROM companies WHERE id = $1', [CO]);
    await world.pool.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [[OWNER, OWNER2, ADMIN]]);
  }

  const ownerCount = async () =>
    Number((await world.pool.query<{ n: number }>("SELECT count(*)::int n FROM company_users WHERE company_id=$1 AND role='owner'", [CO])).rows[0]?.n ?? 0);
  const roleOf = async (uid: string) =>
    (await world.pool.query<{ role: string }>('SELECT role FROM company_users WHERE company_id=$1 AND user_id=$2', [CO, uid])).rows[0]?.role;

  // The system-admin is viewing Value-Investing-Academy-style: a platform-admin token
  // with the company's workspace active (exactly the screenshot's situation).
  const adminTok = () => tokenFor(ADMIN, WS);

  it('a SYSTEM-ADMIN cannot REMOVE the sole company owner (409, owner intact)', async () => {
    const r = await call(world.env, 'DELETE', `/company/users/${OWNER}`, { token: adminTok() });
    expect(r.status).toBe(409);
    expect(await roleOf(OWNER)).toBe('owner');
    expect(await ownerCount()).toBe(1);
  });

  it('a SYSTEM-ADMIN cannot DEMOTE the sole company owner (409, still owner)', async () => {
    const r = await call(world.env, 'PATCH', '/company/users', {
      token: adminTok(),
      body: { user_id: OWNER, role: 'marketer' },
    });
    expect(r.status).toBe(409);
    expect(await roleOf(OWNER)).toBe('owner');
  });

  it('with TWO owners, one can be removed (guard only blocks the LAST)', async () => {
    // The admin promotes a second person to owner…
    const add = await call(world.env, 'POST', '/company/users', {
      token: adminTok(),
      body: { email: 'o2@acme.test', role: 'owner' },
    });
    expect(add.status).toBe(201);
    expect(await ownerCount()).toBe(2);
    // …now removing OWNER is allowed (OWNER2 remains).
    const del = await call(world.env, 'DELETE', `/company/users/${OWNER}`, { token: adminTok() });
    expect(del.status).toBe(200);
    expect(await ownerCount()).toBe(1);
    expect(await roleOf(OWNER2)).toBe('owner');
    // But now OWNER2 is the last owner — can't be removed.
    const del2 = await call(world.env, 'DELETE', `/company/users/${OWNER2}`, { token: adminTok() });
    expect(del2.status).toBe(409);
  });
});
