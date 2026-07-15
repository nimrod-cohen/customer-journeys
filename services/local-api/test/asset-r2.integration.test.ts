// Asset object-storage flow (real Postgres, fake R2). Proves: with storage
// configured, POST /assets PUTs the bytes to the bucket + stores only the key
// (no base64), GET /assets/:id 302-redirects to the CDN URL, DELETE removes the
// object; and with NO storage it falls back to base64-in-Postgres served inline.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { hasDatabaseUrl, adminPool } from '@cdp/db';
import { makePgLookups, makeLocalDeps, dispatch, createApp, type DispatchEnv } from '../src/index.js';
import type { ObjectStorage } from '../src/storage.js';
import { tokenFor } from './seed.js';
import type { Pool } from 'pg';

const P = '0c0d0f01-0000-4000-8000-';
const WS = `${P}000000000a01`;
const OWNER = `${P}0000000000b1`;
// a tiny 1x1 png
const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

const describeMaybe = hasDatabaseUrl() ? describe : describe.skip;

class FakeStorage implements ObjectStorage {
  puts: Array<{ key: string; len: number; ct: string }> = [];
  dels: string[] = [];
  async put(key: string, body: Buffer, contentType: string): Promise<void> {
    this.puts.push({ key, len: body.length, ct: contentType });
  }
  async del(key: string): Promise<void> {
    this.dels.push(key);
  }
  publicUrl(key: string): string {
    return `https://cdn.test/${key}`;
  }
}

describeMaybe('asset object storage (real Postgres, fake R2)', () => {
  let pool: Pool;
  let storage: FakeStorage;
  const envWith = (s: ObjectStorage | null): DispatchEnv => ({
    pool,
    lookups: makePgLookups(pool),
    deps: { ...makeLocalDeps(pool), storage: s },
  });

  beforeAll(async () => {
    pool = adminPool();
    storage = new FakeStorage();
    await cleanup();
    await pool.query("INSERT INTO workspaces (id, name, status) VALUES ($1,'W','active')", [WS]);
    await pool.query("INSERT INTO workspace_users (workspace_id, user_id, role) VALUES ($1,$2,'owner')", [WS, OWNER]);
  });
  afterAll(async () => {
    if (pool) {
      await cleanup();
      await pool.end();
    }
  });
  async function cleanup(): Promise<void> {
    await pool.query('DELETE FROM assets WHERE workspace_id = $1', [WS]);
    await pool.query('DELETE FROM workspace_users WHERE workspace_id = $1', [WS]);
    await pool.query('DELETE FROM workspaces WHERE id = $1', [WS]);
  }

  it('R2 configured: PUTs to the bucket, stores only the key, redirects, deletes', async () => {
    const env = envWith(storage);
    const up = await dispatch(
      { method: 'POST', path: '/assets', authorization: tokenFor(OWNER, WS), query: {}, body: { filename: 'a.png', mime: 'image/png', data_base64: PNG_B64, folder: 'logos' } },
      env,
    );
    expect(up.status).toBe(201);
    const id = (up.body as { id: string; path: string }).id;
    expect((up.body as { path: string }).path).toBe(`/assets/${id}`);

    // Bytes went to the bucket under a workspace-prefixed key; nothing else.
    expect(storage.puts).toHaveLength(1);
    expect(storage.puts[0]!.key).toBe(`assets/${WS}/${id}`);
    expect(storage.puts[0]!.ct).toBe('image/png');
    expect(storage.puts[0]!.len).toBe(Buffer.from(PNG_B64, 'base64').length);

    // The row records storage='r2' + the key, and carries NO base64.
    const row = await pool.query<{ storage: string; r2_key: string; data: string | null; size_bytes: number }>(
      'SELECT storage, r2_key, data, size_bytes FROM assets WHERE id = $1',
      [id],
    );
    expect(row.rows[0]!.storage).toBe('r2');
    expect(row.rows[0]!.r2_key).toBe(`assets/${WS}/${id}`);
    expect(row.rows[0]!.data).toBeNull();
    expect(row.rows[0]!.size_bytes).toBeGreaterThan(0);

    // GET /assets/:id 302-redirects to the CDN URL (bytes never touch the server).
    const app = createApp({ pool, deps: env.deps });
    const res = await app.request(`/assets/${id}`, { redirect: 'manual' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(`https://cdn.test/assets/${WS}/${id}`);

    // DELETE removes the object from the bucket + the row.
    const del = await dispatch({ method: 'DELETE', path: `/assets/${id}`, authorization: tokenFor(OWNER, WS), query: {}, body: {} }, env);
    expect(del.status).toBe(200);
    expect(storage.dels).toEqual([`assets/${WS}/${id}`]);
    expect((await pool.query('SELECT 1 FROM assets WHERE id = $1', [id])).rowCount).toBe(0);
  });

  it('no storage configured: falls back to base64-in-Postgres, served inline', async () => {
    const env = envWith(null);
    const up = await dispatch(
      { method: 'POST', path: '/assets', authorization: tokenFor(OWNER, WS), query: {}, body: { filename: 'b.png', mime: 'image/png', data_base64: PNG_B64 } },
      env,
    );
    expect(up.status).toBe(201);
    const id = (up.body as { id: string }).id;
    const row = await pool.query<{ storage: string; data: string | null }>('SELECT storage, data FROM assets WHERE id = $1', [id]);
    expect(row.rows[0]!.storage).toBe('db');
    expect(row.rows[0]!.data).toBe(PNG_B64);

    const app = createApp({ pool, deps: env.deps });
    const res = await app.request(`/assets/${id}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(new Uint8Array(await res.arrayBuffer()).length).toBe(Buffer.from(PNG_B64, 'base64').length);
  });
});
