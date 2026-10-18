import { describe, it, expect } from 'vitest';
import {
  fetchWhatsAppPhoneNumber,
  subscribeAppToWaba,
  downloadWhatsAppMedia,
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

describe('downloadWhatsAppMedia', () => {
  const bin = (status = 200, body = Buffer.from('JPEGDATA')) => {
    const calls: Array<{ url: string; headers: Record<string, string> }> = [];
    return {
      calls,
      http: { async get(url: string, headers: Record<string, string>) { calls.push({ url, headers }); return { status, body, contentType: 'image/jpeg' }; } },
    };
  };

  it('looks the media up, then downloads the URL with the bearer token', async () => {
    const { http: graph, calls } = fakeGraph([{ status: 200, body: JSON.stringify({ url: 'https://lookaside.fb/x', mime_type: 'image/jpeg', file_size: 8 }) }]);
    const b = bin();
    const r = await downloadWhatsAppMedia({ accessToken: 'EAAtok' }, 'MEDIA1', graph, b.http);
    expect(calls[0]!.url).toBe(`https://graph.facebook.com/${DEFAULT_META_API_VERSION}/MEDIA1`);
    expect(b.calls[0]).toEqual({ url: 'https://lookaside.fb/x', headers: { Authorization: 'Bearer EAAtok' } });
    expect(r).toEqual({ bytes: Buffer.from('JPEGDATA'), mimeType: 'image/jpeg' });
  });

  it('refuses media over the cap BEFORE downloading it', async () => {
    const { http: graph } = fakeGraph([{ status: 200, body: JSON.stringify({ url: 'https://x', file_size: 999 }) }]);
    const b = bin();
    await expect(downloadWhatsAppMedia({ accessToken: 't' }, 'M', graph, b.http, 100)).rejects.toThrow(/too large/);
    expect(b.calls).toHaveLength(0);
  });

  it("surfaces Meta's error and a failed download", async () => {
    const bad = fakeGraph([{ status: 404, body: JSON.stringify({ error: { message: 'media not found' } }) }]);
    await expect(downloadWhatsAppMedia({ accessToken: 't' }, 'M', bad.http, bin().http)).rejects.toThrow('media not found');
    const ok = fakeGraph([{ status: 200, body: JSON.stringify({ url: 'https://x' }) }]);
    await expect(downloadWhatsAppMedia({ accessToken: 't' }, 'M', ok.http, bin(403).http)).rejects.toThrow('HTTP 403');
  });
});
