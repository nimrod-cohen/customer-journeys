// S3-triggered variant handler (§11) — thin. On an upload to `${ws}/...`:
//   1. re-derive the workspace from the key prefix and ASSERT scope
//      (assertKeyInWorkspace) — the service role bypasses RLS, so this in-code
//      check is the isolation guard;
//   2. fetch the original bytes, probe dimensions, plan variants (no upscale),
//      resize each with sharp, put them back under the SAME prefix;
//   3. record total processed bytes into usage_counters (additive, $1-scoped).
// All decisions live in pure cores (./key, ./variants, ./usage); this only wires
// I/O and S3-event parsing.
import { GetObjectCommand, PutObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import { assertKeyInWorkspace, parseWorkspaceFromKey } from './key.js';
import { planVariants, type SourceDimensions } from './variants.js';
import { buildImageBytesUpsert, monthBucket, type SqlStatement } from './usage.js';

/** Injected deps for the variant handler (sharp + S3 + DB, all replaceable). */
export interface VariantHandlerDeps {
  readonly s3: S3Client;
  /** Resize `input` to `width` px wide (never enlarging). Returns the bytes. */
  readonly resize: (input: Buffer, width: number) => Promise<Buffer>;
  /** Read the source image's pixel dimensions. */
  readonly probe: (input: Buffer) => Promise<SourceDimensions>;
  /** Execute one workspace-scoped statement (workspace_id bound at $1). */
  readonly runStatement: (stmt: SqlStatement) => Promise<void>;
  readonly now: () => Date;
}

/** Minimal S3 event shape (the records we read). */
export interface S3Event {
  readonly Records: ReadonlyArray<{
    readonly s3: { readonly bucket: { readonly name: string }; readonly object: { readonly key: string } };
  }>;
}

/** Per-key processing outcome (for the handler's summary + tests). */
export interface VariantOutcome {
  readonly key: string;
  readonly workspaceId: string;
  readonly variantsWritten: number;
  readonly bytesRecorded: number;
}

/** Collect a readable/stream/Uint8Array body from S3 into a Buffer. */
async function bodyToBuffer(body: unknown): Promise<Buffer> {
  if (body == null) return Buffer.alloc(0);
  if (Buffer.isBuffer(body)) return body;
  if (body instanceof Uint8Array) return Buffer.from(body);
  // Async iterable (Node stream) — concatenate chunks.
  const chunks: Buffer[] = [];
  for await (const chunk of body as AsyncIterable<Uint8Array>) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

/**
 * Process a SINGLE uploaded key end to end. Skips keys that are already variants
 * (contain `-w<digits>` before the extension) so re-uploads of generated outputs
 * don't recurse. Returns the outcome.
 */
export async function processUpload(
  deps: VariantHandlerDeps,
  bucket: string,
  key: string,
): Promise<VariantOutcome> {
  const workspaceId = parseWorkspaceFromKey(key);
  // Isolation guard (service role bypasses RLS): the key MUST be in its own
  // workspace prefix — re-assert with the derived workspace (defensive identity).
  assertKeyInWorkspace(workspaceId, key);

  // Skip already-generated variants to avoid recursion.
  if (/-w\d+(\.[a-z0-9]+)?$/i.test(key)) {
    return { key, workspaceId, variantsWritten: 0, bytesRecorded: 0 };
  }

  const original = await deps.s3.send(
    new GetObjectCommand({ Bucket: bucket, Key: key }),
  );
  const sourceBytes = await bodyToBuffer((original as { Body?: unknown }).Body);
  const dims = await deps.probe(sourceBytes);

  const specs = planVariants(key, dims);
  let bytesRecorded = 0;
  for (const spec of specs) {
    // Defense-in-depth: every variant key must remain in this workspace.
    assertKeyInWorkspace(workspaceId, spec.key);
    const out = await deps.resize(sourceBytes, spec.width);
    await deps.s3.send(
      new PutObjectCommand({ Bucket: bucket, Key: spec.key, Body: out }),
    );
    bytesRecorded += out.length;
  }

  if (bytesRecorded > 0) {
    const stmt = buildImageBytesUpsert(workspaceId, monthBucket(deps.now()), bytesRecorded);
    await deps.runStatement(stmt);
  }

  return { key, workspaceId, variantsWritten: specs.length, bytesRecorded };
}

/** Build the S3-triggered variant handler from injected deps. */
export function makeVariantHandler(deps: VariantHandlerDeps) {
  return async function handler(event: S3Event): Promise<VariantOutcome[]> {
    const outcomes: VariantOutcome[] = [];
    for (const record of event.Records) {
      const bucket = record.s3.bucket.name;
      const key = decodeURIComponent(record.s3.object.key.replace(/\+/g, ' '));
      outcomes.push(await processUpload(deps, bucket, key));
    }
    return outcomes;
  };
}
