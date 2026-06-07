// Route matching: turn a concrete (method, path) into a route-table key +
// extracted path params. Patterns in ROUTE_TABLE use `:name` placeholders. The
// matcher is pure + deterministic so the role-enforcement layer is unit-testable
// without the HTTP server.
import { ROUTE_TABLE, type RouteKey } from './routes.js';

export interface MatchedRoute {
  readonly key: RouteKey;
  readonly params: Readonly<Record<string, string>>;
}

const ROUTE_KEYS = Object.keys(ROUTE_TABLE);

/** Split a route key `"GET /a/:id"` into method + segment array. */
function parseKey(key: RouteKey): { method: string; segments: string[] } {
  const spaceIdx = key.indexOf(' ');
  const method = key.slice(0, spaceIdx);
  const path = key.slice(spaceIdx + 1);
  return { method, segments: path.split('/').filter((s) => s.length > 0) };
}

/**
 * Resolve a concrete request to its route key + params, or null if no route
 * matches. Static segments must match exactly; `:name` segments capture. A
 * static route is preferred over a param route at the same position by ordering:
 * we check all and prefer the match with the FEWEST params (most specific).
 */
export function matchRoute(method: string, path: string): MatchedRoute | null {
  const reqSegs = path.split('?')[0]!.split('/').filter((s) => s.length > 0);
  let best: MatchedRoute | null = null;
  let bestParamCount = Number.POSITIVE_INFINITY;

  for (const key of ROUTE_KEYS) {
    const { method: km, segments } = parseKey(key);
    if (km !== method.toUpperCase()) continue;
    if (segments.length !== reqSegs.length) continue;

    const params: Record<string, string> = {};
    let ok = true;
    let paramCount = 0;
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i]!;
      const val = reqSegs[i]!;
      if (seg.startsWith(':')) {
        params[seg.slice(1)] = decodeURIComponent(val);
        paramCount += 1;
      } else if (seg !== val) {
        ok = false;
        break;
      }
    }
    if (ok && paramCount < bestParamCount) {
      best = { key, params };
      bestParamCount = paramCount;
    }
  }
  return best;
}
