import { describe, it, expect } from 'vitest';
import { chunk } from '../src/core.js';

// §9A — large audiences are enumerated in batches. `chunk` is the pure splitter.
describe('chunk', () => {
  it('splits into batches of at most batchSize, preserving order', () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });

  it('returns a single batch when smaller than batchSize', () => {
    expect(chunk([1, 2], 10)).toEqual([[1, 2]]);
  });

  it('returns [] for an empty input', () => {
    expect(chunk([], 3)).toEqual([]);
  });

  it('throws on a non-positive batchSize', () => {
    expect(() => chunk([1, 2], 0)).toThrow();
    expect(() => chunk([1, 2], -1)).toThrow();
  });
});
