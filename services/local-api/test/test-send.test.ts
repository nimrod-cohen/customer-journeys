import { describe, it, expect } from 'vitest';
import { findSendStep, testSendMerge, withTestPrefix } from '../src/test-send.js';

describe('test-send helpers', () => {
  it('prefixes once', () => {
    expect(withTestPrefix('Hi')).toBe('[TEST] Hi');
    expect(withTestPrefix('[TEST] Hi')).toBe('[TEST] Hi');
  });

  it('finds a send step and reads its medium', () => {
    const def = {
      nodes: {
        a: { type: 'action', kind: 'send', template_id: 'tpl' },
        b: { type: 'action', kind: 'send', medium: 'whatsapp', text_body: 'x', wa_template: { name: 'n', language: 'he', params: ['{{customer.first_name}}'] } },
        w: { type: 'wait', delay: 'P1D' },
      },
    };
    expect(findSendStep(def, 'a')).toMatchObject({ medium: 'email', templateId: 'tpl' });
    expect(findSendStep(def, 'b')).toMatchObject({ medium: 'whatsapp', waTemplate: { name: 'n', params: ['{{customer.first_name}}'] } });
    expect(findSendStep(def, 'w')).toBe('not_send');
    expect(findSendStep(def, 'zz')).toBe('missing');
    expect(findSendStep(def, 'toString')).toBe('missing');
  });

  it('merges customer over event and uses the link it is given for unsubscribe', () => {
    const url = 'https://app.test/manage-subscription?t=abc&x=1';
    const m = testSendMerge({ email: 'c@x.com', attributes: { first_name: 'Dana' } }, { order: { id: 'A1' } }, url);
    expect(m['customer.attributes.first_name']).toBe('Dana');
    expect(m['event.order.id']).toBe('A1');
    expect(m.unsubscribe_url).toBe(url);
    expect(m.unsubscribe).toBe('<a href="https://app.test/manage-subscription?t=abc&amp;x=1">Unsubscribe</a>');
    expect(testSendMerge({}, null).unsubscribe).toBe('');
  });
});
