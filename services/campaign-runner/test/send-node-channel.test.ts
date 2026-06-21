// MULTI-CHANNEL campaign SEND node (v0.54.0). A send action node may carry a
// `medium` ('email' | 'sms' | 'whatsapp', default 'email'). An EMAIL send is
// validated/gated exactly as before (template/envelope at publish). An SMS or
// WhatsApp send requires a non-blank `text_body` (merge-tag enabled, plain text —
// no template). The publish-gap collector skips the email envelope for a text
// send node and gates on `text_body` present ('body' gap) naming the node.
import { describe, it, expect } from 'vitest';
import {
  validateCampaignDefinition,
  collectSendNodeEnvelopeGaps,
  type CampaignDefinition,
} from '../src/dsl.js';

function defWith(send: Record<string, unknown>): CampaignDefinition {
  return {
    startNode: 't',
    nodes: {
      t: { type: 'trigger', kind: 'manual', next: 's' },
      s: { type: 'action', kind: 'send', next: 'x', ...send } as never,
      x: { type: 'exit' },
    },
  };
}

describe('validateCampaignDefinition — channel send nodes', () => {
  it('accepts an email send with no medium (back-compat) and an explicit medium=email', () => {
    expect(() => validateCampaignDefinition(defWith({ template_id: 'tpl-1' }))).not.toThrow();
    expect(() => validateCampaignDefinition(defWith({ medium: 'email', template_id: 'tpl-1' }))).not.toThrow();
    // An email send with no template is a valid DRAFT (publish gate blocks activation).
    expect(() => validateCampaignDefinition(defWith({ medium: 'email' }))).not.toThrow();
  });

  it('rejects an unknown medium', () => {
    expect(() => validateCampaignDefinition(defWith({ medium: 'carrier-pigeon' }))).toThrow(/medium/i);
  });

  it('accepts an sms/whatsapp send WITH a non-blank text_body', () => {
    expect(() => validateCampaignDefinition(defWith({ medium: 'sms', text_body: 'Hi {{customer.first_name}}' }))).not.toThrow();
    expect(() => validateCampaignDefinition(defWith({ medium: 'whatsapp', text_body: 'Hello' }))).not.toThrow();
  });

  it('rejects an sms/whatsapp send with a MISSING or BLANK text_body', () => {
    expect(() => validateCampaignDefinition(defWith({ medium: 'sms' }))).toThrow(/text_body/i);
    expect(() => validateCampaignDefinition(defWith({ medium: 'whatsapp', text_body: '   ' }))).toThrow(/text_body/i);
    expect(() => validateCampaignDefinition(defWith({ medium: 'sms', text_body: 42 }))).toThrow(/text_body/i);
  });
});

describe('collectSendNodeEnvelopeGaps — channel-aware', () => {
  it('an EMAIL send node still reports envelope gaps (sender first)', () => {
    const def = defWith({ medium: 'email', template_id: 'tpl' });
    const gaps = collectSendNodeEnvelopeGaps(def, { tpl: { sender_id: null, to_address: null, subject: null } });
    expect(gaps).toEqual([{ nodeId: 's', missing: 'sender' }]);
  });

  it('a TEXT send node with a body reports NO gap (envelope/domain skipped)', () => {
    const def = defWith({ medium: 'sms', text_body: 'Hi there' });
    expect(collectSendNodeEnvelopeGaps(def, {})).toEqual([]);
  });

  it('a TEXT send node with a BLANK body reports a "body" gap naming the node', () => {
    const blank = defWith({ medium: 'sms', text_body: '   ' });
    expect(collectSendNodeEnvelopeGaps(blank, {})).toEqual([{ nodeId: 's', missing: 'body' }]);
    const missing = defWith({ medium: 'whatsapp' });
    expect(collectSendNodeEnvelopeGaps(missing, {})).toEqual([{ nodeId: 's', missing: 'body' }]);
  });
});
