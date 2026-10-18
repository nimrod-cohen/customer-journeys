import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import { classifyWhatsAppWebhook, verifyMetaSignature, statusRank } from '../src/index.js';

const SECRET = 'app-secret';
const sign = (body: string, secret = SECRET) => 'sha256=' + createHmac('sha256', secret).update(body).digest('hex');

describe('verifyMetaSignature', () => {
  const body = '{"object":"whatsapp_business_account"}';
  it('accepts the HMAC-SHA256 of the RAW body', () => {
    expect(verifyMetaSignature(body, sign(body), SECRET)).toBe(true);
  });
  it('rejects a missing, malformed, wrong-secret or tampered signature', () => {
    expect(verifyMetaSignature(body, undefined, SECRET)).toBe(false);
    expect(verifyMetaSignature(body, 'sha1=abc', SECRET)).toBe(false);
    expect(verifyMetaSignature(body, 'sha256=zz', SECRET)).toBe(false);
    expect(verifyMetaSignature(body, sign(body, 'other'), SECRET)).toBe(false);
    expect(verifyMetaSignature(body + ' ', sign(body), SECRET)).toBe(false);
  });
  it('a re-serialized body does not verify (must be the bytes Meta sent)', () => {
    const raw = '{ "object" : "whatsapp_business_account" }';
    expect(verifyMetaSignature(JSON.stringify(JSON.parse(raw)), sign(raw), SECRET)).toBe(false);
  });
  it('an empty secret never verifies', () => {
    expect(verifyMetaSignature(body, sign(body, ''), '')).toBe(false);
  });
});

