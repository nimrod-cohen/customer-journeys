import { describe, it, expect } from 'vitest';
import {
  listWhatsAppTemplates,
  createWhatsAppTemplate,
  deleteWhatsAppTemplate,
  buildCreateTemplateBody,
  countTemplateVariables,
  parseTemplatesList,
  DEFAULT_META_API_VERSION,
  type GraphHttpClient,
} from '../src/index.js';

/** A fake Graph client recording each request + returning scripted responses. */
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

const cfg = { wabaId: '999888', accessToken: 'EAAtok' };

describe('countTemplateVariables', () => {
  it('counts distinct {{n}} placeholders', () => {
    expect(countTemplateVariables('Hi {{1}}, order {{2}} — {{1}} again')).toBe(2);
    expect(countTemplateVariables('no vars')).toBe(0);
  });
});

describe('parseTemplatesList', () => {
  it('summarizes name/language/status/category + BODY text + variable count', () => {
    const body = JSON.stringify({
      data: [
        {
          id: 't1',
          name: 'order_update',
          language: 'en_US',
          status: 'APPROVED',
          category: 'MARKETING',
          components: [{ type: 'HEADER', text: 'hi' }, { type: 'BODY', text: 'Hi {{1}}, order {{2}}.' }],
        },
        { id: 't2', name: 'welcome', language: 'he', status: 'PENDING', category: 'UTILITY', components: [] },
      ],
    });
    expect(parseTemplatesList(body)).toEqual([
      { id: 't1', name: 'order_update', language: 'en_US', status: 'APPROVED', category: 'MARKETING', body: 'Hi {{1}}, order {{2}}.', variableCount: 2 },
      { id: 't2', name: 'welcome', language: 'he', status: 'PENDING', category: 'UTILITY', body: '', variableCount: 0 },
    ]);
  });
  it('returns [] for non-JSON', () => {
    expect(parseTemplatesList('oops')).toEqual([]);
  });
});

describe('buildCreateTemplateBody', () => {
  it('builds a BODY component with an example row per variable', () => {
    const body = buildCreateTemplateBody({ name: 'order_update', language: 'en_US', category: 'MARKETING', body: 'Hi {{1}}, code {{2}}', examples: ['Ada', 'A1B2'] });
    expect(JSON.parse(body)).toEqual({
      name: 'order_update',
      language: 'en_US',
      category: 'MARKETING',
      components: [{ type: 'BODY', text: 'Hi {{1}}, code {{2}}', example: { body_text: [['Ada', 'A1B2']] } }],
    });
  });
  it('pads missing examples and omits the example when there are no variables', () => {
    const withPad = JSON.parse(buildCreateTemplateBody({ name: 'x', language: 'en', category: 'UTILITY', body: '{{1}} {{2}}', examples: ['only'] }));
    expect(withPad.components[0].example.body_text).toEqual([['only', 'example']]);
    const noVars = JSON.parse(buildCreateTemplateBody({ name: 'x', language: 'en', category: 'UTILITY', body: 'no vars', examples: [] }));
    expect(noVars.components[0].example).toBeUndefined();
  });
});

describe('Graph API calls (injected client — never network)', () => {
  it('list hits GET /<version>/<waba>/message_templates with the Bearer + parses', async () => {
    const { http, calls } = fakeGraph([{ status: 200, body: JSON.stringify({ data: [{ id: 't', name: 'n', language: 'en', status: 'APPROVED', category: 'MARKETING', components: [{ type: 'BODY', text: 'Hi {{1}}' }] }] }) }]);
    const out = await listWhatsAppTemplates(cfg, http);
    expect(calls[0]!.method).toBe('GET');
    expect(calls[0]!.url).toBe(`https://graph.facebook.com/${DEFAULT_META_API_VERSION}/999888/message_templates?limit=200`);
    expect(calls[0]!.headers.Authorization).toBe('Bearer EAAtok');
    expect(out[0]!.variableCount).toBe(1);
  });

  it('create POSTs the built body and returns id + status', async () => {
    const { http, calls } = fakeGraph([{ status: 200, body: JSON.stringify({ id: 'NEW', status: 'PENDING', category: 'MARKETING' }) }]);
    const r = await createWhatsAppTemplate(cfg, { name: 'order_update', language: 'en_US', category: 'MARKETING', body: 'Hi {{1}}', examples: ['Ada'] }, http);
    expect(calls[0]!.method).toBe('POST');
    expect(JSON.parse(calls[0]!.body!).name).toBe('order_update');
    expect(r).toEqual({ id: 'NEW', status: 'PENDING', category: 'MARKETING' });
  });

  it('delete hits DELETE …?name=<name>', async () => {
    const { http, calls } = fakeGraph([{ status: 200, body: JSON.stringify({ success: true }) }]);
    await deleteWhatsAppTemplate(cfg, 'order_update', http);
    expect(calls[0]!.method).toBe('DELETE');
    expect(calls[0]!.url).toContain('message_templates?name=order_update');
  });

  it('a Graph error surfaces Meta’s message', async () => {
    const { http } = fakeGraph([{ status: 400, body: JSON.stringify({ error: { message: 'Invalid parameter' } }) }]);
    await expect(listWhatsAppTemplates(cfg, http)).rejects.toThrow(/Invalid parameter/);
  });
});
