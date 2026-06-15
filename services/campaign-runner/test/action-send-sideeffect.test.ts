import { describe, it, expect } from 'vitest';
import {
  buildCampaignDedupeKey,
  buildCampaignOutboxInsert,
  buildSetAttribute,
} from '../src/core.js';

describe('buildCampaignDedupeKey', () => {
  it('is stable per (campaign, profile, node)', () => {
    expect(buildCampaignDedupeKey('c', 'p', 'n')).toBe('campaign:c:p:n');
  });
});

describe('buildCampaignOutboxInsert', () => {
  it('sets campaign_id + a node-scoped dedupe key, ON CONFLICT DO NOTHING, ws at $1', () => {
    const q = buildCampaignOutboxInsert('ws', 'c1', 'p1', 'tpl', 'sendNode');
    expect(q.values[0]).toBe('ws');
    expect(q.values[2]).toBe('c1'); // campaign_id
    expect(q.values[3]).toBe('tpl'); // template_id
    expect(q.values[4]).toBe('campaign:c1:p1:sendNode'); // dedupe_key
    expect(q.text).toMatch(/ON CONFLICT \(dedupe_key\) DO NOTHING/);
    expect(q.text).toMatch(/campaign_id/);
  });
  it('throws on falsy workspaceId', () => {
    expect(() => buildCampaignOutboxInsert('', 'c', 'p', 't', 'n')).toThrow();
  });
});

describe('buildSetAttribute', () => {
  it('updates profiles.attributes via jsonb_set, ws at $1', () => {
    const q = buildSetAttribute('ws', 'p1', 'vip', true);
    expect(q.values[0]).toBe('ws');
    expect(q.values[1]).toBe('p1');
    expect(q.values[2]).toBe('{vip}');
    expect(q.values[3]).toBe('true');
    expect(q.text).toMatch(/jsonb_set/);
    expect(q.text).toMatch(/workspace_id = \$1/);
  });
});
