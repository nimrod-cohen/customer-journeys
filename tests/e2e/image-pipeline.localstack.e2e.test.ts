// §11 / §16A tier 3 (LocalStack): the thin image upload + variant flow against a
// REAL S3 (LocalStack). We mint a presigned PUT (real getSignedUrl), upload bytes
// via that URL with fetch (browser-equivalent), then run the ACTUAL variant
// handler with real S3 get/put (real sharp) and a real Postgres usage write.
// Proves the wiring, not logic: presign → S3 PUT → variant generation → CDN keys
// → usage_counters. Cross-workspace isolation is asserted (a presigned URL for A
// cannot write a B/ key).
//
// Guarded: skips cleanly if LocalStack S3 OR Postgres is unavailable. Docker + DB
// are provisioned for this run.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  S3Client,
  CreateBucketCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import sharp from 'sharp';
import { adminPool, applyMigrations, hasDatabaseUrl } from '@cdp/db';
import {
  makePresignHandler,
  makeVariantHandler,
  type PresignHandlerDeps,
  type VariantHandlerDeps,
} from '@cdp/service-image';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

type Pool = ReturnType<typeof adminPool>;

const ENDPOINT = process.env.AWS_ENDPOINT_URL ?? 'http://localhost:4566';
const REGION = 'us-east-1';
const BUCKET = 'cdp-images-e2e';
const WS_A = '0e2e00e2-0000-4000-8000-000000000001';
const WS_B = '0e2e00e2-0000-4000-8000-000000000002';
const ALL = [WS_A, WS_B];

/** Probe LocalStack S3 health (so we skip cleanly when it's not up). */
async function localstackUp(): Promise<boolean> {
  try {
    const res = await fetch(`${ENDPOINT}/_localstack/health`);
    if (!res.ok) return false;
    const body = (await res.json()) as { services?: Record<string, string> };
    const s3 = body.services?.s3;
    return s3 === 'available' || s3 === 'running';
  } catch {
    return false;
  }
}

const ready = (await localstackUp()) && hasDatabaseUrl();
const describeMaybe = ready ? describe : describe.skip;
if (!ready) {
  // eslint-disable-next-line no-console
  console.warn('[image-pipeline.localstack] skipped: LocalStack S3 and/or DATABASE_URL unavailable');
}

function s3Client(): S3Client {
  return new S3Client({
    region: REGION,
    endpoint: ENDPOINT,
    forcePathStyle: true,
    // Keep presigned PUTs uploadable by a plain fetch (see image deps.ts note):
    // avoid the default x-amz-checksum-crc32 header fetch can't reproduce.
    requestChecksumCalculation: 'WHEN_REQUIRED',
    credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
  });
}

/** Rewrite a presigned URL host so the path-style URL resolves to LocalStack. */
function normalizeUrl(url: string): string {
  // forcePathStyle already yields http://localhost:4566/<bucket>/<key>?...
  return url;
}

