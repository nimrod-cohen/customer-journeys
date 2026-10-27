import { describe, expect, it } from 'vitest';
import { clampTextSize, parseAppearance, rootFontSize } from './appearance.js';

describe('parseAppearance', () => {
  it('keeps valid stored values', () => {
    expect(parseAppearance('dark', '120', 'light')).toEqual({ theme: 'dark', textSize: 120 });
  });
  it('falls back for missing or unknown values', () => {
    expect(parseAppearance(null, null, 'dark')).toEqual({ theme: 'dark', textSize: 100 });
    expect(parseAppearance('purple', 'abc', 'light')).toEqual({ theme: 'light', textSize: 100 });
  });
});

describe('clampTextSize', () => {
  it('snaps to the 5% grid', () => {
    expect(clampTextSize(103)).toBe(105);
    expect(clampTextSize(112)).toBe(110);
  });
  it('clamps to the slider range', () => {
    expect(clampTextSize(10)).toBe(80);
    expect(clampTextSize(500)).toBe(140);
  });
});

describe('rootFontSize', () => {
  it('makes the default 25% larger than the browser default', () => {
    expect(rootFontSize(100)).toBe('125%');
  });
  it('scales from that base', () => {
    expect(rootFontSize(80)).toBe('100%');
    expect(rootFontSize(140)).toBe('175%');
  });
});
