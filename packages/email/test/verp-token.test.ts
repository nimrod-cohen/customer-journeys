import { describe, it, expect } from 'vitest';
import {
  packVerpToken,
  unpackVerpToken,
  verpReturnPath,
  parseVerpRecipient,
} from '../src/verp.js';

const SECRET = 'test-verp-secret';
const MSG = '3f1b9c2a-1111-4222-8333-444455556666';

describe('VERP bounce token', () => {
  it('round-trips a message id', () => {
    expect(unpackVerpToken(SECRET, packVerpToken(SECRET, MSG))).toBe(MSG);
  });

  it('is deterministic, so a resend reuses the same return path', () => {
    expect(packVerpToken(SECRET, MSG)).toBe(packVerpToken(SECRET, MSG));
  });

  it('stays inside the RFC 5321 64-octet local part limit', () => {
    const addr = verpReturnPath('bounce.journeys.on-grow.com', SECRET, MSG);
    const local = addr.slice(0, addr.lastIndexOf('@'));
    expect(local.length).toBeLessThanOrEqual(64);
    expect(addr.startsWith('bounce+')).toBe(true);
  });

  // The security property: without the secret you cannot mint a bounce address
  // for someone else's message, so you cannot forge a bounce to suppress them.
  it('rejects a token signed with a different secret', () => {
    expect(unpackVerpToken(SECRET, packVerpToken('other-secret', MSG))).toBeNull();
  });

  it('rejects a tampered token', () => {
    const t = packVerpToken(SECRET, MSG);
    const flipped = t.slice(0, -2) + (t.endsWith('AA') ? 'BB' : 'AA');
    expect(unpackVerpToken(SECRET, flipped)).toBeNull();
  });

  it('never throws on garbage input', () => {
    for (const bad of ['', '!!!!', 'a', 'x'.repeat(500), null, undefined]) {
      expect(() => unpackVerpToken(SECRET, bad as string)).not.toThrow();
      expect(unpackVerpToken(SECRET, bad as string)).toBeNull();
    }
  });

  it('rejects a truncated token', () => {
    expect(unpackVerpToken(SECRET, packVerpToken(SECRET, MSG).slice(0, 10))).toBeNull();
  });

  it('does not leak the raw message id into the address', () => {
    const addr = verpReturnPath('bounce.example.com', SECRET, MSG);
    expect(addr).not.toContain(MSG);
    expect(addr).not.toContain(MSG.replace(/-/g, ''));
  });

  it('requires a uuid message id', () => {
    expect(() => packVerpToken(SECRET, 'not-a-uuid')).toThrow();
  });
});

describe('parseVerpRecipient', () => {
  it('extracts the token from a delivered bounce recipient', () => {
    const token = packVerpToken(SECRET, MSG);
    expect(parseVerpRecipient(`bounce+${token}@bounce.example.com`)).toBe(token);
    expect(parseVerpRecipient(`<bounce+${token}@bounce.example.com>`)).toBe(token);
    expect(parseVerpRecipient(`BOUNCE+${token}@bounce.example.com`)).toBe(token);
  });

  it('ignores addresses that are not ours', () => {
    for (const addr of [
      'someone@example.com',
      'bounce@bounce.example.com',
      'notbounce+abc@example.com',
      '+abc@example.com',
      '',
      null,
    ]) {
      expect(parseVerpRecipient(addr as string)).toBeNull();
    }
  });

  it('recovers the message id end to end from an address', () => {
    const addr = verpReturnPath('bounce.example.com', SECRET, MSG);
    expect(unpackVerpToken(SECRET, parseVerpRecipient(addr))).toBe(MSG);
  });
});

describe('key separation from the subscription token', () => {
  // Both tokens are signed with UNSUBSCRIBE_LINK_SECRET. Binding each MAC to its
  // own label means a signature minted for one purpose can never validate for the
  // other, independently of how their payloads happen to be shaped.
  it('does not accept a subscription token as a bounce token', async () => {
    const { packSubscriptionToken } = await import('../src/unsubscribe.js');
    const sub = packSubscriptionToken(SECRET, MSG, 'person@example.com');
    expect(unpackVerpToken(SECRET, sub)).toBeNull();
  });

  it('does not accept a bounce token as a subscription token', async () => {
    const { unpackSubscriptionToken } = await import('../src/unsubscribe.js');
    expect(unpackSubscriptionToken(SECRET, packVerpToken(SECRET, MSG))).toBeNull();
  });
});
