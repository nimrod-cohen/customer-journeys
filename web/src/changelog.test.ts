import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { CHANGELOG } from './changelog.js';
import { formatChangelogDate } from './screens/Changelog.js';

const rootVersion = (JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string }).version;

const parts = (v: string) => v.split('.').map(Number);
const cmp = (a: string, b: string) => {
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return (x[i] ?? 0) - (y[i] ?? 0);
  return 0;
};

describe('changelog', () => {
  it('has an entry for the current version, at the top', () => {
    expect(CHANGELOG[0]?.version).toBe(rootVersion);
  });
  it('is newest first, with unique versions and non-empty changes', () => {
    for (let i = 1; i < CHANGELOG.length; i++) {
      expect(cmp(CHANGELOG[i - 1]!.version, CHANGELOG[i]!.version)).toBeGreaterThan(0);
    }
    for (const e of CHANGELOG) {
      expect(e.version).toMatch(/^\d+\.\d+\.\d+$/);
      expect(e.changes.length).toBeGreaterThan(0);
      if (e.date) expect(e.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });
  it('formats dates as dd/mm/yyyy', () => {
    expect(formatChangelogDate('2026-11-18')).toBe('18/11/2026');
  });
});
