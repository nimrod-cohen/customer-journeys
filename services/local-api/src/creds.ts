// Local password hashing for self-service registration (§12 dev shim). Uses
// node:crypto scrypt — no external dep, no plaintext storage. Stored form:
//   scrypt$<saltHex>$<hashHex>
// Production identity is Supabase Auth; this only backs the local dev/e2e
// credential store added in migration 0031.
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

const KEYLEN = 32;

/** Hash a password into a storable "scrypt$salt$hash" envelope. */
export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, KEYLEN);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

/** Verify a password against a stored envelope. Constant-time; false on any mismatch. */
export function verifyPassword(password: string, stored: string | null | undefined): boolean {
  if (!stored) return false;
  const parts = stored.split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const salt = Buffer.from(parts[1]!, 'hex');
  const expected = Buffer.from(parts[2]!, 'hex');
  if (expected.length !== KEYLEN) return false;
  const actual = scryptSync(password, salt, KEYLEN);
  return timingSafeEqual(actual, expected);
}
