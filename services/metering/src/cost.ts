// Per-workspace monthly cost attribution (§20) — PURE math, the highest-value
// unit target (§16A). Hybrid policy:
//   - Direct/variable costs are attributed to the workspace that incurred them:
//     emails_sent × $0.0001, the $24.95 dedicated-IP fee IF (and only if) the
//     workspace is upgraded, plus image storage/egress by its own bytes.
//   - Fixed costs (Supabase base + baseline compute) are split EVENLY across the
//     ACTIVE workspaces — penny-accurate, so the remainder is distributed
//     cent-by-cent and nothing is lost to rounding.
//
// The non-negotiable invariant (§18 "Cost attribution"): the per-workspace
// figures sum to direct_total + fixed_total EXACTLY. We achieve that by working
// in integer cents for the even split and never rounding the per-workspace total
// after the fact.

/** Unit prices for the direct cost components (§20). */
export interface Prices {
  /** Per email sent. $0.10 / 1k = $0.0001 each. */
  readonly emailPerSend: number;
  /** Flat monthly fee for a dedicated IP, charged only to upgraded workspaces. */
  readonly dedicatedIpMonthly: number;
  /** Per byte of image storage (S3). */
  readonly imageStoragePerByte: number;
  /** Per byte of image egress (CloudFront). */
  readonly imageEgressPerByte: number;
}

/** Default §20 unit prices. */
export const DEFAULT_PRICES: Prices = {
  emailPerSend: 0.0001,
  dedicatedIpMonthly: 24.95,
  // Rough §20-scale defaults; image bytes are a minor component. Kept explicit
  // so the cost view is deterministic and testable. ($0.023/GB-mo storage,
  // $0.085/GB egress → per-byte.)
  imageStoragePerByte: 0.023 / 1_000_000_000,
  imageEgressPerByte: 0.085 / 1_000_000_000,
};

/** A workspace's metered usage for the period (the direct-cost inputs). */
export interface WorkspaceUsage {
  readonly workspaceId: string;
  readonly emails_sent: number;
  /** Whether this workspace is on a dedicated IP (ip_mode !== 'shared'). */
  readonly ipUpgraded: boolean;
  readonly imageStorageBytes: number;
  readonly imageEgressBytes: number;
}

/** A single direct-cost input (no workspace id needed). */
export interface DirectCostInput {
  readonly emails_sent: number;
  readonly ipUpgraded: boolean;
  readonly imageStorageBytes: number;
  readonly imageEgressBytes: number;
}

/** A per-workspace cost line in the computed cost view. */
export interface WorkspaceCost {
  readonly workspaceId: string;
  /** Direct/variable cost attributed to this workspace. */
  readonly directCost: number;
  /** This workspace's equal share of the fixed pool (penny-accurate). */
  readonly fixedShare: number;
  /** directCost + fixedShare. */
  readonly total: number;
}

/** The whole computed cost view for a period. */
export interface AllWorkspaceCosts {
  readonly workspaces: WorkspaceCost[];
  /** Sum of all direct costs. */
  readonly directTotal: number;
  /** The fixed pool that was split. */
  readonly fixedTotal: number;
  /** status='active' workspace count = the even-split denominator. */
  readonly activeWorkspaceCount: number;
}

/**
 * Compute the direct/variable cost for one workspace's usage (§20). The
 * dedicated-IP fee is added ONLY when `ipUpgraded` is true — it lands where it's
 * earned, never on shared-pool workspaces.
 */
export function computeDirectCost(input: DirectCostInput, prices: Prices): number {
  return (
    input.emails_sent * prices.emailPerSend +
    (input.ipUpgraded ? prices.dedicatedIpMonthly : 0) +
    input.imageStorageBytes * prices.imageStoragePerByte +
    input.imageEgressBytes * prices.imageEgressPerByte
  );
}

/**
 * Split `fixedTotal` evenly across `activeCount` workspaces with PENNY-ACCURATE
 * remainder distribution: each share is the floor of the per-cent quotient and
 * the leftover cents are handed out one-per-workspace from the front, so the
 * returned shares always sum to `fixedTotal` exactly (to the cent). Returns an
 * empty array when there are no active workspaces (nobody pays the fixed pool).
 */
export function evenShare(fixedTotal: number, activeCount: number): number[] {
  if (activeCount <= 0) return [];
  const totalCents = Math.round(fixedTotal * 100);
  const base = Math.floor(totalCents / activeCount);
  let remainder = totalCents - base * activeCount;
  const shares: number[] = [];
  for (let i = 0; i < activeCount; i++) {
    const cents = base + (remainder > 0 ? 1 : 0);
    if (remainder > 0) remainder -= 1;
    shares.push(cents / 100);
  }
  return shares;
}

/**
 * Compute the full per-workspace cost view for a period (§20). The SAME set of
 * `usages` is both the even-split denominator AND the iterated rows, so the
 * caller must pass exactly the ACTIVE workspaces. Guarantees the sum-to-total
 * invariant: Σ per-workspace total === directTotal + fixedTotal (penny-exact),
 * because the fixed split is penny-accurate and per-workspace totals are never
 * re-rounded.
 */
export function computeAllWorkspaceCosts(
  usages: readonly WorkspaceUsage[],
  fixedTotal: number,
  prices: Prices,
): AllWorkspaceCosts {
  const activeWorkspaceCount = usages.length;
  const shares = evenShare(fixedTotal, activeWorkspaceCount);

  let directTotal = 0;
  const workspaces: WorkspaceCost[] = usages.map((u, i) => {
    const directCost = computeDirectCost(u, prices);
    directTotal += directCost;
    const fixedShare = shares[i] ?? 0;
    return {
      workspaceId: u.workspaceId,
      directCost,
      fixedShare,
      total: directCost + fixedShare,
    };
  });

  // fixedTotal as actually split (the sum of the penny-accurate shares). When
  // there are active workspaces this equals the input fixedTotal to the cent.
  const splitFixedTotal = shares.reduce((a, b) => a + b, 0);

  return {
    workspaces,
    directTotal,
    fixedTotal: activeWorkspaceCount > 0 ? splitFixedTotal : fixedTotal,
    activeWorkspaceCount,
  };
}
