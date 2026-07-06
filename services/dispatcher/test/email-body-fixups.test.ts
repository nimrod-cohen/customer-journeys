import { describe, it, expect } from 'vitest';
import { absolutizeUrls, ensureUnsubscribeFooter } from '../src/core.js';

// Emails have no page origin, so root-relative asset/link URLs must be absolutized
// (else images 404 in the recipient's client); and every marketing email needs an
// unsubscribe link, so a design without one gets a compliant footer appended.
describe('absolutizeUrls', () => {
  const base = 'https://journeys.on-grow.com';

  it('rewrites root-relative img src to absolute', () => {
    expect(absolutizeUrls('<img src="/assets/abc">', base)).toContain(
      'src="https://journeys.on-grow.com/assets/abc"',
    );
  });

  it('rewrites href, background attribute, and CSS url()', () => {
    expect(absolutizeUrls('<a href="/foo">x</a>', base)).toContain('href="https://journeys.on-grow.com/foo"');
    expect(absolutizeUrls('<td background="/bg.png">', base)).toContain('background="https://journeys.on-grow.com/bg.png"');
    expect(absolutizeUrls('<div style="background:url(/x.png)">', base)).toContain('url(https://journeys.on-grow.com/x.png)');
  });

  it('leaves absolute / protocol-relative / data / anchor / mailto untouched', () => {
    const html =
      '<img src="https://cdn.example/a.png"><img src="//cdn/b.png"><img src="data:image/png;base64,xx"><a href="#top">t</a><a href="mailto:x@y.com">m</a>';
    expect(absolutizeUrls(html, base)).toBe(html);
  });

  it('is idempotent and normalizes a trailing slash on the base', () => {
    const once = absolutizeUrls('<img src="/assets/abc">', base + '/');
    expect(once).toContain('src="https://journeys.on-grow.com/assets/abc"');
    expect(absolutizeUrls(once, base)).toBe(once);
  });
});

describe('ensureUnsubscribeFooter', () => {
  it('appends a footer with {{unsubscribe}} before </body> when absent', () => {
    const out = ensureUnsubscribeFooter('<html><body><p>hi</p></body></html>');
    expect(out).toContain('{{unsubscribe}}');
    expect(out.indexOf('{{unsubscribe}}')).toBeLessThan(out.indexOf('</body>'));
  });

  it('appends at the end when there is no </body>', () => {
    expect(ensureUnsubscribeFooter('<p>hi</p>')).toContain('{{unsubscribe}}');
  });

  it('leaves a design that already carries the token (either form, whitespace-tolerant)', () => {
    for (const html of ['<body>{{ unsubscribe }}</body>', '<body>{{unsubscribe_url}}</body>']) {
      expect(ensureUnsubscribeFooter(html)).toBe(html);
    }
  });

  it('leaves a design that already has a rendered manage/unsubscribe link', () => {
    const html = '<body><a href="https://x/manage-subscription?t=abc">manage</a></body>';
    expect(ensureUnsubscribeFooter(html)).toBe(html);
  });
});
