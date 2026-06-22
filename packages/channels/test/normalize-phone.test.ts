import { describe, it, expect } from 'vitest';
import { normalizePhone } from '../src/index.js';

describe('normalizePhone (libphonenumber-js → E.164 or null)', () => {
  it('IL national 0529461566 + default IL → +972529461566', () => {
    expect(normalizePhone('0529461566', 'IL')).toBe('+972529461566');
  });

  it('an already-E.164 +972529461566 is kept as-is (no default needed)', () => {
    expect(normalizePhone('+972529461566')).toBe('+972529461566');
    expect(normalizePhone('+972529461566', 'IL')).toBe('+972529461566');
    expect(normalizePhone('+972529461566', 'US')).toBe('+972529461566');
  });

  it('a national number WITHOUT a default country → null (cannot infer)', () => {
    expect(normalizePhone('0529461566')).toBeNull();
    expect(normalizePhone('0529461566', undefined)).toBeNull();
  });

  it('formatting noise in a national number is tolerated (spaces, dashes, parens)', () => {
    expect(normalizePhone('052-946-1566', 'IL')).toBe('+972529461566');
    expect(normalizePhone(' (052) 946 1566 ', 'IL')).toBe('+972529461566');
  });

  it('a US national number with the US default → +1…', () => {
    expect(normalizePhone('(212) 234-5678', 'US')).toBe('+12122345678');
  });

  it('junk / clearly-invalid input → null', () => {
    expect(normalizePhone('not a phone', 'IL')).toBeNull();
    expect(normalizePhone('123', 'IL')).toBeNull();
    expect(normalizePhone('', 'IL')).toBeNull();
    expect(normalizePhone('   ', 'IL')).toBeNull();
  });

  it('a null/undefined raw → null', () => {
    expect(normalizePhone(null as unknown as string, 'IL')).toBeNull();
    expect(normalizePhone(undefined as unknown as string)).toBeNull();
  });

  it('an unrecognized default country code does not throw → null for a national number', () => {
    expect(normalizePhone('0529461566', 'ZZ')).toBeNull();
  });
});
