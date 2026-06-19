// executeWebhook (§9B webhook action). Pure orchestration over an INJECTED HTTP
// client: allowlist/SSRF check FIRST, then merge-render the body, then call the
// client with a per-attempt timeout + BOUNDED retries (retry on ≥500 / network
// error, never 4xx). NEVER throws — returns a structured outcome the caller maps
// to an activity_log row. No real host is ever hit.
import { describe, it, expect, vi } from 'vitest';
import {
  executeWebhook,
  renderWebhookBody,
  type WebhookHttpClient,
  type WebhookRequest,
  type WebhookActionLike,
} from '../src/execute.js';

// The executor takes a structural webhook-action shape (no import cycle with the
// runner). We add `next` only to mirror the DSL node for readability.
type WebhookAction = WebhookActionLike & { type: 'action'; kind: 'webhook'; next: string };

const ALLOW = ['hooks.example.com'];

const profile = {
  id: 'p1',
  email: 'jane@acme.com',
  attributes: { tier: 'gold' },
};

function node(over: Partial<WebhookAction> = {}): WebhookAction {
  return {
    type: 'action',
    kind: 'webhook',
    url: 'https://hooks.example.com/abc',
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    bodyTemplate: '{"email":"{{customer.email}}","tier":"{{customer.tier}}"}',
    next: 'x',
    ...over,
  };
}

/** A scripted client recording every request and replying from a queue. */
function scriptedClient(replies: Array<{ status?: number; throw?: Error }>): {
  client: WebhookHttpClient;
  calls: WebhookRequest[];
} {
  const calls: WebhookRequest[] = [];
  let i = 0;
  const client: WebhookHttpClient = {
    async request(req) {
      calls.push(req);
      const r = replies[Math.min(i, replies.length - 1)];
      i += 1;
      if (r?.throw) throw r.throw;
      return { status: r?.status ?? 200 };
    },
  };
  return { client, calls };
}

describe('renderWebhookBody', () => {
  it('expands {{customer.*}} merge tags (incl. the attribute shorthand)', () => {
    const body = renderWebhookBody(node(), profile);
    expect(body).toBe('{"email":"jane@acme.com","tier":"gold"}');
  });
  it('returns an empty string when there is no bodyTemplate', () => {
    expect(renderWebhookBody(node({ bodyTemplate: undefined }), profile)).toBe('');
  });
});

describe('executeWebhook', () => {
  it('calls the client ONCE with method/url/headers/rendered-body on 2xx', async () => {
    const { client, calls } = scriptedClient([{ status: 200 }]);
    const out = await executeWebhook(client, node(), profile, { allowlist: ALLOW });
    expect(out).toMatchObject({ ok: true, status: 200, attempts: 1 });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      method: 'POST',
      url: 'https://hooks.example.com/abc',
    });
    expect(calls[0]!.headers).toMatchObject({ 'content-type': 'application/json' });
    expect(calls[0]!.body).toBe('{"email":"jane@acme.com","tier":"gold"}');
  });

  it('decrypts a secret header via the injected decryptSecret before sending', async () => {
    const { client, calls } = scriptedClient([{ status: 200 }]);
    const decryptSecret = vi.fn((v: string) => (v === 'enc:TOKEN' ? 'plaintext-token' : v));
    await executeWebhook(
      client,
      node({ headers: { authorization: 'Bearer enc:TOKEN' } }),
      profile,
      { allowlist: ALLOW, decryptSecret, isEncryptedSecret: (v) => v.includes('enc:') },
    );
    // The header value is sent to the client with the secret token substituted.
    expect(calls[0]!.headers.authorization).toContain('plaintext-token');
    expect(decryptSecret).toHaveBeenCalled();
  });

  it('retries a 500 up to maxRetries (1 + maxRetries total), bounded', async () => {
    const { client, calls } = scriptedClient([{ status: 500 }, { status: 500 }, { status: 500 }]);
    const out = await executeWebhook(client, node({ maxRetries: 2 }), profile, { allowlist: ALLOW });
    expect(calls).toHaveLength(3);
    expect(out).toMatchObject({ ok: false, status: 500, attempts: 3 });
  });

  it('does NOT retry when maxRetries=0', async () => {
    const { client, calls } = scriptedClient([{ status: 500 }, { status: 200 }]);
    const out = await executeWebhook(client, node({ maxRetries: 0 }), profile, { allowlist: ALLOW });
    expect(calls).toHaveLength(1);
    expect(out).toMatchObject({ ok: false, status: 500, attempts: 1 });
  });

  it('treats a thrown/timeout error like a failure, retries to the bound, never throws', async () => {
    const { client, calls } = scriptedClient([
      { throw: new Error('timeout') },
      { throw: new Error('timeout') },
    ]);
    const out = await executeWebhook(client, node({ maxRetries: 1 }), profile, { allowlist: ALLOW });
    expect(calls).toHaveLength(2);
    expect(out.ok).toBe(false);
    expect(out.attempts).toBe(2);
    expect(out.error).toContain('timeout');
  });

  it('passes timeoutMs to the client (node value, else the default)', async () => {
    const a = scriptedClient([{ status: 200 }]);
    await executeWebhook(a.client, node({ timeoutMs: 1234 }), profile, { allowlist: ALLOW });
    expect(a.calls[0]!.timeoutMs).toBe(1234);

    const b = scriptedClient([{ status: 200 }]);
    await executeWebhook(b.client, node({ timeoutMs: undefined }), profile, {
      allowlist: ALLOW,
      defaultTimeoutMs: 5000,
    });
    expect(b.calls[0]!.timeoutMs).toBe(5000);
  });

  it('retries 503 (≥500) but NOT 404 (4xx is deterministic)', async () => {
    const a = scriptedClient([{ status: 503 }, { status: 200 }]);
    const r1 = await executeWebhook(a.client, node({ maxRetries: 2 }), profile, { allowlist: ALLOW });
    expect(r1).toMatchObject({ ok: true, status: 200 });
    expect(a.calls.length).toBe(2);

    const b = scriptedClient([{ status: 404 }, { status: 200 }]);
    const r2 = await executeWebhook(b.client, node({ maxRetries: 2 }), profile, { allowlist: ALLOW });
    expect(r2).toMatchObject({ ok: false, status: 404, attempts: 1 });
    expect(b.calls.length).toBe(1);
  });

  it('a BLOCKED/off-allowlist target never calls the client; outcome {ok:false,error:blocked,attempts:0}', async () => {
    const { client, calls } = scriptedClient([{ status: 200 }]);
    const off = await executeWebhook(client, node({ url: 'https://api.evil.com/x' }), profile, {
      allowlist: ALLOW,
    });
    expect(calls).toHaveLength(0);
    expect(off).toMatchObject({ ok: false, error: 'blocked', attempts: 0 });

    const ssrf = await executeWebhook(client, node({ url: 'http://169.254.169.254/' }), profile, {
      allowlist: ['169.254.169.254'], // even if "allowlisted", the IP rule still refuses
    });
    expect(calls).toHaveLength(0);
    expect(ssrf).toMatchObject({ ok: false, error: 'blocked', attempts: 0 });
  });
});
