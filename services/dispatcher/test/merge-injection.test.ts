// REGRESSION: content injection into broadcast/automation email through a profile
// attribute.
//
// The attack this prevents, end to end:
//   1. Lift the `pk_live_` write key out of any customer's page — it is documented
//      as safe to embed there.
//   2. POST /v1/identify for a THIRD PARTY's email address with
//      traits: { first_name: '<a href="https://phish.example">Update your details</a>' }
//      — identify is keyed by email, so the writer is not limited to their own row.
//   3. The next broadcast that greets by first name renders that anchor verbatim,
//      sent from the workspace's verified, DKIM-signed domain.
//   4. Click tracking then rewrites the injected URL to OUR domain, so the
//      recipient's status bar shows journeys.on-grow.com.
//
// Mail clients strip <script>, so this is not XSS — it is a phishing link carrying
// the reputation of both the customer's domain and ours, which for a sending
// platform is the worse of the two.
import { describe, it, expect } from 'vitest';
import { buildSendEmailInput, type DispatchContext } from '../src/core.js';

const HOSTILE = '<a href="https://phish.example">Update your details</a>';

function ctx(over: Partial<DispatchContext> = {}): DispatchContext {
  return {
    workspace: {
      id: 'ws-1',
      status: 'active',
      sending_identity: { verified: true, from_domain: 'mail.acme.com', config_set: 'cs' },
    },
    profile: { id: 'p-1', email: 'victim@example.com' },
    template: { compiledHtml: '<html><body>Hi {{customer.first_name}}</body></html>' },
    subject: 'Hello {{customer.first_name}}',
    merge: { 'customer.first_name': HOSTILE },
    frequencyCapPerDays: 7,
    quietHours: null,
    recentSendCount: 0,
    isSuppressed: false,
    now: new Date('2026-06-10T12:00:00.000Z'),
    unsubscribeBaseUrl: 'https://api.cdp.example/unsubscribe',
    linkTrackingBaseUrl: 'https://api.cdp.example',
    ...over,
  } as DispatchContext;
}

describe('a hostile profile attribute cannot inject markup into the body', () => {
  it('renders the injected anchor as visible text, not a link', () => {
    const { html } = buildSendEmailInput(ctx());
    expect(html).not.toContain('<a href="https://phish.example">');
    expect(html).toContain('&lt;a href=&quot;https://phish.example&quot;&gt;');
  });

  it('escapes the characters that would end an attribute or open a tag', () => {
    const { html } = buildSendEmailInput(
      ctx({ merge: { 'customer.first_name': `" onmouseover="alert(1)` } }),
    );
    expect(html).not.toContain('onmouseover="alert(1)"');
    expect(html).toContain('&quot; onmouseover=&quot;alert(1)');
  });

  // An ordinary name with an ampersand is the common case, and it must come out
  // once-escaped — `&amp;amp;` would show the entity to the recipient.
  it('escapes an ordinary ampersand exactly once', () => {
    const { html } = buildSendEmailInput(ctx({ merge: { 'customer.first_name': 'Smith & Sons' } }));
    expect(html).toContain('Smith &amp; Sons');
    expect(html).not.toContain('&amp;amp;');
  });

  // The subject is plain text. Escaping it would show `&amp;` in the inbox list,
  // and there is no markup to inject into a header.
  it('leaves the subject unescaped', () => {
    const { subject } = buildSendEmailInput(ctx({ merge: { 'customer.first_name': 'Smith & Sons' } }));
    expect(subject).toBe('Hello Smith & Sons');
  });

  // The template author's own HTML is untouched — only substituted VALUES are
  // escaped, so a compiled MJML body still renders as designed.
  it('does not touch the template’s own markup', () => {
    const { html } = buildSendEmailInput(
      ctx({
        template: { compiledHtml: '<table><tr><td>Hi {{customer.first_name}} &amp; welcome</td></tr></table>' },
        merge: { 'customer.first_name': 'Ada' },
      }),
    );
    expect(html).toBe('<table><tr><td>Hi Ada &amp; welcome</td></tr></table>');
  });

  // A workspace that deliberately renders a designed HTML block asks for it.
  it('honours the triple-brace opt-out', () => {
    const { html } = buildSendEmailInput(
      ctx({
        template: { compiledHtml: '<div>{{{customer.block}}}</div>' },
        merge: { 'customer.block': '<b>on purpose</b>' },
      }),
    );
    expect(html).toBe('<div><b>on purpose</b></div>');
  });

  it('still leaves an unknown token in place, as it always has', () => {
    const { html } = buildSendEmailInput(
      ctx({ template: { compiledHtml: '<p>{{customer.nope}}</p>' }, merge: {} }),
    );
    expect(html).toBe('<p>{{customer.nope}}</p>');
  });

  // Escaping does nothing for a value that IS a URL: `javascript:alert(1)` has no
  // HTML-significant character in it.
  it('drops a javascript: URL substituted into an href', () => {
    const { html } = buildSendEmailInput(
      ctx({
        template: { compiledHtml: '<a href="{{customer.link}}">Click</a>' },
        merge: { 'customer.link': 'javascript:alert(1)' },
      }),
    );
    expect(html).not.toContain('javascript:');
    expect(html).toContain('Click');
  });

  it('keeps a legitimate https link substituted into an href', () => {
    const { html } = buildSendEmailInput(
      ctx({
        template: { compiledHtml: '<a href="{{customer.link}}">Click</a>' },
        merge: { 'customer.link': 'https://acme.com/x?a=1&b=2' },
      }),
    );
    // Escaped for the attribute context, which is what a mail client un-escapes.
    expect(html).toContain('href="https://acme.com/x?a=1&amp;b=2"');
  });
});
