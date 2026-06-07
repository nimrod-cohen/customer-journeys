// The apiClient sends the Bearer token (which carries the active workspace_id)
// and NEVER puts workspace_id in a request body (§13, CLAUDE.md inv.2). We stub
// fetch and assert the headers + that a workspace_id body is rejected outright.
import { describe, it, expect, vi } from 'vitest';
import { createApiClient, assertNoWorkspaceIdInBody } from '../src/api/client.js';

function fakeFetch(captured: { url?: string; init?: RequestInit }) {
  return vi.fn(async (url: string, init?: RequestInit) => {
    captured.url = url;
    if (init) captured.init = init;
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
}

describe('typed apiClient', () => {
  it('attaches the Bearer token from the provider', async () => {
    const cap: { init?: RequestInit } = {};
    const client = createApiClient({
      getToken: () => 'tok-123',
      base: 'http://api.test',
      fetchImpl: fakeFetch(cap),
    });
    await client.get('/me');
    const headers = cap.init?.headers as Record<string, string>;
    expect(headers['authorization']).toBe('Bearer tok-123');
  });

  it('does NOT send an Authorization header when logged out', async () => {
    const cap: { init?: RequestInit } = {};
    const client = createApiClient({
      getToken: () => null,
      base: 'http://api.test',
      fetchImpl: fakeFetch(cap),
    });
    await client.get('/me');
    const headers = (cap.init?.headers as Record<string, string>) ?? {};
    expect(headers['authorization']).toBeUndefined();
  });

  it('REJECTS any request body containing workspace_id (tenancy invariant)', async () => {
    const client = createApiClient({
      getToken: () => 'tok',
      base: 'http://api.test',
      fetchImpl: fakeFetch({}),
    });
    await expect(
      client.post('/segments', { body: { name: 'x', workspace_id: 'sneaky' } }),
    ).rejects.toThrow(/workspace_id/);
  });

  it('the standalone guard throws on a workspace_id body', () => {
    expect(() => assertNoWorkspaceIdInBody({ workspace_id: 'x' })).toThrow();
    expect(() => assertNoWorkspaceIdInBody({ name: 'x' })).not.toThrow();
  });

  it('serializes a JSON body and sets content-type for writes', async () => {
    const cap: { init?: RequestInit } = {};
    const client = createApiClient({
      getToken: () => 'tok',
      base: 'http://api.test',
      fetchImpl: fakeFetch(cap),
    });
    await client.post('/segments', { body: { name: 'vip' } });
    expect(cap.init?.method).toBe('POST');
    expect(JSON.parse(cap.init?.body as string)).toEqual({ name: 'vip' });
    expect((cap.init?.headers as Record<string, string>)['content-type']).toBe('application/json');
  });

  it('throws a typed ApiError on non-2xx', async () => {
    const client = createApiClient({
      getToken: () => 'tok',
      base: 'http://api.test',
      fetchImpl: vi.fn(async () =>
        new Response(JSON.stringify({ error: 'forbidden: requires view_billing' }), {
          status: 403,
        }),
      ) as unknown as typeof fetch,
    });
    await expect(client.get('/billing/usage')).rejects.toMatchObject({ status: 403 });
  });
});
