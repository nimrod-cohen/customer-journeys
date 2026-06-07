// @cdp/service-local-api — the load-bearing local backend (§12). A thin Hono HTTP
// server whose every request flows through: local authorizer (real PG) →
// contextFromAuthorizer → enforceRoute(routeTable) → handler (scopedQuery on a
// real pg pool) → existing cores. SES/SQS/DNS mocked at the boundary; Postgres
// real. See CDP-BUILD-SPEC.md §12, §3A, §10A, §13.

export {
  encodeDevToken,
  decodeDevToken,
  extractBearer,
  runLocalAuthorizer,
  type AuthorizerContext,
  type DevTokenPayload,
  type AuthorizerLookups,
  type LocalAuthResult,
} from './auth.js';

export { ROUTE_TABLE, capabilityForRoute, type RouteKey } from './routes.js';
export { matchRoute, type MatchedRoute } from './match.js';
export { dispatch, type ApiRequest, type DispatchEnv } from './dispatch.js';
export {
  HANDLERS,
  type Handler,
  type HandlerRequest,
  type HandlerResponse,
} from './handlers.js';
export { devLogin, switchWorkspace, type SessionResult } from './session.js';
export { makePgLookups } from './lookups.js';
export {
  makeLocalDeps,
  makeLocalSes,
  makeLocalDns,
  makeLocalSqs,
  type LocalApiDeps,
} from './deps.js';
export { createApp } from './app.js';
