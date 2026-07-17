import { describe, it, expect } from 'vitest';
import {
  buildAutomationDedupeKey,
  buildAutomationOutboxInsert,
  buildSetAttribute,
} from '../src/core.js';

describe('buildAutomationDedupeKey', () => {
  it('is stable per (automation, profile, node)', () => {
    expect(buildAutomationDedupeKey('c', 'p', 'n')).toBe('automation:c:p:n');
  });
});

describe('buildAutomationOutboxInsert', () => {
  it('sets automation_id + a node-scoped dedupe key, ON CONFLICT DO NOTHING, ws at $1', () => {
    const q = buildAutomationOutboxInsert('ws', 'c1', 'p1', 'tpl', 'sendNode');
    expect(q.values[0]).toBe('ws');
    expect(q.values[2]).toBe('c1'); // automation_id
    expect(q.values[3]).toBe('tpl'); // template_id
    expect(q.values[4]).toBe('automation:c1:p1:sendNode'); // dedupe_key
    expect(q.text).toMatch(/ON CONFLICT \(dedupe_key\) DO NOTHING/);
    expect(q.text).toMatch(/automation_id/);
  });
  it('throws on falsy workspaceId', () => {
    expect(() => buildAutomationOutboxInsert('', 'c', 'p', 't', 'n')).toThrow();
  });
});

describe('buildSetAttribute', () => {
  it('updates profiles.attributes via jsonb_set, ws at $1', () => {
    const q = buildSetAttribute('ws', 'p1', [{ key: 'vip', value: true }]);
    expect(q.values[0]).toBe('ws');
    expect(q.values[1]).toBe('p1');
    expect(q.values[2]).toBe('{vip}');
    expect(q.values[3]).toBe('true');
    expect(q.text).toMatch(/jsonb_set/);
    expect(q.text).toMatch(/workspace_id = \$1/);
  });
});
