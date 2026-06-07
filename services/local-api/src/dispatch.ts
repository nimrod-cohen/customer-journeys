// The request-processing pipeline (§12, §13). This is the load-bearing core that
// every API request flows through, made a pure-ish function (PG + injected deps
// are the only I/O) so the role + workspace-scope enforcement is unit/integration
// testable WITHOUT the HTTP server:
//
//   1. run the local authorizer (decode dev token, load membership + platform
//      admin from real PG, authorize()) → API-Gateway-shaped string context,
//   2. match the route → required Capability (the routeTable),
//   3. build the trusted WorkspaceContext via contextFromAuthorizer() and
//      enforceRoute(ctx, capability) — a 403 here is SERVER-SIDE, independent of
//      any UI hiding,
//   4. invoke the handler (which scopes every DB op to ctx.workspaceId).
//
// workspace_id is ALWAYS from the authorizer context (the token), NEVER the body.
import type { Pool } from 'pg';
import {
  contextFromAuthorizer,
  enforceRoute,
  RouteForbiddenError,
} from '@cdp/service-api';
import { CapabilityError } from '@cdp/tenancy';
import { matchRoute } from './match.js';
import { capabilityForRoute } from './routes.js';
import { runLocalAuthorizer, extractBearer, type AuthorizerLookups } from './auth.js';
import { HANDLERS, type HandlerRequest, type HandlerResponse } from './handlers.js';
import type { LocalApiDeps } from './deps.js';

/** A parsed incoming HTTP request (method + path + headers + body). */
export interface ApiRequest {
  readonly method: string;
  readonly path: string;
  readonly authorization: string | null;
  readonly query: Readonly<Record<string, string>>;
  readonly body: unknown;
}

/** Everything the dispatcher needs that is not the request itself. */
export interface DispatchEnv {
  readonly pool: Pool;
  readonly lookups: AuthorizerLookups;
  readonly deps: LocalApiDeps;
}

function jsonError(status: number, message: string): HandlerResponse {
  return { status, body: { error: message } };
}

/**
 * Process one API request end-to-end (auth → route → enforce → handle).
 * Returns a JSON HandlerResponse. Never throws for expected auth/role failures —
 * they map to 401/403/404. Unexpected handler errors become 500.
 */
export async function dispatch(req: ApiRequest, env: DispatchEnv): Promise<HandlerResponse> {
  // 1. Authenticate (local authorizer over real PG).
  const bearer = extractBearer(req.authorization);
  const auth = await runLocalAuthorizer(bearer, env.lookups);
  if (!auth.ok) return jsonError(auth.status, auth.reason);

  // 2. Match the route → required capability.
  const matched = matchRoute(req.method, req.path);
  if (!matched) return jsonError(404, 'route not found');
  const capability = capabilityForRoute(matched.key);

  // 3. Build the TRUSTED context from the authorizer-injected string context and
  //    enforce the route's capability SERVER-SIDE.
  const authorizerCtx: Record<string, string | undefined> = { ...auth.context };
  const ctx = contextFromAuthorizer({ requestContext: { authorizer: authorizerCtx } });
  if (capability !== null) {
    try {
      enforceRoute(ctx, capability);
    } catch (e) {
      if (e instanceof RouteForbiddenError || e instanceof CapabilityError) {
        return jsonError(403, `forbidden: requires ${capability}`);
      }
      throw e;
    }
  }

  // 4. Invoke the handler (scopes all DB ops to ctx.workspaceId).
  const handler = HANDLERS[matched.key];
  if (!handler) return jsonError(404, 'handler not found');
  const handlerReq: HandlerRequest = {
    params: matched.params,
    query: req.query,
    body: req.body,
  };
  try {
    return await handler(ctx, env.pool, handlerReq, env.deps);
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'internal error';
    return jsonError(500, msg);
  }
}
