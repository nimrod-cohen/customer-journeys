// Processor pure core (§7). No I/O — the handler injects a workspace-scoped tx
// runner and wires these. Idempotent + order-convergent by construction:
//   - buildEventInsert: INSERT events ... ON CONFLICT(event_id) DO NOTHING (AC4).
//   - buildProcessorProfileUpsert: stub-or-upsert by (workspace_id, external_id);
//     a progress arriving before profile_created creates a STUB, the later
//     profile_created merges attributes (AC1/AC2 convergence).
//   - planProcessing: ordered statements (profile upsert BEFORE event insert, so
//     the events.profile_id FK is always satisfiable), all workspace-scoped.
//
// Phase 4 (profile_features, §6/§7 step 3): the event insert is now a SINGLE
// combined CTE that ALSO upserts profile_features, gated on the inner INSERT
// actually writing a row — so on replay (ON CONFLICT DO NOTHING returns nothing)
// the feature upsert is skipped and aggregates are NOT double-counted. The pure
// SQL in `buildFeatureUpsert` mirrors `applyEventToFeatures` exactly.
//
// Remaining extension point (Phase 5): segment re-evaluation hooks in AFTER this
// in `planProcessing`. Intentionally NOT implemented here (out of scope).
import {
  OPEN_EVENT_TYPES,
  PURCHASE_EVENT_TYPES,
  type ProcessorMessage,
  type ProfileFeatures,
} from '@cdp/shared';

/** A parameterized query ready for `pool.query(text, values)`. */
export interface SqlStatement {
  readonly text: string;
  readonly values: unknown[];
}

/**
 * A request to re-evaluate the workspace's active dynamic_realtime segments for
 * the CHANGED profile (§8). The re-eval needs reads (each segment's compiled
 * rule), so it can't be a static SqlStatement — it rides on the plan as a marker
 * that deps.ts executes against the SAME tx client, AFTER the feature upsert (so
 * it sees post-update features). The concrete profile id is resolved inside the
 * tx from (workspace_id, external_id).
 */
export interface SegmentReeval {
  readonly workspaceId: string;
  readonly profileExternalId: string;
}

