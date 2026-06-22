import { describe, it, expect } from 'vitest';
import { unpackSubscriptionToken } from '@cdp/email';
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
    linkTrackingBaseUrl: 'https://api.cdp.example',
  };
}

describe('buildSendEmailInput', () => {
  it('sets From from the sending identity from_domain (no named sender)', () => {
    const input = buildSendEmailInput(ctx());
    expect(input.from).toBe('no-reply@mail.acme.com');
    expect(input.to).toBe('recipient@example.com');
  });

  it('uses a named sender override as `"Name" <email>` when present', () => {
    const input = buildSendEmailInput({ ...ctx(), fromEmail: 'sales@mail.acme.com', fromName: 'Acme Sales' });
    expect(input.from).toBe('"Acme Sales" <sales@mail.acme.com>');
  });

  it('uses a bare sender email when it has no display name', () => {
    const input = buildSendEmailInput({ ...ctx(), fromEmail: 'sales@mail.acme.com', fromName: null });
    expect(input.from).toBe('sales@mail.acme.com');
  });

  it('escapes quotes in a sender display name', () => {
    const input = buildSendEmailInput({ ...ctx(), fromEmail: 's@mail.acme.com', fromName: 'A "B" C' });
    expect(input.from).toBe('"A \\"B\\" C" <s@mail.acme.com>');
  });

  it('renders the To token from the email instance (default {{customer.email}})', () => {
    const merge = { 'customer.email': 'recipient@example.com' };
    const input = buildSendEmailInput({ ...ctx(), merge, toAddress: '{{customer.email}}' });
    expect(input.to).toBe('recipient@example.com');
  });

  it('falls back to the profile email when the To token is blank', () => {
    const input = buildSendEmailInput({ ...ctx(), toAddress: '' });
    expect(input.to).toBe('recipient@example.com'); // ctx profile email
  });

  it('uses the workspace config_set as ConfigurationSetName', () => {
    expect(buildSendEmailInput(ctx()).configurationSetName).toBe('ws-1-cfgset');
  });

  it('renders the compiled template (no hand-rolled HTML)', () => {
    expect(buildSendEmailInput(ctx()).html).toBe('<html><body>Hi Ada</body></html>');
  });

  it('personalizes the SUBJECT with merge tags (like the To and body)', () => {
    const input = buildSendEmailInput({ ...ctx(), subject: 'Welcome {{first_name}}' });
    expect(input.subject).toBe('Welcome Ada');
  });

  it('resolves customer.* tokens in the subject', () => {
    const merge = { 'customer.attributes.first_name': 'Ada', first_name: 'Ada' };
    const input = buildSendEmailInput({
      ...ctx(),
      merge,
      subject: 'fourth email to {{customer.attributes.first_name}}',
    });
    expect(input.subject).toBe('fourth email to Ada');
  });

  it('leaves an unknown subject tag untouched (no crash)', () => {
    const input = buildSendEmailInput({ ...ctx(), subject: 'Hi {{customer.attributes.missing}}' });
    expect(input.subject).toBe('Hi {{customer.attributes.missing}}');
  });

  it('injects workspace-scoped List-Unsubscribe headers', () => {
    const input = buildSendEmailInput(ctx());
    expect(input.headers?.['List-Unsubscribe']).toContain('workspace_id=ws-1');
    expect(input.headers?.['List-Unsubscribe']).toContain(
      'email=recipient%40example.com',
    );
    expect(input.headers?.['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
  });

  it('carries the LEGACY signed token in the List-Unsubscribe header when present (back-compat)', () => {
    const input = buildSendEmailInput({ ...ctx(), unsubscribeToken: 'sig-xyz' });
    expect(input.headers?.['List-Unsubscribe']).toContain('token=sig-xyz');
  });

  it('emits the compact `?t=` form (no raw uuid/email) and the secret round-trips', () => {
    const wsId = 'aaaaaaaa-0000-0000-0000-000000000001';
    const secret = 'hdr-secret';
    const base = ctx();
    const input = buildSendEmailInput({
      ...base,
      workspace: { ...base.workspace, id: wsId },
      profile: { ...base.profile, email: 'recipient@example.com' },
      unsubscribeLinkSecret: secret,
    });
    const header = input.headers?.['List-Unsubscribe'] ?? '';
    const url = new URL(header.replace(/^<|>$/g, ''));
    const t = url.searchParams.get('t');
    expect(t).toBeTruthy();
    expect(url.searchParams.get('workspace_id')).toBeNull();
    expect(url.searchParams.get('email')).toBeNull();
    expect(header).not.toContain(wsId);
    expect(header).not.toContain('recipient@example.com');
    expect(unpackSubscriptionToken(secret, t)).toEqual({ workspaceId: wsId, email: 'recipient@example.com' });
  });
});
