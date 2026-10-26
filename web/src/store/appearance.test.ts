import { describe, expect, it } from 'vitest';
import { parseAppearance, stepFontScale } from './appearance.js';

describe('parseAppearance', () => {
  it('keeps valid stored values', () => {
    expect(parseAppearance('dark', '125', 'light')).toEqual({ theme: 'dark', fontScale: 125 });
  });
  it('falls back for missing or unknown values', () => {
    expect(parseAppearance(null, null, 'dark')).toEqual({ theme: 'dark', fontScale: 100 });
    expect(parseAppearance('purple', '93', 'light')).toEqual({ theme: 'light', fontScale: 100 });
  });
});

describe('stepFontScale', () => {
  it('steps up and down', () => {
    expect(stepFontScale(100, 1)).toBe(112.5);
    expect(stepFontScale(100, -1)).toBe(87.5);
  });
  it('clamps at both ends', () => {
    expect(stepFontScale(137.5, 1)).toBe(137.5);
    expect(stepFontScale(87.5, -1)).toBe(87.5);
  });
  it('treats an unknown current value as the default', () => {
    expect(stepFontScale(42, 1)).toBe(112.5);
  });
});
