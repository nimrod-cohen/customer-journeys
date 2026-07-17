// Automation-runner Lambda — thin scheduled-sweep handler (§9B). An EventBridge
// schedule (~every minute) triggers it; it finds active enrollments whose
// next_run_at has arrived and runs each via runEnrollment. Failures are isolated
// per row (one bad enrollment must not abort the whole sweep) and the handler
// NEVER throws (a thrown sweep would lose the whole batch).
//
// All logic lives in run.ts / core.ts; this handler just wires deps + loops.
import { buildSweepQuery } from './core.js';
import { runEnrollment, type RunDeps } from './run.js';

/** Build the EventBridge scheduled-sweep handler. */
export function makeScheduledSweepHandler(deps: RunDeps) {
  return async function onScheduledSweep(): Promise<void> {
    let ids: string[] = [];
    try {
      const q = buildSweepQuery(deps.now());
      const { rows } = await deps.reader.query<{ id: string }>(q.text, q.values);
      ids = rows.map((r) => r.id);
    } catch {
      return; // could not read the due set; the next sweep retries
    }
    for (const id of ids) {
      try {
        await runEnrollment(deps, id);
      } catch {
        /* isolate failures: one bad enrollment must not abort the sweep */
      }
    }
  };
}
