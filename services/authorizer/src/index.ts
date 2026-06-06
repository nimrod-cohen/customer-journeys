// Lambda entrypoint for the authorizer. Wires the production dependencies into
// the thin handler. The decision logic lives in ./authorize.ts (pure) and the
// I/O in ./deps.ts (jose JWKS + pg lookups). See §12.
import { makeAuthorizerHandler, type AuthorizerEvent } from './handler.js';
import { makeProdDeps } from './deps.js';

export { authorize, buildAuthorizerPolicy } from './authorize.js';
export { makeAuthorizerHandler } from './handler.js';
export type { AuthorizerDeps, AuthorizerEvent } from './handler.js';
export type { DecodedJwt, AuthorizerPolicy } from './authorize.js';

// Lazily construct prod deps on cold start so unit tests never trigger env reads.
let cached: ReturnType<typeof makeAuthorizerHandler> | undefined;

export async function handler(event: AuthorizerEvent) {
  if (!cached) cached = makeAuthorizerHandler(makeProdDeps());
  return cached(event);
}
