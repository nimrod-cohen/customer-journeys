// Lambda entrypoint for the ingest service (§7). Wires production deps into the
// thin handler. Pure logic lives in ./core.ts; all I/O in ./deps.ts.
import { makeIngestHandler, type IngestEvent } from './handler.js';
import { makeProdDeps } from './deps.js';

export {
  validateEnvelope,
  resolveWorkspaceId,
  buildProfileUpsert,
  buildSqsMessage,
  type SqlStatement,
  type ValidationResult,
} from './core.js';
export { makeIngestHandler } from './handler.js';
export type { IngestDeps, IngestEvent, IngestResult } from './handler.js';
export { lookupApiKeyRow, upsertProfileForKey } from './deps.js';

let cached: ReturnType<typeof makeIngestHandler> | undefined;

export async function handler(event: IngestEvent) {
  if (!cached) cached = makeIngestHandler(makeProdDeps());
  return cached(event);
}
