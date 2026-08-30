// PUT /templates/:id/transactional-key — marking a library template as reachable
// from the transactional API.
//
// The key is the CONTRACT with the integrator: they hardcode 'otp' in their own
// code, so it must resolve to exactly one template and must be able to move to a
// redesigned template without them redeploying.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { hasDatabaseUrl } from '@cdp/db';
import { makeWorld, tokenFor, call, type TestWorld } from './seed.js';
import type { Pool } from 'pg';

const CO = '0c0d7788-0000-4000-8000-000000000c01';
const WS = '0c0d7788-0000-4000-8000-000000000a01';
const USER = '0c0d7788-0000-4000-8000-0000000000b1';
const T1 = '0c0d7788-0000-4000-8000-0000000000e1';
const T2 = '0c0d7788-0000-4000-8000-0000000000e2';
const COPY = '0c0d7788-0000-4000-8000-0000000000e3';

const describeMaybe = hasDatabaseUrl() ? describe : describe.skip;

describeMaybe('template transactional key (real Postgres)', () => {
  let world: TestWorld;
  let pool: Pool;

  async function cleanup(): Promise<void> {
    for (const t of ['email_templates', 'workspace_users']) {
      await pool.query(`DELETE FROM ${t} WHERE workspace_id = $1`, [WS]).catch(() => {});
    }
    await pool.query('DELETE FROM workspaces WHERE id = $1', [WS]).catch(() => {});
    await pool.query('DELETE FROM companies WHERE id = $1', [CO]).catch(() => {});
  }

  beforeAll(async () => {
    world = makeWorld();
    pool = world.pool;
    await cleanup();
    await pool.query("INSERT INTO companies (id, name) VALUES ($1,'Keys Ltd')", [CO]);
    await pool.query("INSERT INTO workspaces (id, company_id, name, status) VALUES ($1,$2,'W','active')", [WS, CO]);
    await pool.query("INSERT INTO workspace_users (workspace_id, user_id, role) VALUES ($1,$2,'owner')", [WS, USER]);
    await pool.query(
      `INSERT INTO email_templates (id, workspace_id, name, kind, mjml, compiled_html) VALUES
         ($1,$4,'One time code','library','<mjml/>','<p/>'),
         ($2,$4,'Password reset','library','<mjml/>','<p/>'),
         ($3,$4,'A working copy','copy','<mjml/>','<p/>')`,
      [T1, T2, COPY, WS],
    );
  });

  afterAll(async () => {
    if (pool) {
      await cleanup();
      await pool.end();
    }
  });

  const setKey = (id: string, transactional_key: unknown) =>
    call(world.env, 'PUT', `/templates/${id}/transactional-key`, {
      token: tokenFor(USER, WS),
      body: { transactional_key },
    });

  const keyOf = async (id: string): Promise<string | null> => {
    const { rows } = await pool.query<{ k: string | null }>(
      'SELECT transactional_key AS k FROM email_templates WHERE id = $1',
      [id],
    );
    return rows[0]?.k ?? null;
  };

  it('sets a key', async () => {
    const res = await setKey(T1, 'otp');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ transactional_key: 'otp' });
    expect(await keyOf(T1)).toBe('otp');
  });

  // The caller hardcodes the key, so 'OTP' and 'otp' must not become two templates.
  it('normalizes case and surrounding whitespace', async () => {
    await setKey(T1, '  OTP  ');
    expect(await keyOf(T1)).toBe('otp');
  });

  // Naming the other template turns a dead end into a next step.
  it('409s a key already in use, naming the template that holds it', async () => {
    const res = await setKey(T2, 'otp');
    expect(res.status).toBe(409);
    expect((res.body as { error: string }).error).toContain('One time code');
    expect(await keyOf(T2)).toBeNull();
  });

  it('re-setting a template to its OWN key is not a conflict', async () => {
    expect((await setKey(T1, 'otp')).status).toBe(200);
  });

  it('rejects characters that would be awkward in a URL or in source', async () => {
    for (const bad of ['has space', 'UPPER!', '-leading', 'sym#bol', 'x'.repeat(65)]) {
      const res = await setKey(T2, bad);
      expect(res.status, `${bad} should be rejected`).toBe(400);
    }
    expect(await keyOf(T2)).toBeNull();
  });

  // Clearing has to work, or a key can never be moved to a redesigned template.
  it('clears the key with null or an empty string, freeing it for reuse', async () => {
    expect((await setKey(T1, null)).status).toBe(200);
    expect(await keyOf(T1)).toBeNull();
    expect((await setKey(T2, 'otp')).status).toBe(200);
    expect(await keyOf(T2)).toBe('otp');

    await setKey(T2, '');
    expect(await keyOf(T2)).toBeNull();
  });

  // A working copy belongs to one broadcast; giving it an API key would make the
  // contract point at something that dies with that broadcast.
  it('404s a per-broadcast working copy', async () => {
    expect((await setKey(COPY, 'otp')).status).toBe(404);
  });

  it('404s a template in another workspace', async () => {
    const res = await call(world.env, 'PUT', `/templates/${T1}/transactional-key`, {
      token: tokenFor(USER, WS),
      body: { transactional_key: 'x' },
    });
    expect(res.status).toBe(200); // sanity: our own is reachable
    const other = await call(world.env, 'PUT', '/templates/0c0d7788-0000-4000-8000-00000000ffff/transactional-key', {
      token: tokenFor(USER, WS),
      body: { transactional_key: 'y' },
    });
    expect(other.status).toBe(404);
  });

  it('the list exposes the key, so the UI can show which template is wired up', async () => {
    const res = await call(world.env, 'GET', '/templates', { token: tokenFor(USER, WS) });
    const list = (res.body as { templates: { id: string; transactional_key: string | null }[] }).templates;
    expect(list.find((t) => t.id === T1)?.transactional_key).toBe('x');
    // Working copies never appear in the library list at all.
    expect(list.find((t) => t.id === COPY)).toBeUndefined();
  });
});
