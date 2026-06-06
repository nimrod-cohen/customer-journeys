// Ingest Lambda — thin handler (§7).
//
// Flow: read api_key_id from the request context → validateEnvelope →
// resolveWorkspaceId (DB lookup) → upsert profile (DB) → SQS SendMessage →
// return 200 ONLY after SQS resolves (durable boundary, CLAUDE.md invariant 4).
// All I/O (SQS client, api-key lookup, profile upsert) is INJECTED so the handler
// stays thin and unit-testable. workspace_id is NEVER read from the client body.
import type { SQSClient } from '@aws-sdk/client-sqs';
import type { WorkspaceApiKeyRow } from '@cdp/shared';
import { validateEnvelope, resolveWorkspaceId, buildSqsMessage } from './core.js';

/** The bits of an API Gateway REST proxy event ingest uses. */
export interface IngestEvent {
  readonly requestContext?: {
    readonly identity?: { readonly apiKeyId?: string | undefined };
    readonly apiKeyId?: string | undefined;
  };
  readonly body?: string | null;
}

export interface IngestResult {
  readonly statusCode: number;
  readonly body: string;
}

/** Injected dependencies — real implementations live in `deps.ts`. */
export interface IngestDeps {
  readonly sqs: SQSClient;
  readonly queueUrl: string;
  /** Look up the workspace_api_keys row for the request's api_key_id. */
  lookupApiKey(apiKeyId: string): Promise<WorkspaceApiKeyRow | null>;
  /** Upsert the profile by (workspace_id, external_id), returning its id. */
  upsertProfile(
    workspaceId: string,
    externalId: string,
    attributes: Record<string, unknown>,
  ): Promise<string>;
}

function json(statusCode: number, payload: unknown): IngestResult {
  return { statusCode, body: JSON.stringify(payload) };
}

function readApiKeyId(event: IngestEvent): string | undefined {
  return event.requestContext?.identity?.apiKeyId ?? event.requestContext?.apiKeyId;
}

/** Build the ingest handler from its injected dependencies. */
export function makeIngestHandler(deps: IngestDeps) {
  return async function handler(event: IngestEvent): Promise<IngestResult> {
    // 1. Parse the body.
    let parsed: unknown;
    try {
      parsed = event.body ? JSON.parse(event.body) : undefined;
    } catch {
      return json(400, { error: 'invalid JSON body' });
    }

    // 2. Validate the envelope (drops any client-supplied workspace_id).
    const v = validateEnvelope(parsed);
    if (!v.ok) return json(400, { error: v.error });
    const envelope = v.value;

    // 3. Resolve the workspace from the API key (never the payload).
    const apiKeyId = readApiKeyId(event);
    let workspaceId: string;
    try {
      const row = apiKeyId ? await deps.lookupApiKey(apiKeyId) : null;
      workspaceId = resolveWorkspaceId(apiKeyId ?? '', row);
    } catch {
      // Unknown / missing key → forbidden. Never reveal which check failed.
      return json(403, { error: 'forbidden' });
    }

    // 4. Upsert the profile (DB), then 5. enqueue (SQS).
    // A failure of EITHER must yield a non-2xx so the producer retries with the
    // same event_id — the durable boundary holds at SQS acceptance.
    try {
      const profileId = await deps.upsertProfile(
        workspaceId,
        envelope.external_id,
        envelope.type === 'profile_created' ? (envelope.attributes ?? {}) : {},
      );
      // 200 is returned ONLY after this resolves.
      await deps.sqs.send(buildSqsMessage(workspaceId, profileId, envelope, deps.queueUrl));
      return json(200, { ok: true, event_id: envelope.event_id });
    } catch {
      return json(503, { error: 'temporarily unavailable, retry' });
    }
  };
}
