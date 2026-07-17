// Phone as a core identity field (real Postgres): identify/create/update a profile by
// email and/or phone, with E.164 normalization + the "prefer email, don't steal the phone"
// rule, plus segmenting on customer.phone.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { hasDatabaseUrl, adminPool } from '@cdp/db';
import { makePgLookups, makeLocalDeps, dispatch, type DispatchEnv } from '../src/index.js';
import { ingestIdentify } from '../src/handlers.js';
import { tokenFor } from './seed.js';
import type { Pool } from 'pg';

const P = '0c0d0f0b-0000-4000-8000-';
const WS = `${P}000000000a01`;
const OWNER = `${P}0000000000b1`;

const describeMaybe = hasDatabaseUrl() ? describe : describe.skip;

describeMaybe('phone as a core identity field (real Postgres)', () => {
  let pool: Pool;
  let key: string;
  const env = (): DispatchEnv => ({ pool, lookups: makePgLookups(pool), deps: makeLocalDeps(pool) });
  const call = (method: string, path: string, body: Record<string, unknown> = {}) =>
    dispatch({ method, path, authorization: tokenFor(OWNER, WS), query: {}, body }, env());
  const bodyOf = (r: { body: unknown }) => r.body as Record<string, unknown>;
  const rowById = async (id: string) =>
    (await pool.query('SELECT email, phone FROM profiles WHERE id=$1', [id])).rows[0] as { email: string | null; phone: string | null };

  beforeAll(async () => {
    pool = adminPool();
    await cleanup();
    // default_phone_country = IL so national numbers normalize to +972…
    await pool.query(
      `INSERT INTO workspaces (id, name, status, settings) VALUES ($1,'W','active','{"default_phone_country":"IL"}'::jsonb)`,
      [WS],
    );
    await pool.query("INSERT INTO workspace_users (workspace_id, user_id, role) VALUES ($1,$2,'owner')", [WS, OWNER]);
    key = (bodyOf(await call('POST', '/ingest-keys', { label: 'k' })).key as string);
  });
  afterAll(async () => {
    if (pool) {
      await cleanup();
      await pool.end();
    }
  });
  async function cleanup(): Promise<void> {
    for (const t of ['activity_log', 'events', 'profile_features', 'segment_memberships', 'segments', 'profiles', 'ingest_keys', 'workspace_users']) {
      await pool.query(`DELETE FROM ${t} WHERE workspace_id=$1`, [WS]);
    }
    await pool.query('DELETE FROM workspaces WHERE id=$1', [WS]);
  }

  it('identify by PHONE only (IL national) creates a phone-based profile, normalized', async () => {
    const r = await ingestIdentify(pool, key, { phone: '054-1111111', traits: { first_name: 'Dana' } });
    expect(r.status).toBe(202);
    const p = await rowById(bodyOf(r).profile_id as string);
    expect(p.email).toBeNull();
    expect(p.phone).toBe('+972541111111');
  });

  it('a re-identify with the +E.164 form resolves the SAME profile', async () => {
    const a = await ingestIdentify(pool, key, { phone: '054-2222222' });
    const b = await ingestIdentify(pool, key, { phone: '+972542222222' });
    expect(bodyOf(b).profile_id).toBe(bodyOf(a).profile_id);
  });

  it('identify by both attaches the phone to the email profile (when free)', async () => {
    const r = await ingestIdentify(pool, key, { email: 'jane@x.com', phone: '054-3333333' });
    const p = await rowById(bodyOf(r).profile_id as string);
    expect(p.email).toBe('jane@x.com');
    expect(p.phone).toBe('+972543333333');
  });

  it("prefer email, DON'T steal the phone: an email profile does not take a phone owned by another", async () => {
    // profile A owns +972544444444
    const a = await ingestIdentify(pool, key, { phone: '054-4444444' });
    const aId = bodyOf(a).profile_id as string;
    // a DIFFERENT email profile identifies with that same phone → email wins, phone NOT stolen
    const b = await ingestIdentify(pool, key, { email: 'bob@x.com', phone: '054-4444444' });
    const bId = bodyOf(b).profile_id as string;
    expect(bId).not.toBe(aId);
    expect((await rowById(bId)).phone).toBeNull(); // did not steal
    expect((await rowById(aId)).phone).toBe('+972544444444'); // untouched
  });

  it('bad phone + a valid email → record kept, phone dropped', async () => {
    const r = await ingestIdentify(pool, key, { email: 'kim@x.com', phone: 'garbage' });
    expect(r.status).toBe(202);
    expect((await rowById(bodyOf(r).profile_id as string)).phone).toBeNull();
  });

  it('bad phone-only → 400 (no reliable identity)', async () => {
    const r = await ingestIdentify(pool, key, { phone: 'garbage' });
    expect(r.status).toBe(400);
  });

  it('POST /profiles by phone only → 201; a duplicate phone → 409', async () => {
    const c = await call('POST', '/profiles', { phone: '054-5555555' });
    expect(c.status).toBe(201);
    const dup = await call('POST', '/profiles', { phone: '+972545555555' });
    expect(dup.status).toBe(409);
  });

  it('PATCH sets + normalizes a phone; clearing the last identifier is rejected (400)', async () => {
    const c = await call('POST', '/profiles', { email: 'edit@x.com' });
    const id = (bodyOf(c).profile as { id: string }).id;
    const set = await call('PATCH', `/profiles/${id}`, { phone: '054-6666666' });
    expect(set.status).toBe(200);
    expect((await rowById(id)).phone).toBe('+972546666666');
    // clearing email AND phone → the CHECK rejects it
    const bad = await call('PATCH', `/profiles/${id}`, { email: '', phone: '' });
    expect(bad.status).toBe(400);
  });

  it('a segment rule on customer.phone matches the profile', async () => {
    const r = await ingestIdentify(pool, key, { email: 'seg@x.com', phone: '054-7777777' });
    const pid = bodyOf(r).profile_id as string;
    const rule = { field: 'customer.phone', operator: '=', value: '+972547777777' };
    const q = await call('POST', '/profiles/query', { rule });
    const ids = (bodyOf(q).profiles as { id: string }[]).map((p) => p.id);
    expect(ids).toContain(pid);
  });
});
