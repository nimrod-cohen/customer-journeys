// Unit (§9B phase 6 regression guard): with the phase-5 'placeholder' template_id
// removed, a freshly-inserted SEND node has no/empty template_id. The PUBLISH gate
// (collectSendNodeEnvelopeGaps) must treat that as "needs a sender" (nothing
// configured yet) and order per-node gaps sender→to→subject in BFS order.
import { describe, it, expect } from 'vitest';
import { collectSendNodeEnvelopeGaps, type CampaignDefinition } from '@cdp/service-campaign-runner';

describe('collectSendNodeEnvelopeGaps — removed-placeholder + ordering', () => {
  it("reports 'sender' for a send node with NO template_id (not-yet-attached email)", () => {
    const def: CampaignDefinition = {
      startNode: 't',
      nodes: {
        t: { type: 'trigger', kind: 'manual', next: 's' },
        s: { type: 'action', kind: 'send', next: 'x' }, // NO template_id (placeholder removed)
        x: { type: 'exit' },
      },
    } as unknown as CampaignDefinition;
    const gaps = collectSendNodeEnvelopeGaps(def, {});
    expect(gaps).toEqual([{ nodeId: 's', missing: 'sender' }]);
  });

  it("reports 'sender' for a send node whose template_id has an EMPTY envelope entry", () => {
    const def: CampaignDefinition = {
      startNode: 't',
      nodes: {
        t: { type: 'trigger', kind: 'manual', next: 's' },
        s: { type: 'action', kind: 'send', template_id: 'tpl', next: 'x' },
        x: { type: 'exit' },
      },
    } as unknown as CampaignDefinition;
    const gaps = collectSendNodeEnvelopeGaps(def, { tpl: { sender_id: null, to_address: null, subject: null } });
    expect(gaps).toEqual([{ nodeId: 's', missing: 'sender' }]);
  });

  it('orders gaps sender→to→subject and reports per send node in BFS order', () => {
    const def: CampaignDefinition = {
      startNode: 't',
      nodes: {
        t: { type: 'trigger', kind: 'manual', next: 's1' },
        s1: { type: 'action', kind: 'send', template_id: 'a', next: 's2' }, // missing 'to'
        s2: { type: 'action', kind: 'send', template_id: 'b', next: 's3' }, // missing 'subject'
        s3: { type: 'action', kind: 'send', next: 'x' }, // unattached → 'sender'
        x: { type: 'exit' },
      },
    } as unknown as CampaignDefinition;
    const gaps = collectSendNodeEnvelopeGaps(def, {
      a: { sender_id: 'snd', to_address: '', subject: 'Hi' },
      b: { sender_id: 'snd', to_address: '{{customer.email}}', subject: '' },
    });
    expect(gaps).toEqual([
      { nodeId: 's1', missing: 'to' },
      { nodeId: 's2', missing: 'subject' },
      { nodeId: 's3', missing: 'sender' },
    ]);
  });
});
