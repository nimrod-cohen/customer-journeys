// Envelope encryption for secrets at rest (§10, §13). Secrets (e.g. a company's
// SES secret access key) are NEVER stored in plaintext. Each secret is encrypted
// with a fresh random data key (DEK, AES-256-GCM); the DEK is then "wrapped"
// (encrypted) with a master key (KEK). Only the wrapped DEK + ciphertext are
// stored, so compromising the DB row alone doesn't reveal the secret.
//
// PRODUCTION: the KEK lives in AWS KMS — the wrap/unwrap step becomes a KMS
// Encrypt/Decrypt (or GenerateDataKey) call, and the master key never touches the
// app. Here (local/dev) the KEK is an env var (`CDP_MASTER_KEY`, base64 32 bytes);
// an explicit dev fallback is used if it's unset so tests run, with a loud intent
// that production must supply a real key / KMS. The stored envelope is the SAME
// shape either way, so swapping in KMS is a localized change to wrap()/unwrap().
import { randomBytes, createCipheriv, createDecipheriv, createHash } from 'node:crypto';

const ALGO = 'aes-256-gcm';
const ENVELOPE_VERSION = 1;

/** The persisted envelope (JSON in a text column). All fields are base64. */
interface Envelope {
  readonly v: number;
  readonly ek: string; // wrapped (encrypted) data key
  readonly eki: string; // iv used to wrap the data key
  readonly ekt: string; // auth tag from wrapping the data key
  readonly iv: string; // iv used to encrypt the payload
  readonly tag: string; // auth tag from encrypting the payload
  readonly ct: string; // ciphertext of the secret
}

/**
 * Resolve the 32-byte master key (KEK). Uses `CDP_MASTER_KEY` (base64) when set;
 * otherwise derives a FIXED dev key so local dev/tests work without config. The
 * dev key is obviously not secret — production MUST set `CDP_MASTER_KEY` (or wire
 * KMS). Kept as a function so the env is read at call time (tests can override).
 */
function masterKey(): Buffer {
  const env = process.env.CDP_MASTER_KEY;
  if (env) {
    const key = Buffer.from(env, 'base64');
    if (key.length !== 32) throw new Error('CDP_MASTER_KEY must be 32 bytes (base64-encoded)');
    return key;
  }
  // Dev/test fallback — deterministic, NOT secret. Real deployments set the env.
  return createHash('sha256').update('cdp-local-dev-master-key').digest();
}

/** Encrypt a plaintext secret into a self-describing envelope string (base64 JSON). */
export function encryptSecret(plaintext: string): string {
  const kek = masterKey();
  const dek = randomBytes(32);

  // Encrypt the payload with the data key.
  const iv = randomBytes(12);
  const c = createCipheriv(ALGO, dek, iv);
  const ct = Buffer.concat([c.update(plaintext, 'utf8'), c.final()]);
  const tag = c.getAuthTag();

  // Wrap the data key with the master key.
  const eki = randomBytes(12);
  const wc = createCipheriv(ALGO, kek, eki);
  const ek = Buffer.concat([wc.update(dek), wc.final()]);
  const ekt = wc.getAuthTag();

  const env: Envelope = {
    v: ENVELOPE_VERSION,
    ek: ek.toString('base64'),
    eki: eki.toString('base64'),
    ekt: ekt.toString('base64'),
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    ct: ct.toString('base64'),
  };
  return Buffer.from(JSON.stringify(env), 'utf8').toString('base64');
}

/** Decrypt an envelope produced by `encryptSecret`. Throws on tamper/wrong key. */
export function decryptSecret(envelope: string): string {
  const env = JSON.parse(Buffer.from(envelope, 'base64').toString('utf8')) as Envelope;
  if (env.v !== ENVELOPE_VERSION) throw new Error(`unsupported secret envelope version ${env.v}`);
  const kek = masterKey();

  // Unwrap the data key.
  const wd = createDecipheriv(ALGO, kek, Buffer.from(env.eki, 'base64'));
  wd.setAuthTag(Buffer.from(env.ekt, 'base64'));
  const dek = Buffer.concat([wd.update(Buffer.from(env.ek, 'base64')), wd.final()]);

  // Decrypt the payload.
  const d = createDecipheriv(ALGO, dek, Buffer.from(env.iv, 'base64'));
  d.setAuthTag(Buffer.from(env.tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(env.ct, 'base64')), d.final()]).toString('utf8');
}

/** True if a string looks like one of our envelopes (vs legacy plaintext). */
export function isEncryptedSecret(value: string): boolean {
  try {
    const env = JSON.parse(Buffer.from(value, 'base64').toString('utf8')) as Partial<Envelope>;
    return env.v === ENVELOPE_VERSION && typeof env.ct === 'string' && typeof env.ek === 'string';
  } catch {
    return false;
  }
}
