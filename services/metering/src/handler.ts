// Metering Lambda — thin EventBridge-scheduled handler (§20, §10, §17 phase 13).
// Two scheduled orchestrators sweep every ACTIVE workspace:
//   - rollup-all: refresh usage_counters SET-to-truth (emails_sent +
//     events_ingested) per workspace,
//   - advisor-all: evaluate + persist the dedicated-IP recommendation.
// Per-workspace failures are isolated so one workspace never blocks the sweep.
// Pure logic lives in ./core.ts + ./{usage,cost,advisor}.ts; all I/O in ./deps.ts.
import {
  runRollupForWorkspace,
  runAdvisorForWorkspace,
  type MeteringDeps,
} from './core.js';
import { DEFAULT_IP_THRESHOLDS, type IpThresholds } from './advisor.js';

/** Injected dependencies for the scheduled sweeps. */
export interface MeteringHandlerDeps extends MeteringDeps {
  /** List the ACTIVE workspace ids the sweep should process. */
  listActiveWorkspaceIds(): Promise<string[]>;
  /** Clock (injectable for deterministic tests). */
  now(): Date;
}

/** Per-sweep summary (for logging). */
export interface SweepResult {
  readonly processed: string[];
  readonly failures: { workspaceId: string; error: string }[];
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Refresh usage_counters for every active workspace (§20). Each workspace runs
 * in its own tx; failures are collected, not thrown, so the sweep completes.
 */
export async function runRollupAll(deps: MeteringHandlerDeps): Promise<SweepResult> {
  const now = deps.now();
  const ids = await deps.listActiveWorkspaceIds();
  const processed: string[] = [];
  const failures: { workspaceId: string; error: string }[] = [];
  for (const ws of ids) {
    try {
      await runRollupForWorkspace(deps, ws, now);
      processed.push(ws);
    } catch (err) {
      failures.push({ workspaceId: ws, error: errMsg(err) });
    }
  }
  return { processed, failures };
}

/**
 * Evaluate + persist the dedicated-IP recommendation for every active workspace
 * (§10). Recommend-only; never upgrades. Per-workspace failures isolated.
 */
export async function runAdvisorAll(
  deps: MeteringHandlerDeps,
  thresholds: IpThresholds = DEFAULT_IP_THRESHOLDS,
): Promise<SweepResult> {
  const now = deps.now();
  const ids = await deps.listActiveWorkspaceIds();
  const processed: string[] = [];
  const failures: { workspaceId: string; error: string }[] = [];
  for (const ws of ids) {
    try {
      await runAdvisorForWorkspace(deps, ws, now, thresholds);
      processed.push(ws);
    } catch (err) {
      failures.push({ workspaceId: ws, error: errMsg(err) });
    }
  }
  return { processed, failures };
}

/** The scheduled job to run, selected by the EventBridge event detail. */
export type MeteringJob = 'rollup' | 'advisor';

/** Build the metering handler from its injected dependencies. */
export function makeMeteringHandler(deps: MeteringHandlerDeps) {
  return async function handler(event?: { job?: MeteringJob }): Promise<SweepResult> {
    // Default to the rollup sweep; the advisor runs on its own (monthly) schedule.
    if (event?.job === 'advisor') return runAdvisorAll(deps);
    return runRollupAll(deps);
  };
}
