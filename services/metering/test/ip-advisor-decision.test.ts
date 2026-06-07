// §10 dedicated-IP recommendation engine — PURE decision logic (§16A). The
// advisor RECOMMENDS only; it never auto-upgrades. It recommends ONLY when ALL
// hold (all-criteria-AND gate): sustained ~100k/mo for 2–3 consecutive months,
// consistent cadence (sends most days), and healthy reputation (low
// bounce/complaint). One-off spikes are rejected.
import { describe, it, expect } from 'vitest';
import {
  DEFAULT_IP_THRESHOLDS,
  decideIpRecommendation,
  buildIpRecommendationUpdate,
  type MonthSeries,
} from '../src/advisor.js';

const healthy = (volume: number, activeDays: number): MonthSeries => ({
  period: '2026-06-01',
  emailsSent: volume,
  activeDays,
  daysInMonth: 30,
  bounces: Math.floor(volume * 0.005),
  complaints: 0,
  delivered: volume,
});

describe('decideIpRecommendation (all-criteria-AND gate)', () => {
  const T = DEFAULT_IP_THRESHOLDS;

  it('recommends when sustained volume + cadence + reputation all hold', () => {
    const series = [healthy(110_000, 26), healthy(105_000, 25), healthy(120_000, 28)];
    const d = decideIpRecommendation(series, T);
    expect(d.recommend).toBe(true);
    expect(d.reasons.length).toBeGreaterThan(0);
  });

  it('rejects a one-off spike (only the latest month is high)', () => {
    const series = [healthy(5_000, 20), healthy(3_000, 18), healthy(150_000, 28)];
    const d = decideIpRecommendation(series, T);
    expect(d.recommend).toBe(false);
    expect(d.reasons.some((r) => /sustained|volume|consecutive/i.test(r))).toBe(true);
  });

  it('rejects when cadence is a single monthly blast (few active days)', () => {
    const series = [
      { ...healthy(120_000, 1), activeDays: 1 },
      { ...healthy(120_000, 1), activeDays: 1 },
      { ...healthy(120_000, 1), activeDays: 1 },
    ];
    const d = decideIpRecommendation(series, T);
    expect(d.recommend).toBe(false);
    expect(d.reasons.some((r) => /cadence|days/i.test(r))).toBe(true);
  });

  it('rejects an unhealthy sender (high bounce/complaint) even at volume + cadence', () => {
    const bad: MonthSeries[] = [healthy(120_000, 27), healthy(120_000, 27), healthy(120_000, 27)].map(
      (m) => ({ ...m, bounces: Math.floor(m.emailsSent * 0.08), complaints: Math.floor(m.emailsSent * 0.01) }),
    );
    const d = decideIpRecommendation(bad, T);
    expect(d.recommend).toBe(false);
    expect(d.reasons.some((r) => /reputation|bounce|complaint/i.test(r))).toBe(true);
  });

  it('rejects when there are too few months of history', () => {
    const series = [healthy(120_000, 27)];
    const d = decideIpRecommendation(series, T);
    expect(d.recommend).toBe(false);
  });
});

describe('buildIpRecommendationUpdate (persists recommendation, never ip_mode)', () => {
  const ws = '33333333-3333-3333-3333-333333333333';

  it('merges ip_recommendation into sending_identity without changing ip_mode', () => {
    const stmt = buildIpRecommendationUpdate(ws, { recommend: true, reasons: ['ok'] });
    expect(stmt.values[0]).toBe(ws);
    expect(stmt.text).toMatch(/UPDATE workspaces/i);
    expect(stmt.text).toMatch(/sending_identity/);
    expect(stmt.text).toMatch(/workspace_id\s*=\s*\$1|id\s*=\s*\$1/);
    // It must NOT set ip_mode — recommending is not upgrading.
    expect(stmt.text).not.toMatch(/'dedicated'|'warming'/);
  });

  it('throws on a falsy workspaceId', () => {
    expect(() => buildIpRecommendationUpdate('', { recommend: false, reasons: [] })).toThrow();
  });
});
