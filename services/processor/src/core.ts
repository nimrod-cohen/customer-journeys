// Processor pure core (§7). No I/O — the handler injects a workspace-scoped tx
// runner and wires these. Idempotent + order-convergent by construction:
//   - buildEventInsert: INSERT events ... ON CONFLICT(event_id) DO NOTHING (AC4).
//   - buildProcessorProfileUpsert: stub-or-upsert by (workspace_id, external_id);
//     a progress arriving before profile_created creates a STUB, the later
//     profile_created merges attributes (AC1/AC2 convergence).
//   - planProcessing: ordered statements (profile upsert BEFORE event insert, so
//     the events.profile_id FK is always satisfiable), all workspace-scoped.
//
// Extension points (Phase 4+): profile_features aggregation and segment
// re-evaluation hook in AFTER the event insert in `planProcessing`. Intentionally
// NOT implemented here (out of scope for Phase 3).
import type { ProcessorMessage } from '@cdp/shared';

/** A parameterized query ready for `pool.query(text, values)`. */
export interface SqlStatement {
  readonly text: string;
  readonly values: unknown[];
}

/** The ordered, workspace-scoped work to apply for one message, in one tx. */
export interface ProcessingPlan {
  readonly workspaceId: string;
  readonly profileExternalId: string;
  readonly statements: readonly SqlStatement[];
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0;
}

/**
 * Parse + validate the trusted message body ingest wrote to SQS (§7). The
 * workspace_id here is trusted (set by ingest from the API key); it must be
 * present — it is NEVER inferred. Throws on malformed bodies (handler reports a
 * batch item failure → redrive → DLQ).
 */
export function parseProcessorMessage(body: string): ProcessorMessage {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new Error('parseProcessorMessage: body is not valid JSON');
  }
  if (!isRecord(parsed)) throw new Error('parseProcessorMessage: body must be an object');
  if (!isNonEmptyString(parsed['workspace_id'])) {
    throw new Error('parseProcessorMessage: workspace_id is required');
  }
  if (!isNonEmptyString(parsed['profile_id'])) {
    throw new Error('parseProcessorMessage: profile_id is required');
  }
  const env = parsed['envelope'];
  if (!isRecord(env) || !isNonEmptyString(env['event_id']) || !isNonEmptyString(env['external_id'])) {
    throw new Error('parseProcessorMessage: invalid envelope');
  }
  return {
    workspace_id: parsed['workspace_id'],
    profile_id: parsed['profile_id'],
    envelope: {
      event_id: env['event_id'] as string,
      external_id: env['external_id'] as string,
      type: isNonEmptyString(env['type']) ? env['type'] : 'unknown',
      occurred_at: isNonEmptyString(env['occurred_at'])
        ? env['occurred_at']
        : new Date(0).toISOString(),
      attributes: isRecord(env['attributes']) ? env['attributes'] : {},
    },
  };
}

/**
 * Build the idempotent event insert (AC4). The producer-supplied event_id is the
 * dedupe key; a repeat is a no-op. The resolved profile id is provided via a
 * subquery on (workspace_id, external_id) so the row links to the SAME profile
 * the upsert created/found in this tx — never another workspace's profile.
 */
export function buildEventInsert(msg: ProcessorMessage): SqlStatement {
  const e = msg.envelope;
  return {
    text: `INSERT INTO events (event_id, workspace_id, profile_id, type, occurred_at, payload)
           SELECT $1, $2, p.id, $4, $5::timestamptz, $6::jsonb
           FROM profiles p
           WHERE p.workspace_id = $2 AND p.external_id = $3
           ON CONFLICT (event_id) DO NOTHING`,
    values: [
      e.event_id,
      msg.workspace_id,
      e.external_id,
      e.type,
      e.occurred_at,
      JSON.stringify(e.attributes ?? {}),
    ],
  };
}

/**
 * Build the stub-or-upsert profile statement keyed by (workspace_id, external_id)
 * (AC1/AC2). progress-first creates a stub (empty attributes merge); a later
 * profile_created merges its attributes onto the existing row. Workspace bound $1.
 */
export function buildProcessorProfileUpsert(msg: ProcessorMessage): SqlStatement {
  const e = msg.envelope;
  // Only profile_created contributes attributes; other events upsert a stub.
  const attrs = e.type === 'profile_created' ? (e.attributes ?? {}) : {};
  return {
    text: `INSERT INTO profiles (workspace_id, external_id, attributes)
           VALUES ($1, $2, $3::jsonb)
           ON CONFLICT (workspace_id, external_id)
           DO UPDATE SET attributes = profiles.attributes || EXCLUDED.attributes,
                         updated_at = now()`,
    values: [msg.workspace_id, e.external_id, JSON.stringify(attrs)],
  };
}

/**
 * Plan the ordered, workspace-scoped statements for one message (§7).
 * Order matters: the profile upsert runs FIRST so the events insert's
 * (workspace_id, external_id) lookup always resolves (FK satisfiable) even when
 * a progress event arrives before its profile_created.
 *
 * Phase 4+ extension point: append profile_features + segment re-eval statements
 * after the event insert — intentionally not implemented here.
 */
export function planProcessing(msg: ProcessorMessage): ProcessingPlan {
  return {
    workspaceId: msg.workspace_id,
    profileExternalId: msg.envelope.external_id,
    statements: [buildProcessorProfileUpsert(msg), buildEventInsert(msg)],
  };
}
