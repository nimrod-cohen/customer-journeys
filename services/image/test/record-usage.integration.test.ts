import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminPool, applyMigrations, hasDatabaseUrl } from '@cdp/db';
import { processUpload, type VariantHandlerDeps } from '../src/variant-handler.js';
import { buildImageBytesUpsert, monthBucket } from '../src/usage.js';

// §11 / §20 / §16A tier 2: record image bytes into usage_counters against a REAL
// local Postgres (never mock the DB). The variant handler runs as the SERVICE
// ROLE (bypasses RLS) — isolation is in-code: the workspace is derived from the
// key prefix and bound at $1. We drive the ACTUAL processUpload with S3 + sharp
// faked at the boundary, and assert the real additive usage write + cross-
// workspace isolation. Gated on DATABASE_URL; skips cleanly without it.

type Pool = ReturnType<typeof adminPool>;

const WS_A = '0e2e0011-0000-4000-8000-000000000001';
const WS_B = '0e2e0011-0000-4000-8000-000000000002';
const ALL = [WS_A, WS_B];

const describeMaybe = hasDatabaseUrl() ? describe : describe.skip;

/** Fake S3 that serves a fixed original for GET and swallows PUTs. */
function fakeS3(): { send: (cmd: unknown) => Promise<unknown>; puts: string[] } {
  const puts: string[] = [];
  return {
    puts,
    async send(cmd: unknown) {
      const name = (cmd as { constructor: { name: string } }).constructor.name;
      if (name === 'GetObjectCommand') {
        return { Body: Buffer.from('fake-source-bytes') };
      }
      if (name === 'PutObjectCommand') {
        puts.push((cmd as { input: { Key: string } }).input.Key);
        return {};
      }
      return {};
    },
  };
}

function deps(pool: Pool, s3: ReturnType<typeof fakeS3>, now: Date): VariantHandlerDeps {
  return {
    s3: s3 as never,
    // Deterministic "resize": output bytes proportional to width (no real sharp).
    resize: async (_input: Buffer, width: number) => Buffer.alloc(width),
    probe: async () => ({ width: 2000, height: 1000 }),
    runStatement: async (stmt) => {
      await pool.query(stmt.text, stmt.values);
    },
    now: () => now,
  };
}

async function bytesFor(pool: Pool, ws: string): Promise<number> {
  const { rows } = await pool.query(
    "SELECT value FROM usage_counters WHERE workspace_id = $1 AND metric = 'image_storage_bytes'",
    [ws],
  );
  return rows.length ? Number(rows[0].value) : 0;
}

async function cleanup(pool: Pool): Promise<void> {
  await pool.query('DELETE FROM usage_counters WHERE workspace_id = ANY($1)', [ALL]);
  await pool.query('DELETE FROM workspaces WHERE id = ANY($1)', [ALL]);
}

describeMaybe('image variant usage metering (real Postgres)', () => {
  let pool: Pool;
  const NOW = new Date('2026-06-07T10:00:00Z');

  beforeAll(async () => {
    pool = adminPool();
    const { rows } = await pool.query("SELECT to_regclass('public.usage_counters') IS NOT NULL AS exists");
    if (!rows[0].exists) await applyMigrations(pool);
    await cleanup(pool);
    for (const ws of ALL) {
      await pool.query("INSERT INTO workspaces (id, name, status) VALUES ($1, 'IMG', 'active')", [ws]);
    }
  });

  afterAll(async () => {
    await cleanup(pool);
    await pool.end();
  });

  it('records processed bytes for the key\'s workspace, additively', async () => {
    const s3 = fakeS3();
    const out1 = await processUpload(deps(pool, s3, NOW), 'cdp-images', `${WS_A}/abc-hero.png`);
    expect(out1.workspaceId).toBe(WS_A);
    expect(out1.variantsWritten).toBe(3); // 1200/800/400 for a 2000px source
    expect(out1.bytesRecorded).toBe(1200 + 800 + 400);
    expect(s3.puts.every((k) => k.startsWith(`${WS_A}/`))).toBe(true);

    const after1 = await bytesFor(pool, WS_A);
    expect(after1).toBe(2400);

    // A second upload ADDS to the existing month bucket (additive upsert).
    const out2 = await processUpload(deps(pool, fakeS3(), NOW), 'cdp-images', `${WS_A}/def-banner.png`);
    expect(out2.bytesRecorded).toBe(2400);
    expect(await bytesFor(pool, WS_A)).toBe(4800);
  });

  it('writes to the correct month bucket', async () => {
    const { rows } = await pool.query(
      "SELECT period::text FROM usage_counters WHERE workspace_id = $1 AND metric = 'image_storage_bytes'",
      [WS_A],
    );
    expect(rows[0].period).toBe(monthBucket(NOW));
  });

  it('isolates workspaces: a B upload never touches A\'s counter', async () => {
    const before = await bytesFor(pool, WS_A);
    await processUpload(deps(pool, fakeS3(), NOW), 'cdp-images', `${WS_B}/b-logo.png`);
    expect(await bytesFor(pool, WS_B)).toBe(2400);
    expect(await bytesFor(pool, WS_A)).toBe(before); // unchanged
  });

  it('buildImageBytesUpsert executes against the real schema', async () => {
    const stmt = buildImageBytesUpsert(WS_A, monthBucket(NOW), 100);
    await expect(pool.query(stmt.text, stmt.values)).resolves.toBeDefined();
  });
});
