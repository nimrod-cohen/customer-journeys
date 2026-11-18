import { describe, it, expect } from 'vitest';
import { parseLineHeight } from './decimal.js';

describe('parseLineHeight', () => {
  it('accepts a decimal with a dot or a comma', () => {
    expect(parseLineHeight('1.4')).toBe(1.4);
    expect(parseLineHeight('1,4')).toBe(1.4);
    expect(parseLineHeight(' 2 ')).toBe(2);
  });
  it('blank or junk → undefined (back to the default)', () => {
    expect(parseLineHeight('')).toBeUndefined();
    expect(parseLineHeight('abc')).toBeUndefined();
  });
  it('clamps to 1–3', () => {
    expect(parseLineHeight('0.5')).toBe(1);
    expect(parseLineHeight('9')).toBe(3);
  });
});
