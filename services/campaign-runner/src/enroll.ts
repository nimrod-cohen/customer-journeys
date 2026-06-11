// Enrollment orchestrator (§9B). A segment entry (segment_change_log 'entered')
// drives campaign enrollment: resolve the active campaigns whose
// trigger_segment_id matches the changed segment, decide re-enrollment, and
// insert an enrollment row at the start node — ALL in a workspace-scoped tx
// (the structural ON CONFLICT (campaign_id, profile_id) DO NOTHING is the real
// 'once' guard, so a retry/double-fire enrolls at most once).
//
// CRITICAL invariants enforced here:
//   - 'entered' enrolls; 'exited' produces NO enrollment.
//   - cross-workspace isolation: only campaigns in the change-log's workspace
//     are considered, and every write binds workspace_id at $1.
import {
  parseEnrollmentTrigger,
  buildEnrollmentInsert,
  type SegmentChangeLogRow,
  type CampaignTriggerRow,
  type EnrollmentIntent,
  type SqlStatement,
} from './core.js';
import { resolveStartNode, validateCampaignDefinition } from './dsl.js';

/** A minimal query reader (returns rows). The orchestrator never opens a tx. */
export interface Reader {
  query<T = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ rows: T[] }>;
}

/** Injected dependencies for the enrollment orchestrator. */
export interface EnrollDeps {
  /** Service-role reader (bypasses RLS → in-code scoping is the guard). */
  readonly reader: Reader;
  /** Apply a list of statements in ONE workspace-scoped tx (atomic write). */
  runInWorkspaceTx(workspaceId: string, statements: readonly SqlStatement[]): Promise<void>;
}

/** The outcome of processing one segment_change_log row. */
export interface EnrollResult {
  readonly enrolled: number;
  readonly intents: readonly EnrollmentIntent[];
}

interface CampaignRow {
  readonly id: string;
  readonly workspace_id: string;
  readonly trigger_segment_id: string | null;
  readonly trigger_on?: 'enter' | 'exit';
  readonly definition: unknown;
}

/**
 * Enroll profiles into campaigns triggered by a segment_change_log row. Reads
 * the active campaigns for the row's workspace whose trigger_segment_id matches
 * the changed segment, resolves each one's start node from its definition, then
 * inserts the enrollment(s) in a workspace-scoped tx. 'exited' is a no-op.
 */
export async function enrollFromSegmentChange(
  deps: EnrollDeps,
  row: SegmentChangeLogRow,
): Promise<EnrollResult> {
  if (!row.workspace_id) throw new Error('enrollFromSegmentChange: workspace_id is required');
  if (row.action !== 'entered' && row.action !== 'exited') return { enrolled: 0, intents: [] };

  // Load active campaigns for THIS workspace triggered by THIS segment. Whether a
  // campaign fires on this row is decided by trigger_on vs the action (parseEnrollmentTrigger).
  const { rows: campaignRows } = await deps.reader.query<CampaignRow>(
    `SELECT id, workspace_id, trigger_segment_id, trigger_on, definition
     FROM campaigns
     WHERE workspace_id = $1 AND status = 'active' AND trigger_segment_id = $2`,
    [row.workspace_id, row.segment_id],
  );

  // Resolve each campaign's start node from its (validated) definition.
  const triggerRows: CampaignTriggerRow[] = [];
  for (const c of campaignRows) {
    let startNode: string;
    try {
      validateCampaignDefinition(c.definition);
      // The start node IS the trigger (validateCampaignDefinition guarantees one
      // trigger + a resolvable startNode); resolveStartNode asserts it exists.
      resolveStartNode(c.definition);
      startNode = c.definition.startNode;
    } catch {
      continue; // skip an invalid campaign definition rather than crash the sweep
    }
    triggerRows.push({
      id: c.id,
      workspace_id: c.workspace_id,
      trigger_segment_id: c.trigger_segment_id,
      start_node: startNode,
      trigger_on: c.trigger_on ?? 'enter',
    });
  }

  const intents = parseEnrollmentTrigger(row, triggerRows);
  if (intents.length === 0) return { enrolled: 0, intents: [] };

  // Insert all enrollments for this workspace in ONE tx (ON CONFLICT DO NOTHING).
  const statements = intents.map((i) =>
    buildEnrollmentInsert(i.workspaceId, i.campaignId, i.profileId, i.startNode),
  );
  await deps.runInWorkspaceTx(row.workspace_id, statements);

  return { enrolled: intents.length, intents };
}
