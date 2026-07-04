// Typed API client for the admin SPA (§12, §13). CRITICAL invariant: the client
// sends the Bearer token (which carries the active workspace_id claim) and NEVER
// puts workspace_id in a request body — the server derives scope from the token
// only. The client is a thin fetch wrapper; the token is supplied by the auth
// store and injected per request.
//
// The base URL points at the local API (a fixed origin in dev/e2e, or `/api`
// proxied by Vite). Configurable via VITE_API_BASE.

/** Resolve the API base URL (Vite env in the browser; fallback for tests). */
function resolveBase(): string {
  // import.meta.env is provided by Vite; guard for the test/node environment.
  const env = (import.meta as unknown as { env?: Record<string, string> }).env;
  return env?.VITE_API_BASE ?? 'http://localhost:8787';
}

/** The API origin — used to absolutize server-relative resource paths (e.g. /assets/:id). */
export function apiBaseUrl(): string {
  return resolveBase();
}

export interface ApiError {
  readonly status: number;
  readonly error: string;
  /**
   * Any EXTRA fields the server put on the error body (beyond `error`) are carried
   * through verbatim — e.g. the campaign publish gate's `{ node, missing }`, which
   * the builder reads to render the reason against the offending node card. Without
   * this the client used to drop them and only surface a generic `error` string.
   */
  readonly [key: string]: unknown;
}

/** A token provider — returns the current bearer token, or null when logged out. */
export type TokenProvider = () => string | null;

/**
 * Guard: throw if a caller ever tries to send workspace_id in a body. This is a
 * defense-in-depth assertion of CLAUDE.md inv.2 — the apiClient must not carry a
 * client-chosen workspace id; the active workspace lives in the token only.
 */
export function assertNoWorkspaceIdInBody(body: unknown): void {
  if (
    body &&
    typeof body === 'object' &&
    Object.prototype.hasOwnProperty.call(body, 'workspace_id')
  ) {
    throw new Error('apiClient: workspace_id must never be sent in a request body (use the token)');
  }
}

export interface ApiClientOptions {
  readonly getToken: TokenProvider;
  readonly base?: string;
  /** Injected fetch (defaults to global fetch) — lets unit tests stub it. */
  readonly fetchImpl?: typeof fetch;
}

export interface RequestOptions {
  readonly body?: unknown;
  readonly query?: Record<string, string>;
  /**
   * The ONLY legitimate case for a workspace_id in a body: POST /workspace/switch
   * is CHOOSING a new active workspace, not scoping a data request. Every other
   * call must leave this false so the tenancy guard fires (CLAUDE.md inv.2).
   */
  readonly allowWorkspaceId?: boolean;
}

/** The typed client surface the SPA screens use. */
export interface ApiClient {
  get<T = unknown>(path: string, opts?: RequestOptions): Promise<T>;
  post<T = unknown>(path: string, opts?: RequestOptions): Promise<T>;
  put<T = unknown>(path: string, opts?: RequestOptions): Promise<T>;
  patch<T = unknown>(path: string, opts?: RequestOptions): Promise<T>;
  del<T = unknown>(path: string, opts?: RequestOptions): Promise<T>;
}

/** Build a typed API client. */
export function createApiClient(opts: ApiClientOptions): ApiClient {
  const base = opts.base ?? resolveBase();

  async function request<T>(method: string, path: string, ro: RequestOptions = {}): Promise<T> {
    if (ro.body !== undefined && !ro.allowWorkspaceId) assertNoWorkspaceIdInBody(ro.body);
    // A base of '' means "same origin" (the single-container production deploy
    // where the SPA and API share a host). new URL() needs an absolute base to
    // resolve a relative path — without one, `new URL('/auth/register')` THROWS
    // "Invalid URL" and every API call fails. Anchor on the current origin; an
    // absolute `base` (e.g. dev's http://localhost:8787) still overrides it.
    const origin =
      typeof globalThis !== 'undefined' && globalThis.location
        ? globalThis.location.origin
        : 'http://localhost';
    const url = new URL(base + path, origin);
    if (ro.query) for (const [k, v] of Object.entries(ro.query)) url.searchParams.set(k, v);

    const headers: Record<string, string> = {};
    const token = opts.getToken();
    if (token) headers['authorization'] = `Bearer ${token}`;
    const hasBody = ro.body !== undefined && method !== 'GET';
    if (hasBody) headers['content-type'] = 'application/json';

    // Resolve fetch at CALL time (not bind time) so a test swapping globalThis.fetch
    // after the client is constructed still takes effect.
    const doFetch = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
    const res = await doFetch(url.toString(), {
      method,
      headers,
      ...(hasBody ? { body: JSON.stringify(ro.body) } : {}),
    });
    const text = await res.text();
    const json = text ? (JSON.parse(text) as unknown) : undefined;
    if (!res.ok) {
      // Carry the full server error body (so extra fields like the publish gate's
      // `node`/`missing` survive), with `status`/`error` normalized on top.
      const body = (json && typeof json === 'object' ? (json as Record<string, unknown>) : {});
      const err: ApiError = {
        ...body,
        status: res.status,
        error: (json as { error?: string } | undefined)?.error ?? res.statusText,
      };
      throw err;
    }
    return json as T;
  }

  return {
    get: (p, o) => request('GET', p, o),
    post: (p, o) => request('POST', p, o),
    put: (p, o) => request('PUT', p, o),
    patch: (p, o) => request('PATCH', p, o),
    del: (p, o) => request('DELETE', p, o),
  };
}
