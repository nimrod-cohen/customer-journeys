// GET /company/workspaces (real Postgres): lists the ACTIVE company's workspaces
// (regardless of the viewer's per-workspace memberships), scoped to that company —
// another company's workspaces never leak. This is what the Company settings →
// Workspaces list renders (session.memberships is empty for a platform admin).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { hasDatabaseUrl, adminPool } from '@cdp/db';
import { makePgLookups, makeLocalDeps, dispatch, type DispatchEnv } from '../src/index.js';
import { tokenFor } from './seed.js';
import type { Pool } from 'pg';

const P = '0c0d0f03-0000-4000-8000-';
const CO = `${P}0000000000f1`;
const CO2 = `${P}0000000000f2`;
const WS1 = `${P}000000000a01`;
const WS2 = `${P}000000000a02`;
const WS3 = `${P}000000000a03`;
const OWNER = `${P}0000000000b1`;

const describeMaybe = hasDatabaseUrl() ? describe : describe.skip;

describeMaybe('GET /company/workspaces (real Postgres)', () => {
  let pool: Pool;
  const env = (): DispatchEnv => ({ pool, lookups: makePgLookups(pool), deps: makeLocalDeps(pool) });

  beforeAll(async () => {
    pool = adminPool();
    await cleanup();
    await pool.query("INSERT INTO companies (id, name) VALUES ($1,'Acme'),($2,'Other')", [CO, CO2]);
    await pool.query(
      "INSERT INTO workspaces (id, name, status, company_id) VALUES ($1,'Alpha','active',$4),($2,'Beta','active',$4),($3,'Foreign','active',$5)",
      [WS1, WS2, WS3, CO, CO2],
    );
    await pool.query("INSERT INTO company_users (company_id, user_id, role) VALUES ($1,$2,'owner')", [CO, OWNER]);
  });
  afterAll(async () => {
    if (pool) {
      await cleanup();
      await pool.end();
    }
  });
  async function cleanup(): Promise<void> {
    await pool.query('DELETE FROM company_users WHERE company_id = ANY($1)', [[CO, CO2]]);
    await pool.query('DELETE FROM workspaces WHERE id = ANY($1)', [[WS1, WS2, WS3]]);
    await pool.query('DELETE FROM companies WHERE id = ANY($1)', [[CO, CO2]]);
  }

  it('lists ALL of the active company\'s workspaces, not just the caller\'s memberships', async () => {
    const r = await dispatch({ method: 'GET', path: '/company/workspaces', authorization: tokenFor(OWNER, WS1), query: {}, body: {} }, env());
    expect(r.status).toBe(200);
    const names = (r.body as { workspaces: Array<{ id: string; name: string }> }).workspaces.map((w) => w.name).sort();
    expect(names).toEqual(['Alpha', 'Beta']); // both company workspaces
    const ids = (r.body as { workspaces: Array<{ id: string }> }).workspaces.map((w) => w.id);
    expect(ids).not.toContain(WS3); // the other company's workspace never leaks
  });
});
