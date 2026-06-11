// Batch-eval Lambda — thin EventBridge-scheduled handler (§8, §17 phase 5).
// Sweeps every active workspace's dynamic_batch segments. Pure logic lives in
// ./core.ts; all I/O in ./deps.ts. Per-workspace failures are isolated so one
// workspace's error never blocks the rest of the sweep.
import {
  runBatchEvalForWorkspace,
  runCampaignTimeSweepForWorkspace,
  type BatchEvalDeps,
  type BatchEvalResult,
} from './core.js';

/** Injected dependencies for the scheduled sweep. */
export interface BatchEvalHandlerDeps extends BatchEvalDeps {
  /** List the workspace ids the sweep should process (active workspaces). */
  listWorkspaceIds(): Promise<string[]>;
}

/** A scheduled-sweep summary (for logging). */
export interface BatchEvalSweepResult {
  readonly workspaces: BatchEvalResult[];
  readonly failures: { workspaceId: string; error: string }[];
}

/** Build the batch-eval handler from its injected dependencies. */
export function makeBatchEvalHandler(deps: BatchEvalHandlerDeps) {
  return async function handler(): Promise<BatchEvalSweepResult> {
    const ids = await deps.listWorkspaceIds();
    const workspaces: BatchEvalResult[] = [];
    const failures: { workspaceId: string; error: string }[] = [];
    for (const ws of ids) {
      try {
        // dynamic_batch segments + time-sensitive campaign-trigger segments (the
        // latter so a profile aging out of a window fires its campaign enter/exit).
        const batch = await runBatchEvalForWorkspace(deps, ws);
        const timeSweep = await runCampaignTimeSweepForWorkspace(deps, ws);
        workspaces.push({ workspaceId: ws, segments: [...batch.segments, ...timeSweep.segments] });
      } catch (err) {
        failures.push({ workspaceId: ws, error: err instanceof Error ? err.message : String(err) });
      }
    }
    return { workspaces, failures };
  };
}
