// executeWebhook (§9B webhook action). Pure orchestration over an INJECTED HTTP
// client — the runner wires a real fetch-based client behind this interface; tests
// pass a fake (never a real host). The contract:
//   1. SSRF/allowlist check FIRST (assertWebhookTargetAllowed) — a blocked target
//      returns {ok:false,error:'blocked',attempts:0} with ZERO client calls.
//   2. Merge-render the body ({{customer.*}}) exactly like an email body, and
//      decrypt any encrypted secret header value before sending.
//   3. Call the client with a per-attempt timeout; retry on ≥500 / network error
//      up to maxRetries (bounded by 1+maxRetries); NEVER retry a 4xx.
//   4. NEVER throw — return a structured outcome the caller maps to activity_log.
import { customerMerge, renderExpression, type CustomerProfile } from '@cdp/shared';
import { assertWebhookTargetAllowed, BlockedTargetError } from './ssrf.js';

/** A webhook action node's fields the executor needs (structural — no import cycle). */
export interface WebhookActionLike {
  readonly url: string;
  readonly method: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly bodyTemplate?: string;
  readonly timeoutMs?: number;
  readonly maxRetries?: number;
}

/** A single outbound HTTP request the injected client performs. */
export interface WebhookRequest {
  readonly method: string;
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body: string;
  /** Per-attempt timeout (ms) — the client aborts the request after this. */
  readonly timeoutMs: number;
}

/** The injected HTTP client. Resolves with a status; THROWS on network/timeout. */
export interface WebhookHttpClient {
  request(req: WebhookRequest): Promise<{ status: number }>;
}

/** The structured outcome of a webhook attempt sequence (mapped to activity_log). */
export interface WebhookOutcome {
  readonly ok: boolean;
  readonly status?: number;
  readonly attempts: number;
  readonly error?: string;
}

/** Options for {@link executeWebhook}. */
export interface ExecuteWebhookOptions {
  /** The per-workspace host allowlist (deny-by-default). */
  readonly allowlist: readonly string[];
  /** Decrypt an encrypted header secret at call time (never stored in plaintext). */
  readonly decryptSecret?: (envelope: string) => string;
  /** Detect an encrypted-secret envelope inside a header value. */
  readonly isEncryptedSecret?: (value: string) => boolean;
  /** Default per-attempt timeout when the node omits timeoutMs. */
  readonly defaultTimeoutMs?: number;
}

/** The fallback per-attempt timeout (ms) when neither node nor opts set one. */
export const DEFAULT_WEBHOOK_TIMEOUT_MS = 10_000;

/** Render the webhook bodyTemplate's {{customer.*}} tags from the profile (email-parity). */
export function renderWebhookBody(node: WebhookActionLike, profile: CustomerProfile): string {
  const tpl = node.bodyTemplate ?? '';
  if (tpl.length === 0) return '';
  // Delegate to the shared token engine so webhooks render IDENTICALLY to every
  // other namespace (same expansion + whitespace tolerance) and, crucially, an
  // UNKNOWN token resolves to '' rather than leaking a raw `{{token}}` over the
  // wire to a third-party endpoint.
  return renderExpression(tpl, customerMerge(profile));
}

/**
 * Resolve the headers actually sent: a value that is an encrypted-secret envelope
 * (per the injected detector) is decrypted to plaintext for the wire ONLY. An
 * envelope embedded in a larger value (e.g. `Bearer enc:TOKEN`) is replaced in
 * place. The original (encrypted) definition is never mutated.
 */
function resolveHeaders(node: WebhookActionLike, opts: ExecuteWebhookOptions): Record<string, string> {
  const out: Record<string, string> = {};
  const decrypt = opts.decryptSecret;
  const isEnc = opts.isEncryptedSecret;
  for (const [k, v] of Object.entries(node.headers ?? {})) {
    if (decrypt && isEnc) {
      // Replace any whitespace-delimited token that is an encrypted envelope.
      out[k] = v
        .split(/(\s+)/)
        .map((tok) => (tok.trim().length > 0 && isEnc(tok) ? decrypt(tok) : tok))
        .join('');
    } else {
      out[k] = v;
    }
  }
  return out;
}

/** Retry only transient failures: ≥500 status, or a thrown network/timeout error. */
function isRetryableStatus(status: number): boolean {
  return status >= 500;
}

/**
 * Execute a webhook action against the INJECTED client. Allowlist/SSRF is checked
 * first (zero client calls when blocked); then the body is rendered and the client
 * is called with bounded retries. NEVER throws — failure is isolated into the
 * returned outcome so the runner tick continues (a webhook is a notification side
 * effect, not a gate).
 */
export async function executeWebhook(
  client: WebhookHttpClient,
  node: WebhookActionLike,
  profile: CustomerProfile,
  opts: ExecuteWebhookOptions,
): Promise<WebhookOutcome> {
  // 1. Guard BEFORE any client call. A blocked target never reaches the network.
  try {
    assertWebhookTargetAllowed(node.url, opts.allowlist);
  } catch (err) {
    if (err instanceof BlockedTargetError) {
      return { ok: false, error: 'blocked', attempts: 0 };
    }
    return { ok: false, error: (err as Error).message, attempts: 0 };
  }

  const headers = resolveHeaders(node, opts);
  const body = renderWebhookBody(node, profile);
  const timeoutMs = node.timeoutMs ?? opts.defaultTimeoutMs ?? DEFAULT_WEBHOOK_TIMEOUT_MS;
  const maxRetries = Number.isInteger(node.maxRetries) && node.maxRetries! >= 0 ? node.maxRetries! : 0;

  const req: WebhookRequest = { method: node.method, url: node.url, headers, body, timeoutMs };

  let attempts = 0;
  let lastStatus: number | undefined;
  let lastError: string | undefined;
  for (let i = 0; i <= maxRetries; i += 1) {
    attempts += 1;
    try {
      const { status } = await client.request(req);
      lastStatus = status;
      lastError = undefined;
      if (status >= 200 && status < 300) {
        return { ok: true, status, attempts };
      }
      // Non-2xx: retry only transient (≥500) statuses; 4xx is deterministic.
      if (!isRetryableStatus(status) || i === maxRetries) {
        return { ok: false, status, attempts };
      }
    } catch (err) {
      lastStatus = undefined;
      lastError = (err as Error).message || 'network error';
      if (i === maxRetries) {
        return { ok: false, attempts, error: lastError };
      }
    }
  }
  // Exhausted retries on a transient status.
  const out: WebhookOutcome = { ok: false, attempts };
  return lastStatus !== undefined
    ? { ...out, status: lastStatus, ...(lastError !== undefined ? { error: lastError } : {}) }
    : { ...out, ...(lastError !== undefined ? { error: lastError } : {}) };
}
