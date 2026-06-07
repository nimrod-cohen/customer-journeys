// Ingest pure core (§7). No I/O — the handler injects DB + SQS and wires these.
//
// Tenancy invariants enforced here:
//   - validateEnvelope NEVER carries a client-supplied workspace_id forward
//     (§7/§13): the workspace is derived from the API key, not the payload.
//   - resolveWorkspaceId maps the request-context api_key_id + its looked-up row
//     to a workspace, refusing unknown / mismatched keys.
//   - buildProfileUpsert / buildSqsMessage are parameterized builders; the
//     workspace id is always a bound parameter, never interpolated.
import { SendMessageCommand } from '@aws-sdk/client-sqs';
import type { EventEnvelope, ProcessorMessage, WorkspaceApiKeyRow } from '@cdp/shared';

/** A parameterized query ready for `pool.query(text, values)`. */
export interface SqlStatement {
  readonly text: string;
  readonly values: unknown[];
}

/** Discriminated result of envelope validation. */
export type ValidationResult =
  | { readonly ok: true; readonly value: EventEnvelope }
  | { readonly ok: false; readonly error: string };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0;
}

function isIso8601(v: unknown): v is string {
  if (typeof v !== 'string' || v.length === 0) return false;
  const t = Date.parse(v);
  return Number.isFinite(t);
}

/**
 * Validate a producer envelope (§7). Returns a NORMALIZED copy containing only
 * the trusted envelope fields. CRITICAL: a client-supplied `workspace_id` (or any
 * other extra field) is dropped — the workspace is derived from the API key.
 */
export function validateEnvelope(input: unknown): ValidationResult {
  if (!isRecord(input)) return { ok: false, error: 'payload must be a JSON object' };
  if (!isNonEmptyString(input['event_id']) || !UUID_RE.test(input['event_id'])) {
    return { ok: false, error: 'event_id must be a uuid' };
  }
  if (!isNonEmptyString(input['external_id'])) {
    return { ok: false, error: 'external_id is required' };
  }
  if (!isNonEmptyString(input['type'])) {
    return { ok: false, error: 'type is required' };
  }
  if (!isIso8601(input['occurred_at'])) {
    return { ok: false, error: 'occurred_at must be ISO-8601' };
  }
  const attrs = input['attributes'];
  if (attrs !== undefined && !isRecord(attrs)) {
    return { ok: false, error: 'attributes must be an object' };
  }
  // Reconstruct from trusted fields ONLY — never spread `input` (would leak
  // a client-supplied workspace_id into the validated value).
  const value: EventEnvelope = {
    event_id: input['event_id'],
    external_id: input['external_id'],
    type: input['type'],
    occurred_at: input['occurred_at'],
    attributes: isRecord(attrs) ? attrs : {},
  };
  return { ok: true, value };
}

/**
 * Resolve the workspace id from the request-context API key id and its looked-up
 * `workspace_api_keys` row (§7/§13). Throws on a missing key id, an unknown key
 * (no row), or a row whose api_key_id does not match — workspace is NEVER guessed.
 */
export function resolveWorkspaceId(
  apiKeyId: string,
  lookupRow: WorkspaceApiKeyRow | null | undefined,
): string {
  if (!isNonEmptyString(apiKeyId)) {
    throw new Error('resolveWorkspaceId: api_key_id is required (tenant-isolation guard)');
  }
  if (!lookupRow) {
    throw new Error(`resolveWorkspaceId: unknown API key ${apiKeyId}`);
  }
  if (lookupRow.api_key_id !== apiKeyId) {
    throw new Error('resolveWorkspaceId: API key row does not match the requesting key id');
  }
  if (!isNonEmptyString(lookupRow.workspace_id)) {
    throw new Error('resolveWorkspaceId: key row has no workspace_id');
  }
  return lookupRow.workspace_id;
}

/**
 * Build the per-(workspace_id, external_id) profile upsert (§7). On
 * profile_created the attributes merge; for any first-seen external_id a profile
 * (or stub) is created. Returns the profile id. Workspace id is bound at $1.
 */
export function buildProfileUpsert(
  workspaceId: string,
  externalId: string,
  attributes: Record<string, unknown>,
): SqlStatement {
  if (!workspaceId) throw new Error('buildProfileUpsert: workspaceId is required');
  // New profiles seed `unsubscribed = false` (so "unsubscribed = false" segments
  // match the subscribed); any provided attribute of the same name overrides it.
  // On UPDATE we merge ONLY the provided attrs ($3) — NOT the default — so an
  // existing `unsubscribed = true` (set by the unsubscribe flow) is never reset.
  return {
    text: `INSERT INTO profiles (workspace_id, external_id, attributes)
           VALUES ($1, $2, '{"unsubscribed": false}'::jsonb || $3::jsonb)
           ON CONFLICT (workspace_id, external_id)
           DO UPDATE SET attributes = profiles.attributes || $3::jsonb,
                         updated_at = now()
           RETURNING id`,
    values: [workspaceId, externalId, JSON.stringify(attributes ?? {})],
  };
}

/**
 * Build the SQS FIFO SendMessageCommand for an envelope (§7). Per-profile FIFO:
 * MessageGroupId = profile_id, MessageDeduplicationId = event_id. The trusted
 * workspace_id rides in the message body, never derived by the processor.
 */
export function buildSqsMessage(
  workspaceId: string,
  profileId: string,
  envelope: EventEnvelope,
  queueUrl: string,
): SendMessageCommand {
  const message: ProcessorMessage = {
    workspace_id: workspaceId,
    profile_id: profileId,
    envelope,
  };
  return new SendMessageCommand({
    QueueUrl: queueUrl,
    MessageBody: JSON.stringify(message),
    MessageGroupId: profileId,
    MessageDeduplicationId: envelope.event_id,
  });
}
