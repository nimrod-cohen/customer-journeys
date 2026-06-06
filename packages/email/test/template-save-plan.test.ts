import { describe, it, expect } from 'vitest';
import { buildTemplateUpsert } from '../src/template.js';
import { compileMjml } from '../src/mjml.js';
import { canSend } from '../src/can-send.js';

const wsA = 'aaaaaaaa-1111-0000-0000-000000000001';

describe('buildTemplateUpsert', () => {
  it('binds workspace_id at $1 and stores mjml + compiled_html', () => {
    const stmt = buildTemplateUpsert(wsA, 'welcome', '<mjml/>', '<html/>');
    expect(stmt.values[0]).toBe(wsA);
    expect(stmt.values).toEqual([wsA, 'welcome', '<mjml/>', '<html/>']);
    expect(stmt.text).toMatch(/workspace_id = \$1/);
    expect(stmt.text.toLowerCase()).toContain('email_templates');
  });

  it('is idempotent on (workspace_id, name): updates in place, inserts only when absent', () => {
    const stmt = buildTemplateUpsert(wsA, 'welcome', '<mjml/>', '<html/>');
    // UPDATE-then-INSERT-if-absent (no duplicate row on repeated save).
    expect(stmt.text).toMatch(/UPDATE email_templates/i);
    expect(stmt.text).toMatch(/NOT EXISTS/i);
  });

  it('throws without workspace id / name (guards)', () => {
    expect(() => buildTemplateUpsert('', 'n', 'm', 'h')).toThrow(/workspaceId/);
    expect(() => buildTemplateUpsert(wsA, '', 'm', 'h')).toThrow(/name/);
  });

  it('save path: compile MJML then build the upsert with both forms', () => {
    const mjml = `<mjml><mj-body><mj-section><mj-column><mj-text>Hi</mj-text></mj-column></mj-section></mj-body></mjml>`;
    const html = compileMjml(mjml);
    const stmt = buildTemplateUpsert(wsA, 't1', mjml, html);
    expect(stmt.values[2]).toBe(mjml);
    expect(stmt.values[3]).toBe(html);
    expect(String(stmt.values[3])).toContain('<html');
  });
});

describe('canSend (send-gate predicate, §10)', () => {
  it('true only when active AND verified', () => {
    expect(canSend({ status: 'active', sending_identity: { verified: true } })).toBe(true);
  });
  it('false when not active even if verified', () => {
    expect(canSend({ status: 'onboarding', sending_identity: { verified: true } })).toBe(false);
    expect(canSend({ status: 'suspended', sending_identity: { verified: true } })).toBe(false);
  });
  it('false when active but not verified / missing identity', () => {
    expect(canSend({ status: 'active', sending_identity: { verified: false } })).toBe(false);
    expect(canSend({ status: 'active', sending_identity: {} })).toBe(false);
    expect(canSend({ status: 'active', sending_identity: null })).toBe(false);
    expect(canSend({ status: 'active', sending_identity: undefined })).toBe(false);
  });
});
