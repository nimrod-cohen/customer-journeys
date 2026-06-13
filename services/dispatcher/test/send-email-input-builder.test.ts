import { describe, it, expect } from 'vitest';
import {
  renderTemplateBody,
  buildSendEmailInput,
  type DispatchContext,
} from '../src/core.js';

// §9 step 5/6 — render the compiled template with merge values (no hand-rolled
// HTML) and build the SendEmailInput: ConfigurationSetName from the workspace
// sending_identity.config_set, From from the sending identity, and the RFC 8058
// List-Unsubscribe headers (workspace-scoped, never cross-tenant).
describe('renderTemplateBody', () => {
  it('substitutes {{merge}} tags from the compiled HTML', () => {
    const html = '<html><body>Hi {{first_name}}, code {{code}}</body></html>';
    const out = renderTemplateBody(html, { first_name: 'Ada', code: 'X9' });
    expect(out).toBe('<html><body>Hi Ada, code X9</body></html>');
  });

  it('tolerates whitespace inside the braces', () => {
    const out = renderTemplateBody('Hi {{ first_name }}', { first_name: 'Ada' });
    expect(out).toBe('Hi Ada');
  });

  it('leaves unknown tags untouched and HTML otherwise intact', () => {
    const html = '<html>{{unknown}} kept</html>';
    expect(renderTemplateBody(html, {})).toBe('<html>{{unknown}} kept</html>');
  });

  it('resolves the customer.* shorthand to the same value as the full path (§11)', () => {
    // Merge is keyed by the canonical token (as customerMerge builds it).
    const merge = { 'customer.attributes.tier': 'Gold', 'customer.email': 'a@b.com' };
    expect(renderTemplateBody('Tier: {{customer.tier}}', merge)).toBe('Tier: Gold');
    expect(renderTemplateBody('Tier: {{customer.attributes.tier}}', merge)).toBe('Tier: Gold');
    expect(renderTemplateBody('To {{ customer.email }}', merge)).toBe('To a@b.com');
  });
});

function ctx(): DispatchContext {
  return {
    workspace: {
      id: 'ws-1',
      status: 'active',
      sending_identity: {
        verified: true,
        from_domain: 'mail.acme.com',
        config_set: 'ws-1-cfgset',
      },
    },
    profile: { id: 'p-1', email: 'recipient@example.com' },
    template: { compiledHtml: '<html><body>Hi {{first_name}}</body></html>' },
    subject: 'Welcome',
    merge: { first_name: 'Ada' },
    frequencyCapPerDays: 7,
    quietHours: null,
    recentSendCount: 0,
    isSuppressed: false,
    now: new Date('2026-06-10T12:00:00.000Z'),
    unsubscribeBaseUrl: 'https://api.cdp.example/unsubscribe',
  };
}

describe('buildSendEmailInput', () => {
  it('sets From from the sending identity from_domain', () => {
    const input = buildSendEmailInput(ctx());
    expect(input.from).toContain('@mail.acme.com');
    expect(input.to).toBe('recipient@example.com');
  });

  it('uses the workspace config_set as ConfigurationSetName', () => {
    expect(buildSendEmailInput(ctx()).configurationSetName).toBe('ws-1-cfgset');
  });

  it('renders the compiled template (no hand-rolled HTML)', () => {
    expect(buildSendEmailInput(ctx()).html).toBe('<html><body>Hi Ada</body></html>');
  });

  it('injects workspace-scoped List-Unsubscribe headers', () => {
    const input = buildSendEmailInput(ctx());
    expect(input.headers?.['List-Unsubscribe']).toContain('workspace_id=ws-1');
    expect(input.headers?.['List-Unsubscribe']).toContain(
      'email=recipient%40example.com',
    );
    expect(input.headers?.['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
  });
});
