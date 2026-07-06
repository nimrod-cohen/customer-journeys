import { describe, it, expect } from 'vitest';
import { sourceWarning } from './channelConfigLogic.js';

describe('sourceWarning — 019 sender ID validation', () => {
  it('accepts a valid alphanumeric sender (<= 11 letters/digits)', () => {
    expect(sourceWarning('YinonArieli')).toBeNull(); // exactly 11
    expect(sourceWarning('Bursa4u')).toBeNull();
    expect(sourceWarning('')).toBeNull(); // empty → no warning (handled by the save gate)
    expect(sourceWarning('  Yinon  ')).toBeNull(); // trims
  });

  it('warns when an alphanumeric sender exceeds 11 chars (error 992)', () => {
    expect(sourceWarning('Yinon Arieli')).toMatch(/11 characters/); // 12 (length checked first)
    expect(sourceWarning('ThisNameIsTooLong')).toMatch(/11 characters/);
  });

  it('warns on spaces/symbols in a short alphanumeric sender', () => {
    expect(sourceWarning('My Brand')).toMatch(/letters and digits/); // 8 chars, has a space
    expect(sourceWarning('Brand!')).toMatch(/letters and digits/);
  });

  it('does NOT warn for a numeric (phone-number) sender, even if long', () => {
    expect(sourceWarning('972529461566')).toBeNull();
    expect(sourceWarning('+972529461566')).toBeNull();
  });
});
