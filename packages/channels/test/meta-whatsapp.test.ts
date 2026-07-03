import { describe, it, expect } from 'vitest';
import { MetaWhatsAppProvider, MockWhatsAppProvider, resolveChannelProvider, DEFAULT_META_API_VERSION } from '../src/index.js';

/** A fake HTTP client recording the request + returning scripted responses. */
function fakeClient(responses: Array<{ status: number; body: string } | Error>) {
  const calls: Array<{ url: string; headers: Record<string, string>; body: string }> = [];
  let i = 0;
  const client = {
    async post(url: string, headers: Record<string, string>, body: string) {
      calls.push({ url, headers, body });
      const r = responses[Math.min(i, responses.length - 1)];
      i++;
      if (r instanceof Error) throw r;
      return r;
    },
  };
  return { client, calls };
}

const cfg = { phoneNumberId: '123456789', accessToken: 'EAAtoken' };
const OK = { status: 200, body: JSON.stringify({ messages: [{ id: 'wamid.HBg' }] }) };

describe('MetaWhatsAppProvider (Cloud API, injected HTTP — never network)', () => {
  it('sends a TEMPLATE message: exact URL, Bearer, and type:template payload', async () => {
    const { client, calls } = fakeClient([OK]);
    const p = new MetaWhatsAppProvider(cfg, client);
    const r = await p.send({
      to: '+972529461566',
      body: '',
      template: { name: 'order_update', language: 'en_US', bodyParams: ['Ada', 'A1B2'] },
    });
    expect(r.providerMessageId).toBe('wamid.HBg');
    expect(calls[0]!.url).toBe(`https://graph.facebook.com/${DEFAULT_META_API_VERSION}/123456789/messages`);
    expect(calls[0]!.headers.Authorization).toBe('Bearer EAAtoken');
    expect(calls[0]!.headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(calls[0]!.body)).toEqual({
      messaging_product: 'whatsapp',
      to: '972529461566', // E.164 with the leading + STRIPPED (Cloud API convention)
      type: 'template',
      template: {
        name: 'order_update',
        language: { code: 'en_US' },
        components: [
          { type: 'body', parameters: [{ type: 'text', text: 'Ada' }, { type: 'text', text: 'A1B2' }] },
        ],
      },
    });
  });

  it('a template with NO params omits the components array', async () => {
    const rec = fakeClient([OK]);
    await new MetaWhatsAppProvider(cfg, rec.client).send({
      to: '+10000000000',
      body: '',
      template: { name: 'welcome', language: 'he', bodyParams: [] },
    });
    const sent = JSON.parse(rec.calls[0]!.body);
    expect(sent.template.components).toBeUndefined();
    expect(sent.template).toEqual({ name: 'welcome', language: { code: 'he' } });
  });

  it('sends a free-form TEXT message when no template is given (24h window)', async () => {
    const rec = fakeClient([OK]);
    await new MetaWhatsAppProvider(cfg, rec.client).send({ to: '+15551234567', body: 'hello there' });
    expect(JSON.parse(rec.calls[0]!.body)).toEqual({
      messaging_product: 'whatsapp',
      to: '15551234567',
      type: 'text',
      text: { preview_url: false, body: 'hello there' },
    });
  });

  it('honors a custom apiUrl + apiVersion', async () => {
    const rec = fakeClient([OK]);
    await new MetaWhatsAppProvider({ ...cfg, apiUrl: 'https://graph.example.com/', apiVersion: 'v20.0' }, rec.client).send({
      to: '+1',
      body: 'x',
    });
    expect(rec.calls[0]!.url).toBe('https://graph.example.com/v20.0/123456789/messages');
  });

  it('4xx (e.g. expired token) throws WITHOUT retry, surfacing Meta’s error message', async () => {
    const rec = fakeClient([{ status: 401, body: JSON.stringify({ error: { message: 'Session has expired' } }) }]);
    await expect(new MetaWhatsAppProvider(cfg, rec.client).send({ to: '+1', body: 'x' })).rejects.toThrow(/HTTP 401 — Session has expired/);
    expect(rec.calls).toHaveLength(1); // 4xx → NOT retried
  });

  it('retries once on a 5xx then succeeds', async () => {
    const rec = fakeClient([{ status: 503, body: 'busy' }, OK]);
    const r = await new MetaWhatsAppProvider(cfg, rec.client).send({ to: '+1', body: 'x' });
    expect(r.providerMessageId).toBe('wamid.HBg');
    expect(rec.calls).toHaveLength(2);
  });

  it('throws when the 2xx response has no message id', async () => {
    const rec = fakeClient([{ status: 200, body: JSON.stringify({ messages: [] }) }]);
    await expect(new MetaWhatsAppProvider(cfg, rec.client).send({ to: '+1', body: 'x' })).rejects.toThrow(/no message id/);
  });

  it('resolveChannelProvider returns the Meta adapter for whatsapp+meta config; mock for a mock config', () => {
    const fake = { async post() { return OK; } };
    expect(resolveChannelProvider('whatsapp', { kind: 'meta', ...cfg }, fake)).toBeInstanceOf(MetaWhatsAppProvider);
    expect(resolveChannelProvider('whatsapp', { kind: 'mock' })).toBeInstanceOf(MockWhatsAppProvider);
  });

  it('THROWS on a real cross-medium config (a meta config asked to send SMS) rather than silently mocking', () => {
    const fake = { async post() { return OK; } };
    expect(() => resolveChannelProvider('sms', { kind: 'meta', ...cfg }, fake)).toThrow(/can't send SMS/);
  });
});
