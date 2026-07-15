// Per-company R2 image storage (real Postgres, fake bucket). End-to-end: configure
// R2 via PUT /company/r2-config (secret encrypted at rest, write-only), then an
// upload PUTs to THAT company's bucket + stores only the key (no base64), GET
// /assets/:id STREAMS the bytes back (same domain — not a redirect), DELETE removes
// the object; clearing the config falls back to base64-in-Postgres served inline.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { hasDatabaseUrl, adminPool, isEncryptedSecret } from '@cdp/db';
import { makePgLookups, makeLocalDeps, dispatch, createApp, type DispatchEnv } from '../src/index.js';
import type { ObjectStorage, R2Config, R2StorageFactory } from '../src/storage.js';
import { tokenFor } from './seed.js';
import type { Pool } from 'pg';

const P = '0c0d0f02-0000-4000-8000-';
const CO = `${P}0000000000f1`;
const WS = `${P}000000000a01`;
const OWNER = `${P}0000000000b1`;
const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

const describeMaybe = hasDatabaseUrl() ? describe : describe.skip;

// In-memory stand-in for a company's R2 bucket.
class MemBucket implements ObjectStorage {
  objects = new Map<string, { body: Buffer; ct: string }>();
  puts: string[] = [];
  dels: string[] = [];
  async put(key: string, body: Buffer, ct: string): Promise<void> {
    this.objects.set(key, { body, ct });
    this.puts.push(key);
  }
  async get(key: string): Promise<{ body: Buffer; contentType: string | undefined } | null> {
    const o = this.objects.get(key);
    return o ? { body: o.body, contentType: o.ct } : null;
  }
  async del(key: string): Promise<void> {
    this.objects.delete(key);
    this.dels.push(key);
  }
}