/** The ordered, workspace-scoped work to apply for one message, in one tx. */
export interface ProcessingPlan {
  readonly workspaceId: string;
  readonly profileExternalId: string;
  readonly statements: readonly SqlStatement[];
  /**
   * Phase 5: when present, deps.ts runs realtime segment re-eval for the changed
   * profile in the SAME tx, AFTER the statements above. Omitted only if a phase
   * ever needs to opt out; planProcessing always sets it.
   */
  readonly segmentReeval?: SegmentReeval;
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

/** True if `type` is an email-open event (drives last_email_open_at, §6/§10). */
export function isEmailOpenType(type: string): boolean {
  return (OPEN_EVENT_TYPES as readonly string[]).includes(type);
}

/** True if `type` is purchase-like (contributes to monetary_total, §6). */
export function isPurchaseLike(type: string): boolean {
  return (PURCHASE_EVENT_TYPES as readonly string[]).includes(type);
}

/**
 * Extract the monetary amount from event attributes (`attributes.amount`).
 * Always returns a finite number: defaults to 0 when absent/unparseable and
 * NEVER returns NaN (so monetary_total stays a valid numeric, §6).
 */
export function extractAmount(attributes: Record<string, unknown> | undefined): number {
  const raw = attributes?.['amount'];
  let n: number;
  if (typeof raw === 'number') n = raw;
  else if (typeof raw === 'string') n = Number(raw);
  else return 0;
  return Number.isFinite(n) ? n : 0;
}

/** Pick the MAX of two ISO timestamps; either may be null. */
function maxTimestamp(a: string | null, b: string | null): string | null {
  if (a === null) return b;
  if (b === null) return a;
  return a >= b ? a : b;
}

/**
 * Pure next-state for profile_features (§6). Given the previous row (or null for
 * a profile with no features yet) and the event envelope, returns the new
 * aggregate state. This is the single source of truth that `buildFeatureUpsert`'s
 * SQL must mirror exactly:
 *   - total_events += 1
 *   - last_event_at = MAX(prev, occurred_at)
 *   - last_email_open_at = MAX(prev, occurred_at) ONLY on open types (else prev)
 *   - counters[type] += 1
 *   - monetary_total += amount for purchase-like events (else += 0)
 */
export function applyEventToFeatures(
  prev: ProfileFeatures | null,
  msg: ProcessorMessage,
): ProfileFeatures {
  const e = msg.envelope;
  const openTs = isEmailOpenType(e.type) ? e.occurred_at : null;
  const amount = isPurchaseLike(e.type) ? extractAmount(e.attributes) : 0;
  const prevCounters = prev?.counters ?? {};
  const counters: Record<string, number> = {
    ...prevCounters,
    [e.type]: (prevCounters[e.type] ?? 0) + 1,
  };
  return {
    profile_id: prev?.profile_id ?? msg.profile_id,
    workspace_id: msg.workspace_id,
    total_events: (prev?.total_events ?? 0) + 1,
    last_event_at: maxTimestamp(prev?.last_event_at ?? null, e.occurred_at),
    last_email_open_at: maxTimestamp(prev?.last_email_open_at ?? null, openTs),
    counters,
    monetary_total: (prev?.monetary_total ?? 0) + amount,
    updated_at: e.occurred_at,
  };
}

/**
 * Build the SINGLE combined event-insert + feature-upsert CTE (§6/§7 step 3, AC4).
 *
 * `WITH ins AS (INSERT INTO events ... ON CONFLICT(event_id) DO NOTHING RETURNING
 * event_id)` performs the idempotent event write; the following
 * `INSERT INTO profile_features ... SELECT ... WHERE EXISTS (SELECT 1 FROM ins)`
 * runs the aggregate upsert ONLY when the event was newly inserted. On replay the
 * inner INSERT returns no row, `ins` is empty, the gate is false, and
 * profile_features is left UNTOUCHED — no double-count.
 *
 * Tenancy: workspace_id is bound at $1 and profile_id is resolved via the
 * (workspace_id, external_id) subquery — NEVER from the client message. The
 * open-timestamp param is NULL for non-open events so GREATEST preserves the
 * prior value. The DO UPDATE SET clause mirrors applyEventToFeatures exactly.
 */
export function buildFeatureUpsert(msg: ProcessorMessage): SqlStatement {
  const e = msg.envelope;
  const openTs = isEmailOpenType(e.type) ? e.occurred_at : null;
  const amount = isPurchaseLike(e.type) ? extractAmount(e.attributes) : 0;
  // $1 workspace_id, $2 event_id, $3 external_id, $4 type, $5 occurred_at,
  // $6 payload(jsonb), $7 open_ts (nullable), $8 amount(numeric)
  return {
    text: `WITH ins AS (
             INSERT INTO events (event_id, workspace_id, profile_id, type, occurred_at, payload)
             SELECT $2, $1, p.id, $4, $5::timestamptz, $6::jsonb
             FROM profiles p
             WHERE p.workspace_id = $1 AND p.external_id = $3
             ON CONFLICT (event_id) DO NOTHING
             RETURNING event_id
           )
           INSERT INTO profile_features (
             profile_id, workspace_id, total_events, last_event_at,
             last_email_open_at, counters, monetary_total, updated_at
           )
           SELECT p.id, $1, 1, $5::timestamptz, $7::timestamptz,
                  jsonb_build_object($4::text, 1), $8::numeric, now()
           FROM profiles p
           WHERE p.workspace_id = $1 AND p.external_id = $3
             AND EXISTS (SELECT 1 FROM ins)
           ON CONFLICT (profile_id) DO UPDATE SET
             total_events = profile_features.total_events + 1,
             last_event_at = GREATEST(profile_features.last_event_at, EXCLUDED.last_event_at),
             last_email_open_at = GREATEST(profile_features.last_email_open_at, EXCLUDED.last_email_open_at),
             counters = profile_features.counters
               || jsonb_build_object($4::text, COALESCE((profile_features.counters->>$4)::int, 0) + 1),
             monetary_total = profile_features.monetary_total + EXCLUDED.monetary_total,
             updated_at = now()`,
    values: [
      msg.workspace_id,
      e.event_id,
      e.external_id,
      e.type,
      e.occurred_at,
      JSON.stringify(e.attributes ?? {}),
      openTs,
      amount,
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
 * Phase 4 (§6/§7 step 3): the standalone event insert is replaced by the combined
 * event-insert + feature-upsert CTE (`buildFeatureUpsert`), executed AFTER the
 * profile upsert. Folding the event insert and the feature gate into ONE
 * statement means the gate (WHERE EXISTS ins) can never drift from the insert —
 * a replayed event_id inserts nothing and the aggregates are not double-counted.
 *
 * Phase 5 (§8, §7 step 4/5): after the profile + feature upserts, the plan
 * carries a `segmentReeval` marker so deps.ts re-evaluates the workspace's active
 * dynamic_realtime segments for the CHANGED profile in the SAME tx — reading
 * POST-update features. The static ordering (profile upsert → feature upsert) is
 * unchanged so Phase 4 does not regress.
 */
export function planProcessing(msg: ProcessorMessage): ProcessingPlan {
  return {
    workspaceId: msg.workspace_id,
    profileExternalId: msg.envelope.external_id,
    statements: [buildProcessorProfileUpsert(msg), buildFeatureUpsert(msg)],
    segmentReeval: {
      workspaceId: msg.workspace_id,
      profileExternalId: msg.envelope.external_id,
    },
  };
}
