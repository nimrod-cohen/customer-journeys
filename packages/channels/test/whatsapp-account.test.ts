import { describe, it, expect } from 'vitest';
import {
  fetchWhatsAppPhoneNumber,
  subscribeAppToWaba,
  DEFAULT_META_API_VERSION,
  type GraphHttpClient,
} from '../src/index.js';

function fakeGraph(responses: Array<{ status: number; body: string }>) {
  const calls: Array<{ method: string; url: string; headers: Record<string, string>; body: string | null }> = [];
  let i = 0;
  const http: GraphHttpClient = {
    async request(method, url, headers, body) {
      calls.push({ method, url, headers, body });
      const r = responses[Math.min(i, responses.length - 1)]!;
      i++;
      return r;
    },
  };
  return { http, calls };
}

const cfg = { phoneNumberId: '1055', wabaId: '9988', accessToken: 'EAAtok' };

describe('fetchWhatsAppPhoneNumber', () => {
  it('GETs the phone number with the bearer token and maps its fields', async () => {
    const { http, calls } = fakeGraph([
      { status: 200, body: JSON.stringify({ id: '1055', display_phone_number: '+972 54-111-1111', verified_name: 'Acme', quality_rating: 'GREEN' }) },
    ]);
    const info = await fetchWhatsAppPhoneNumber(cfg, http);
    expect(info).toEqual({ displayPhoneNumber: '+972 54-111-1111', verifiedName: 'Acme', qualityRating: 'GREEN' });
    expect(calls[0]!.method).toBe('GET');
    expect(calls[0]!.url).toBe(
      `https://graph.facebook.com/${DEFAULT_META_API_VERSION}/1055?fields=display_phone_number,verified_name,quality_rating`,
    );
    expect(calls[0]!.headers.Authorization).toBe('Bearer EAAtok');
  });

  it('honors a pinned api version', async () => {
    const { http, calls } = fakeGraph([{ status: 200, body: '{}' }]);
    await fetchWhatsAppPhoneNumber({ ...cfg, apiVersion: 'v22.0' }, http);
    expect(calls[0]!.url).toContain('/v22.0/1055?');
  });

  it("throws Meta's own message on an error", async () => {
    const { http } = fakeGraph([{ status: 400, body: JSON.stringify({ error: { message: 'Invalid OAuth access token' } }) }]);
    await expect(fetchWhatsAppPhoneNumber(cfg, http)).rejects.toThrow('Invalid OAuth access token');
  });
});

describe('subscribeAppToWaba', () => {
  it('POSTs /<waba>/subscribed_apps', async () => {
    const { http, calls } = fakeGraph([{ status: 200, body: '{"success":true}' }]);
    await subscribeAppToWaba(cfg, http);
    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.url).toBe(`https://graph.facebook.com/${DEFAULT_META_API_VERSION}/9988/subscribed_apps`);
  });

  it('throws when Meta does not confirm success', async () => {
    const { http } = fakeGraph([{ status: 200, body: '{"success":false}' }]);
    await expect(subscribeAppToWaba(cfg, http)).rejects.toThrow(/subscribe/i);
  });

  it("throws Meta's message on an error", async () => {
    const { http } = fakeGraph([{ status: 403, body: JSON.stringify({ error: { message: 'missing permission' } }) }]);
    await expect(subscribeAppToWaba(cfg, http)).rejects.toThrow('missing permission');
  });
});