describeMaybe('image pipeline e2e (LocalStack S3 + sharp + real Postgres)', () => {
  let s3: S3Client;
  let pool: Pool;

  beforeAll(async () => {
    s3 = s3Client();
    try {
      await s3.send(new CreateBucketCommand({ Bucket: BUCKET }));
    } catch {
      /* bucket may already exist */
    }
    // Clean any objects under this test's workspace prefixes so the run is
    // deterministic regardless of prior runs (S3 state is not transactional).
    for (const ws of ALL) {
      const listed = await s3.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: `${ws}/` }));
      for (const obj of listed.Contents ?? []) {
        await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: obj.Key! }));
      }
    }
    pool = adminPool();
    const { rows } = await pool.query("SELECT to_regclass('public.usage_counters') IS NOT NULL AS exists");
    if (!rows[0].exists) await applyMigrations(pool);
    await pool.query('DELETE FROM usage_counters WHERE workspace_id = ANY($1)', [ALL]);
    await pool.query('DELETE FROM workspaces WHERE id = ANY($1)', [ALL]);
    for (const ws of ALL) {
      await pool.query("INSERT INTO workspaces (id, name, status) VALUES ($1, 'IMG-E2E', 'active')", [ws]);
    }
  });

  afterAll(async () => {
    await pool.query('DELETE FROM usage_counters WHERE workspace_id = ANY($1)', [ALL]);
    await pool.query('DELETE FROM workspaces WHERE id = ANY($1)', [ALL]);
    await pool.end();
  });

  function presignDeps(): PresignHandlerDeps {
    return {
      s3,
      getSignedUrl,
      config: { bucket: BUCKET, cloudFrontBaseUrl: 'https://cdn.e2e.example', presignTtlSeconds: 900 },
    };
  }

  function variantDeps(now: Date): VariantHandlerDeps {
    return {
      s3,
      resize: (input, width) => sharp(input).resize({ width, withoutEnlargement: true }).toBuffer(),
      probe: async (input) => {
        const m = await sharp(input).metadata();
        return { width: m.width ?? 0, height: m.height ?? 0 };
      },
      runStatement: async (stmt) => {
        await pool.query(stmt.text, stmt.values);
      },
      now: () => now,
    };
  }

  it('presign → upload → variant generation → usage write, all under the A/ prefix', async () => {
    // 1. Mint a presigned PUT via the real handler (workspace from context).
    const presign = makePresignHandler(presignDeps());
    const res = await presign({
      body: JSON.stringify({ filename: 'hero.png', contentType: 'image/png' }),
      requestContext: { authorizer: { workspace_id: WS_A } },
    });
    expect(res.statusCode).toBe(200);
    const { uploadUrl, key, publicUrl } = JSON.parse(res.body) as {
      uploadUrl: string;
      key: string;
      publicUrl: string;
    };
    expect(key.startsWith(`${WS_A}/`)).toBe(true);
    expect(publicUrl).toBe(`https://cdn.e2e.example/${key}`);

    // 2. Upload a real 1600px PNG via the presigned URL (browser-equivalent PUT).
    const sourcePng = await sharp({
      create: { width: 1600, height: 900, channels: 3, background: { r: 10, g: 20, b: 30 } },
    })
      .png()
      .toBuffer();
    const put = await fetch(normalizeUrl(uploadUrl), {
      method: 'PUT',
      headers: { 'content-type': 'image/png' },
      body: sourcePng,
    });
    expect(put.ok).toBe(true);

    // 3. Run the variant handler on the S3 ObjectCreated event (real sharp + S3).
    const variant = makeVariantHandler(variantDeps(new Date('2026-06-07T10:00:00Z')));
    const outcomes = await variant({
      Records: [{ s3: { bucket: { name: BUCKET }, object: { key } } }],
    });
    expect(outcomes[0]!.workspaceId).toBe(WS_A);
    expect(outcomes[0]!.variantsWritten).toBe(3); // 1200/800/400 ≤ 1600
    expect(outcomes[0]!.bytesRecorded).toBeGreaterThan(0);

    // 4. Variants exist in S3 under the A/ prefix.
    const listed = await s3.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: `${WS_A}/` }));
    const keys = (listed.Contents ?? []).map((o) => o.Key!);
    expect(keys).toContain(key);
    for (const w of [1200, 800, 400]) {
      expect(keys.some((k) => k.includes(`-w${w}.png`))).toBe(true);
    }
    // The generated variant is a real (smaller) image.
    const got = await s3.send(
      new GetObjectCommand({ Bucket: BUCKET, Key: keys.find((k) => k.includes('-w400'))! }),
    );
    const variantBytes = Buffer.from(await got.Body!.transformToByteArray());
    const meta = await sharp(variantBytes).metadata();
    expect(meta.width).toBe(400);

    // 5. usage_counters recorded the bytes for A (real Postgres).
    const uc = await pool.query(
      "SELECT value FROM usage_counters WHERE workspace_id = $1 AND metric = 'image_storage_bytes'",
      [WS_A],
    );
    expect(Number(uc.rows[0].value)).toBe(outcomes[0]!.bytesRecorded);
  });

  it('isolation: the presign handler can never mint a key outside the caller workspace prefix', async () => {
    // The workspace is taken from the authorizer context, never the body, and the
    // filename is sanitized — so a malicious filename that tries to traverse into
    // another workspace's prefix is neutralized: the minted key stays under A/.
    const presign = makePresignHandler(presignDeps());
    const res = await presign({
      body: JSON.stringify({ filename: `../${WS_B}/pwned.png`, contentType: 'image/png' }),
      requestContext: { authorizer: { workspace_id: WS_A } },
    });
    expect(res.statusCode).toBe(200);
    const { uploadUrl, key } = JSON.parse(res.body) as { uploadUrl: string; key: string };
    expect(key.startsWith(`${WS_A}/`)).toBe(true);
    expect(key.includes(`${WS_B}/`)).toBe(false); // traversal neutralized

    // Uploading via the (sanitized) URL lands under A/, never B/.
    await fetch(uploadUrl, { method: 'PUT', headers: { 'content-type': 'image/png' }, body: Buffer.from('x') });
    const listedB = await s3.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: `${WS_B}/` }));
    expect((listedB.Contents ?? []).length).toBe(0); // nothing under B/

    // NOTE: real S3 additionally rejects a path-tampered presigned URL with 403
    // SignatureDoesNotMatch (the signature is bound to the exact key). LocalStack
    // does not strictly validate presigned signatures, so that AWS-enforced layer
    // is not asserted here; the application-layer guarantee above (workspace from
    // context + key sanitization, never client-chosen) is what our code owns.
  });
});