describeMaybe('per-company R2 image storage (real Postgres, fake bucket)', () => {
  let pool: Pool;
  let bucket: MemBucket;
  let lastConfig: R2Config | null;
  const factory: R2StorageFactory = (cfg) => {
    lastConfig = cfg;
    return bucket;
  };
  const env = (): DispatchEnv => ({ pool, lookups: makePgLookups(pool), deps: { ...makeLocalDeps(pool), makeR2Storage: factory } });
  const owner = () => tokenFor(OWNER, WS);

  beforeAll(async () => {
    pool = adminPool();
    bucket = new MemBucket();
    lastConfig = null;
    await cleanup();
    await pool.query("INSERT INTO companies (id, name) VALUES ($1,'Acme')", [CO]);
    await pool.query("INSERT INTO workspaces (id, name, status, company_id) VALUES ($1,'W','active',$2)", [WS, CO]);
    await pool.query("INSERT INTO company_users (company_id, user_id, role) VALUES ($1,$2,'owner')", [CO, OWNER]);
  });
  afterAll(async () => {
    if (pool) {
      await cleanup();
      await pool.end();
    }
  });
  async function cleanup(): Promise<void> {
    await pool.query('DELETE FROM assets WHERE workspace_id = $1', [WS]);
    await pool.query('DELETE FROM company_r2_config WHERE company_id = $1', [CO]);
    await pool.query('DELETE FROM company_users WHERE company_id = $1', [CO]);
    await pool.query('DELETE FROM workspaces WHERE id = $1', [WS]);
    await pool.query('DELETE FROM companies WHERE id = $1', [CO]);
  }

  it('configures R2 (secret encrypted at rest, write-only), then uploads → bucket, streams, deletes', async () => {
    // Configure via the real handler: the secret is encrypted, never echoed.
    const put = await dispatch(
      {
        method: 'PUT',
        path: '/company/r2-config',
        authorization: owner(),
        query: {},
        body: { endpoint: 'https://acct.r2.cloudflarestorage.com', bucket: 'acme-assets', access_key_id: 'AKID', secret_access_key: 'topsecret' },
      },
      env(),
    );
    expect(put.status).toBe(200);
    const get = await dispatch({ method: 'GET', path: '/company/r2-config', authorization: owner(), query: {}, body: {} }, env());
    expect((get.body as { configured: boolean; bucket: string }).configured).toBe(true);
    expect((get.body as { bucket: string }).bucket).toBe('acme-assets');
    expect(JSON.stringify(get.body)).not.toContain('topsecret'); // secret never returned
    // Encrypted at rest.
    const stored = await pool.query<{ secret_access_key: string }>('SELECT secret_access_key FROM company_r2_config WHERE company_id = $1', [CO]);
    expect(stored.rows[0]!.secret_access_key).not.toBe('topsecret');
    expect(isEncryptedSecret(stored.rows[0]!.secret_access_key)).toBe(true);

    // Upload → PUTs to the company bucket; the resolver decrypted the secret.
    const up = await dispatch(
      { method: 'POST', path: '/assets', authorization: owner(), query: {}, body: { filename: 'a.png', mime: 'image/png', data_base64: PNG_B64, folder: 'logos' } },
      env(),
    );
    expect(up.status).toBe(201);
    const id = (up.body as { id: string }).id;
    expect(lastConfig?.secretAccessKey).toBe('topsecret'); // decrypted for use
    expect(lastConfig?.bucket).toBe('acme-assets');
    expect(bucket.puts).toEqual([`assets/${WS}/${id}`]);

    // Row records r2 + key, no base64.
    const row = await pool.query<{ storage: string; r2_key: string; data: string | null }>('SELECT storage, r2_key, data FROM assets WHERE id = $1', [id]);
    expect(row.rows[0]!.storage).toBe('r2');
    expect(row.rows[0]!.r2_key).toBe(`assets/${WS}/${id}`);
    expect(row.rows[0]!.data).toBeNull();

    // GET /assets/:id STREAMS the bytes on the SAME domain (200, not a redirect).
    const app = createApp({ pool, deps: env().deps });
    const res = await app.request(`/assets/${id}`, { redirect: 'manual' });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(new Uint8Array(await res.arrayBuffer()).length).toBe(Buffer.from(PNG_B64, 'base64').length);

    // DELETE removes the object + row.
    const del = await dispatch({ method: 'DELETE', path: `/assets/${id}`, authorization: owner(), query: {}, body: {} }, env());
    expect(del.status).toBe(200);
    expect(bucket.dels).toEqual([`assets/${WS}/${id}`]);
    expect((await pool.query('SELECT 1 FROM assets WHERE id = $1', [id])).rowCount).toBe(0);
  });

  it('backfill moves existing base64 (db) assets into the bucket', async () => {
    // R2 is configured (from the first test). Seed a legacy db asset directly.
    const legacy = await pool.query<{ id: string }>(
      "INSERT INTO assets (workspace_id, filename, mime, data, storage) VALUES ($1,'old.png','image/png',$2,'db') RETURNING id",
      [WS, PNG_B64],
    );
    const id = legacy.rows[0]!.id;
    const r = await dispatch({ method: 'POST', path: '/assets/backfill-r2', authorization: owner(), query: {}, body: {} }, env());
    expect(r.status).toBe(200);
    expect((r.body as { migrated: number }).migrated).toBeGreaterThanOrEqual(1);
    // The legacy asset is now r2-backed (key in the bucket, no base64).
    const row = await pool.query<{ storage: string; r2_key: string; data: string | null }>('SELECT storage, r2_key, data FROM assets WHERE id = $1', [id]);
    expect(row.rows[0]!.storage).toBe('r2');
    expect(row.rows[0]!.data).toBeNull();
    expect(bucket.objects.has(`assets/${WS}/${id}`)).toBe(true);
    await pool.query('DELETE FROM assets WHERE id = $1', [id]);
  });

  it('no R2 config → falls back to base64-in-Postgres, served inline', async () => {
    await pool.query('DELETE FROM company_r2_config WHERE company_id = $1', [CO]);
    const up = await dispatch(
      { method: 'POST', path: '/assets', authorization: owner(), query: {}, body: { filename: 'b.png', mime: 'image/png', data_base64: PNG_B64 } },
      env(),
    );
    expect(up.status).toBe(201);
    const id = (up.body as { id: string }).id;
    const row = await pool.query<{ storage: string; data: string | null }>('SELECT storage, data FROM assets WHERE id = $1', [id]);
    expect(row.rows[0]!.storage).toBe('db');
    expect(row.rows[0]!.data).toBe(PNG_B64);

    const app = createApp({ pool, deps: env().deps });
    const res = await app.request(`/assets/${id}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
  });
});
