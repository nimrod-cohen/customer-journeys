// The PRODUCTION webhook HTTP client (§9B) — a thin fetch-based implementation of
// the injected {@link WebhookHttpClient} interface, honoring the per-attempt
// timeout via AbortController. Tests NEVER use this; they inject a fake. Mirrors
// the dispatcher's injected SES client (real behind the same interface).
import type { WebhookHttpClient, WebhookRequest } from './execute.js';

/** Build a real fetch-based webhook client. A timeout aborts the request (→ throws). */
export function fetchWebhookClient(fetchImpl: typeof fetch = fetch): WebhookHttpClient {
  return {
    async request(req: WebhookRequest): Promise<{ status: number }> {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(new Error('webhook timeout')), req.timeoutMs);
      try {
        // GET/HEAD must not carry a body; omit the property entirely otherwise
        // exactOptionalPropertyTypes rejects an explicit `undefined`.
        const noBody = req.method === 'GET' || req.method === 'HEAD';
        const init: RequestInit = {
          method: req.method,
          headers: req.headers,
          signal: controller.signal,
          ...(noBody ? {} : { body: req.body }),
        };
        const res = await fetchImpl(req.url, init);
        return { status: res.status };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
