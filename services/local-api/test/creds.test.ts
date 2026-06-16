// Local password hashing for registration (§12 dev shim): scrypt envelope,
// constant-time verify, never plaintext.
import { describe, it, expect } from 'vitest';
import { hashPassword, verifyPassword } from '../src/creds.js';

describe('password hashing', () => {
  it('hashes to a scrypt envelope (no plaintext) and verifies the right password', () => {
    const stored = hashPassword('correct horse battery');
    expect(stored.startsWith('scrypt$')).toBe(true);
    expect(stored).not.toContain('correct horse battery');
    expect(verifyPassword('correct horse battery', stored)).toBe(true);
  });

  it('rejects the wrong password and a salted re-hash differs', () => {
    const stored = hashPassword('s3cret-password');
    expect(verifyPassword('wrong', stored)).toBe(false);
    // Different salt → different envelope for the same password.
    expect(hashPassword('s3cret-password')).not.toBe(stored);
  });

  it('returns false for missing / malformed stored values', () => {
    expect(verifyPassword('x', null)).toBe(false);
    expect(verifyPassword('x', '')).toBe(false);
    expect(verifyPassword('x', 'not-a-scrypt-envelope')).toBe(false);
    expect(verifyPassword('x', 'scrypt$abc')).toBe(false);
  });
});
