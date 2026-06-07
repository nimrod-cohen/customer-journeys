// §10 dedicated-IP upgrade — PURE state transition + warmup + send-pool routing
// (§16A). planUpgradeIp moves ip_mode 'shared'→'warming' (then 'dedicated' once
// warm) and sets warmup_status, merging into sending_identity (workspace_id $1,
// sending_identity || $2::jsonb). warmupSplit ramps monotonically over 2–4 weeks
// to 1.0. chooseSendPool routes deterministically by profile_id hash so retries
// route consistently.
import { describe, it, expect } from 'vitest';
import {
  planUpgradeIp,
  warmupSplit,
  chooseSendPool,
  type WarmupStatus,
} from '../src/ip-upgrade.js';

describe('planUpgradeIp (shared → warming)', () => {
  const ws = '44444444-4444-4444-4444-444444444444';

  it('sets ip_mode to warming + a warmup_status, merged into sending_identity', () => {
    const start = new Date('2026-06-01T00:00:00.000Z');
    const stmt = planUpgradeIp(ws, 'cdp-pool-ws44', start);
    expect(stmt.values[0]).toBe(ws);
    // jsonb merge against $2.
    expect(stmt.text).toMatch(/sending_identity\s*\|\|\s*\$2::jsonb/);
    expect(stmt.text).toMatch(/id\s*=\s*\$1/);
    const merged = JSON.parse(stmt.values[1] as string) as Record<string, unknown>;
    expect(merged.ip_mode).toBe('warming');
    expect(merged.ip_pool).toBe('cdp-pool-ws44');
    expect(merged.warmup_status).toBeTruthy();
  });

  it('throws on a falsy workspaceId', () => {
    expect(() => planUpgradeIp('', 'p', new Date())).toThrow();
  });
});

describe('warmupSplit (monotonic ramp to 1.0)', () => {
  const start = '2026-06-01T00:00:00.000Z';
  const status: WarmupStatus = { startedAt: start, durationDays: 21 };

  it('starts at a small but positive share', () => {
    const s = warmupSplit(status, new Date('2026-06-01T00:00:00.000Z'));
    expect(s).toBeGreaterThan(0);
    expect(s).toBeLessThan(1);
  });

  it('is monotonically non-decreasing as time passes', () => {
    let prev = 0;
    for (let day = 0; day <= 21; day++) {
      const now = new Date(Date.parse(start) + day * 86_400_000);
      const s = warmupSplit(status, now);
      expect(s).toBeGreaterThanOrEqual(prev);
      prev = s;
    }
  });

  it('reaches exactly 1.0 once the warm-up window completes', () => {
    const done = new Date(Date.parse(start) + 21 * 86_400_000);
    expect(warmupSplit(status, done)).toBe(1);
    const later = new Date(Date.parse(start) + 60 * 86_400_000);
    expect(warmupSplit(status, later)).toBe(1);
  });

  it('clamps a before-start time to the initial share (never negative)', () => {
    const before = new Date(Date.parse(start) - 86_400_000);
    const s = warmupSplit(status, before);
    expect(s).toBeGreaterThan(0);
    expect(s).toBeLessThanOrEqual(1);
  });
});

describe('chooseSendPool (deterministic by profile_id)', () => {
  it('routes the same profile to the same pool across calls (retry-safe)', () => {
    const a = chooseSendPool(0.5, 'profile-abc');
    const b = chooseSendPool(0.5, 'profile-abc');
    expect(a).toBe(b);
  });

  it('routes everyone to dedicated at share 1.0 and nobody at 0.0', () => {
    for (const p of ['p1', 'p2', 'p3', 'p4', 'p5']) {
      expect(chooseSendPool(1, p)).toBe('dedicated');
      expect(chooseSendPool(0, p)).toBe('shared');
    }
  });

  it('splits the population roughly by the dedicated share', () => {
    const N = 2000;
    let dedicated = 0;
    for (let i = 0; i < N; i++) {
      if (chooseSendPool(0.3, `profile-${i}`) === 'dedicated') dedicated++;
    }
    const frac = dedicated / N;
    expect(frac).toBeGreaterThan(0.2);
    expect(frac).toBeLessThan(0.4);
  });
});
