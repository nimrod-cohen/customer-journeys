// §20 cost attribution — the highest-value pure unit target (§16A).
// Direct/variable costs attributed to the workspace (emails × $0.0001 + $24.95
// dedicated IP if upgraded + image bytes); fixed costs split EVENLY across
// active workspaces with PENNY-ACCURATE remainder distribution. The
// non-negotiable invariant: per-workspace figures sum to direct_total +
// fixed_total EXACTLY (no rounding drift), and the $24.95 IP cost lands ONLY on
// upgraded workspaces. Matches the §20 worked example.
import { describe, it, expect } from 'vitest';
import {
  DEFAULT_PRICES,
  computeDirectCost,
  evenShare,
  computeAllWorkspaceCosts,
  type WorkspaceUsage,
} from '../src/cost.js';

const cents = (n: number) => Math.round(n * 100);

describe('computeDirectCost (pure)', () => {
  it('charges emails at $0.0001 each', () => {
    const c = computeDirectCost(
      { emails_sent: 10_000, ipUpgraded: false, imageStorageBytes: 0, imageEgressBytes: 0 },
      DEFAULT_PRICES,
    );
    expect(c).toBeCloseTo(1, 10); // 10k × $0.0001 = $1
  });

  it('adds the $24.95 dedicated-IP cost ONLY when upgraded', () => {
    const shared = computeDirectCost(
      { emails_sent: 0, ipUpgraded: false, imageStorageBytes: 0, imageEgressBytes: 0 },
      DEFAULT_PRICES,
    );
    const upgraded = computeDirectCost(
      { emails_sent: 0, ipUpgraded: true, imageStorageBytes: 0, imageEgressBytes: 0 },
      DEFAULT_PRICES,
    );
    expect(shared).toBe(0);
    expect(upgraded).toBeCloseTo(24.95, 10);
  });

  it('includes image storage + egress bytes', () => {
    const c = computeDirectCost(
      {
        emails_sent: 0,
        ipUpgraded: false,
        imageStorageBytes: 1_000_000_000, // 1 GB
        imageEgressBytes: 2_000_000_000, // 2 GB
      },
      DEFAULT_PRICES,
    );
    const expected =
      1_000_000_000 * DEFAULT_PRICES.imageStoragePerByte +
      2_000_000_000 * DEFAULT_PRICES.imageEgressPerByte;
    expect(c).toBeCloseTo(expected, 10);
  });

  it('matches the §20 large-workspace direct figure (300k upgraded ≈ $30 + $24.95)', () => {
    const c = computeDirectCost(
      { emails_sent: 300_000, ipUpgraded: true, imageStorageBytes: 0, imageEgressBytes: 0 },
      DEFAULT_PRICES,
    );
    expect(c).toBeCloseTo(30 + 24.95, 10); // $30 emails + $24.95 IP
  });
});

describe('evenShare (penny-accurate remainder)', () => {
  it('splits $40 across 5 workspaces as $8 each', () => {
    const shares = evenShare(40, 5);
    expect(shares).toEqual([8, 8, 8, 8, 8]);
  });

  it('distributes a non-divisible remainder penny-by-penny, summing exactly', () => {
    // $10.00 / 3 = $3.333... → 3.34, 3.33, 3.33 (sum 10.00 exactly)
    const shares = evenShare(10, 3);
    expect(shares.map(cents).reduce((a, b) => a + b, 0)).toBe(1000);
    // every share within one cent of each other
    const c = shares.map(cents);
    expect(Math.max(...c) - Math.min(...c)).toBeLessThanOrEqual(1);
  });

  it('returns no shares for zero active workspaces', () => {
    expect(evenShare(40, 0)).toEqual([]);
  });
});

describe('computeAllWorkspaceCosts (sum-to-total invariant)', () => {
  const prices = DEFAULT_PRICES;
  const fixedTotal = 40;

  it('matches the §20 worked example (small ≈ $9, large ≈ $63)', () => {
    const usages: WorkspaceUsage[] = [
      { workspaceId: 'small', emails_sent: 10_000, ipUpgraded: false, imageStorageBytes: 0, imageEgressBytes: 0 },
      { workspaceId: 'large', emails_sent: 300_000, ipUpgraded: true, imageStorageBytes: 0, imageEgressBytes: 0 },
      { workspaceId: 'w3', emails_sent: 0, ipUpgraded: false, imageStorageBytes: 0, imageEgressBytes: 0 },
      { workspaceId: 'w4', emails_sent: 0, ipUpgraded: false, imageStorageBytes: 0, imageEgressBytes: 0 },
      { workspaceId: 'w5', emails_sent: 0, ipUpgraded: false, imageStorageBytes: 0, imageEgressBytes: 0 },
    ];
    const result = computeAllWorkspaceCosts(usages, fixedTotal, prices);
    const small = result.workspaces.find((w) => w.workspaceId === 'small')!;
    const large = result.workspaces.find((w) => w.workspaceId === 'large')!;
    // $1 direct + $8 fixed = $9
    expect(small.total).toBeCloseTo(9, 10);
    // $30 + $24.95 + $8 = $62.95 ≈ $63
    expect(large.total).toBeCloseTo(62.95, 10);
    expect(large.fixedShare).toBeCloseTo(8, 10);
  });

  it('per-workspace figures sum to direct_total + fixed_total EXACTLY (penny-accurate)', () => {
    // Deliberately non-divisible fixed + odd usage to stress remainder handling.
    const usages: WorkspaceUsage[] = [
      { workspaceId: 'a', emails_sent: 12_345, ipUpgraded: true, imageStorageBytes: 7, imageEgressBytes: 13 },
      { workspaceId: 'b', emails_sent: 67, ipUpgraded: false, imageStorageBytes: 0, imageEgressBytes: 999 },
      { workspaceId: 'c', emails_sent: 1, ipUpgraded: false, imageStorageBytes: 1, imageEgressBytes: 1 },
    ];
    const oddFixed = 37.01;
    const result = computeAllWorkspaceCosts(usages, oddFixed, prices);

    const sumPerWs = result.workspaces.map((w) => cents(w.total)).reduce((a, b) => a + b, 0);
    const grandTotalCents = cents(result.directTotal + result.fixedTotal);
    expect(sumPerWs).toBe(grandTotalCents);
    expect(cents(result.fixedTotal)).toBe(cents(oddFixed));
  });

  it('the $24.95 IP cost lands ONLY on upgraded workspaces', () => {
    const usages: WorkspaceUsage[] = [
      { workspaceId: 'up', emails_sent: 0, ipUpgraded: true, imageStorageBytes: 0, imageEgressBytes: 0 },
      { workspaceId: 'shared', emails_sent: 0, ipUpgraded: false, imageStorageBytes: 0, imageEgressBytes: 0 },
    ];
    const result = computeAllWorkspaceCosts(usages, 0, prices);
    const up = result.workspaces.find((w) => w.workspaceId === 'up')!;
    const shared = result.workspaces.find((w) => w.workspaceId === 'shared')!;
    expect(up.directCost).toBeCloseTo(24.95, 10);
    expect(shared.directCost).toBe(0);
  });

  it('with zero active workspaces, totals are zero and no rows', () => {
    const result = computeAllWorkspaceCosts([], 40, prices);
    expect(result.workspaces).toEqual([]);
    expect(result.directTotal).toBe(0);
    // fixedTotal is still reported but nobody pays it (no active workspaces).
    expect(result.activeWorkspaceCount).toBe(0);
  });
});
