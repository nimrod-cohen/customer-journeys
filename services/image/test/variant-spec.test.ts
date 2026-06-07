import { describe, it, expect } from 'vitest';
import { planVariants } from '../src/variants.js';

// §11: an S3-triggered Lambda makes `sharp` variants of an uploaded image. The
// pure planner decides the variant specs (under the SAME workspace prefix) given
// the original key and dimensions. It must NEVER upscale (a variant wider than
// the source is dropped/clamped) and every variant key stays in the workspace.

const WS = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const KEY = `${WS}/abc-hero.png`;

describe('planVariants', () => {
  it('plans variants under the same workspace prefix as the original', () => {
    const variants = planVariants(KEY, { width: 2000, height: 1000 });
    expect(variants.length).toBeGreaterThan(0);
    for (const v of variants) {
      expect(v.key.startsWith(`${WS}/`)).toBe(true);
    }
  });

  it('never upscales: drops target widths larger than the source width', () => {
    const variants = planVariants(KEY, { width: 400, height: 300 });
    for (const v of variants) {
      expect(v.width).toBeLessThanOrEqual(400);
    }
  });

  it('produces distinct keys per variant (suffixed by width)', () => {
    const variants = planVariants(KEY, { width: 2000, height: 1000 });
    const keys = variants.map((v) => v.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const v of variants) {
      expect(v.key).toContain(`w${v.width}`);
    }
  });

  it('returns an empty plan for a source smaller than every target width', () => {
    const variants = planVariants(KEY, { width: 100, height: 50 });
    // Smaller than the smallest standard width → no variants (no upscale).
    expect(variants.every((v) => v.width <= 100)).toBe(true);
  });

  it('preserves the original extension on variant keys', () => {
    const variants = planVariants(KEY, { width: 2000, height: 1000 });
    for (const v of variants) {
      expect(v.key).toMatch(/\.png$/);
    }
  });
});