const envelope = (value: Record<string, unknown>) => ({
  object: 'whatsapp_business_account',
  entry: [{ id: 'WABA', changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', metadata: { display_phone_number: '15550001', phone_number_id: 'PN1' }, ...value } }] }],
});

describe('classifyWhatsAppWebhook — messages', () => {
  it('maps a text message with the contact name', () => {
    const r = classifyWhatsAppWebhook(
      envelope({
        contacts: [{ profile: { name: 'Dana' }, wa_id: '972541111111' }],
        messages: [{ from: '972541111111', id: 'wamid.A', timestamp: '1760000000', type: 'text', text: { body: 'hi there' } }],
      }),
    );
    expect(r.statuses).toEqual([]);
    expect(r.messages).toEqual([
      {
        phoneNumberId: 'PN1',
        from: '+972541111111',
        contactName: 'Dana',
        wamid: 'wamid.A',
        timestamp: new Date(1760000000 * 1000),
        type: 'text',
        body: 'hi there',
        media: null,
        replyTo: null,
      },
    ]);
  });

  it('maps media with caption, documents with filename, and the reply context', () => {
    const r = classifyWhatsAppWebhook(
      envelope({
        messages: [
          { from: '1', id: 'w1', timestamp: '1', type: 'image', image: { id: 'MEDIA1', mime_type: 'image/jpeg', sha256: 'h', caption: 'look' }, context: { id: 'wamid.prev' } },
          { from: '1', id: 'w2', timestamp: '1', type: 'document', document: { id: 'MEDIA2', mime_type: 'application/pdf', filename: 'inv.pdf' } },
          { from: '1', id: 'w3', timestamp: '1', type: 'audio', audio: { id: 'MEDIA3', mime_type: 'audio/ogg' } },
        ],
      }),
    );
    expect(r.messages[0]).toMatchObject({ type: 'image', body: 'look', media: { mediaId: 'MEDIA1', mimeType: 'image/jpeg', filename: null, sha256: 'h' }, replyTo: 'wamid.prev' });
    expect(r.messages[1]).toMatchObject({ type: 'document', body: null, media: { mediaId: 'MEDIA2', filename: 'inv.pdf' } });
    expect(r.messages[2]).toMatchObject({ type: 'audio', media: { mediaId: 'MEDIA3' } });
  });

  it('summarizes location, reaction, button, interactive replies and unsupported types', () => {
    const r = classifyWhatsAppWebhook(
      envelope({
        messages: [
          { from: '1', id: 'l', timestamp: '1', type: 'location', location: { latitude: 32.1, longitude: 34.8, name: 'Office' } },
          { from: '1', id: 'r', timestamp: '1', type: 'reaction', reaction: { message_id: 'wamid.X', emoji: '👍' } },
          { from: '1', id: 'b', timestamp: '1', type: 'button', button: { text: 'Yes please', payload: 'YES' } },
          { from: '1', id: 'i', timestamp: '1', type: 'interactive', interactive: { type: 'list_reply', list_reply: { id: 'o2', title: 'Option 2' } } },
          { from: '1', id: 'u', timestamp: '1', type: 'unsupported', errors: [{ code: 131051 }] },
        ],
      }),
    );
    expect(r.messages.map((m) => [m.type, m.body, m.replyTo])).toEqual([
      ['location', 'Office (32.1, 34.8)', null],
      ['reaction', '👍', 'wamid.X'],
      ['button', 'Yes please', null],
      ['interactive', 'Option 2', null],
      ['unsupported', null, null],
    ]);
  });

  it('drops a message without an id or sender, and ignores non-message fields', () => {
    const r = classifyWhatsAppWebhook({
      object: 'whatsapp_business_account',
      entry: [
        { id: 'W', changes: [{ field: 'account_update', value: { phone_number: 'x' } }] },
        { id: 'W', changes: [{ field: 'messages', value: { metadata: { phone_number_id: 'PN1' }, messages: [{ type: 'text' }] } }] },
      ],
    });
    expect(r).toEqual({ messages: [], statuses: [] });
  });

  it('never throws on garbage', () => {
    for (const junk of [null, 1, 'x', [], {}, { entry: 'no' }, { entry: [{ changes: [null] }] }]) {
      expect(classifyWhatsAppWebhook(junk)).toEqual({ messages: [], statuses: [] });
    }
  });

  it('a change without a phone number id is dropped (it cannot be routed)', () => {
    const p = envelope({ messages: [{ from: '1', id: 'w', timestamp: '1', type: 'text', text: { body: 'x' } }] });
    (p.entry[0]!.changes[0]!.value as { metadata: unknown }).metadata = {};
    expect(classifyWhatsAppWebhook(p).messages).toEqual([]);
  });
});

describe('classifyWhatsAppWebhook — statuses', () => {
  it('maps delivery statuses and the first error', () => {
    const r = classifyWhatsAppWebhook(
      envelope({
        statuses: [
          { id: 'wamid.S', status: 'delivered', timestamp: '1760000001', recipient_id: '972541111111' },
          { id: 'wamid.F', status: 'failed', timestamp: '1760000002', recipient_id: '1', errors: [{ code: 131026, title: 'Message undeliverable', message: 'Message undeliverable' }] },
          { id: 'wamid.Q', status: 'weird', timestamp: '1' },
        ],
      }),
    );
    expect(r.statuses).toEqual([
      { phoneNumberId: 'PN1', wamid: 'wamid.S', status: 'delivered', timestamp: new Date(1760000001000), recipient: '+972541111111', error: null },
      { phoneNumberId: 'PN1', wamid: 'wamid.F', status: 'failed', timestamp: new Date(1760000002000), recipient: '+1', error: { code: 131026, title: 'Message undeliverable', message: 'Message undeliverable' } },
    ]);
  });
});

describe('statusRank', () => {
  it('only moves forward; failed outranks everything', () => {
    expect(statusRank('read')).toBeGreaterThan(statusRank('delivered'));
    expect(statusRank('delivered')).toBeGreaterThan(statusRank('sent'));
    expect(statusRank('failed')).toBeGreaterThan(statusRank('read'));
  });
});
