// Lambda entrypoint + public surface for the metering service (§20, §10).
// Pure logic in ./{usage,cost,advisor,ip-upgrade}.ts; orchestrators in ./core.ts;
// thin scheduled handler in ./handler.ts; all I/O in ./deps.ts.
import { makeMeteringHandler } from './handler.js';
import { makeProdDeps } from './deps.js';

// usage rollups (§20)
export {
  monthBucket,
  periodForDate,
  buildEmailsSentRollup,
  buildEventsIngestedRollup,
} from './usage.js';

// cost attribution (§20)
export {
  DEFAULT_PRICES,
  computeDirectCost,
  evenShare,
  computeAllWorkspaceCosts,
  type Prices,
  type WorkspaceUsage,
  type DirectCostInput,
  type WorkspaceCost,
  type AllWorkspaceCosts,
} from './cost.js';

// IP advisor (§10)
export {
  DEFAULT_IP_THRESHOLDS,
  decideIpRecommendation,
  buildIpRecommendationUpdate,
  type IpThresholds,
  type MonthSeries,
  type IpRecommendation,
} from './advisor.js';

// IP upgrade state (§10)
export {
  planUpgradeIp,
  planCompleteUpgrade,
  warmupSplit,
  chooseSendPool,
  DEFAULT_WARMUP_DAYS,
  type IpMode,
  type WarmupStatus,
  type SendPool,
} from './ip-upgrade.js';

// orchestrators (§20, §10)
export {
  planRollups,
  runRollupForWorkspace,
  buildWorkspaceUsageRead,
  usageRowToWorkspaceUsage,
  computeCostViewForWorkspaces,
  buildAdvisorSeriesRead,
  rowToMonthSeries,
  runAdvisorForWorkspace,
  upgradeIp,
  type MeteringDeps,
  type QueryFn,
  type RunInWorkspaceTx,
} from './core.js';

export {
  makeMeteringHandler,
  runRollupAll,
  runAdvisorAll,
  type MeteringHandlerDeps,
  type SweepResult,
  type MeteringJob,
} from './handler.js';

export { runStatementsInWorkspaceTx, makeProdDeps } from './deps.js';

let cached: ReturnType<typeof makeMeteringHandler> | undefined;

export async function handler(event?: { job?: 'rollup' | 'advisor' }) {
  if (!cached) cached = makeMeteringHandler(makeProdDeps());
  return cached(event);
}
