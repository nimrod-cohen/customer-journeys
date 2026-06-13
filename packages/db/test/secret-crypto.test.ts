// Envelope encryption for secrets at rest (§10/§13): round-trips, produces a
// non-plaintext envelope, fails closed on tamper, and never repeats ciphertext.
import { describe, it, expect } from 'vitest';
import { encryptSecret, decryptSecret, isEncryptedSecret } from '../src/secret-crypto.js';

describe('secret envelope encryption', () => {
  it('round-trips a secret', () => {
    const plain = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';
    const env = encryptSecret(plain);
    expect(env).not.toContain(plain);
    expect(isEncryptedSecret(env)).toBe(true);
    expect(decryptSecret(env)).toBe(plain);
  });

  it('uses a fresh data key + IV each time (no deterministic ciphertext)', () => {
    const a = encryptSecret('same-secret');
    const b = encryptSecret('same-secret');
    expect(a).not.toBe(b);
    expect(decryptSecret(a)).toBe('same-secret');
    expect(decryptSecret(b)).toBe('same-secret');
  });

  it('fails closed when the ciphertext is tampered with', () => {
    const env = encryptSecret('top-secret');
    const obj = JSON.parse(Buffer.from(env, 'base64').toString('utf8'));
    const ctBuf = Buffer.from(obj.ct, 'base64');
    ctBuf[0] ^= 0xff; // flip a byte
    obj.ct = ctBuf.toString('base64');
    const tampered = Buffer.from(JSON.stringify(obj), 'utf8').toString('base64');
    expect(() => decryptSecret(tampered)).toThrow();
  });

  it('does not treat plaintext as an envelope', () => {
    expect(isEncryptedSecret('AKIAEXAMPLE-plaintext-secret')).toBe(false);
  });
});
