// Two fixes for mail that arrives looking broken.
//
// Both are about the gap between the designer's browser, where a template looks
// right, and a mail client, where it does not: HTML collapses the line breaks in a
// text value, and an email has no page origin to resolve `/assets/<id>` against.
import { describe, it, expect } from 'vitest';
import { renderExpressionHtml, absolutizeUrls } from '../src/expression.js';

describe('renderExpressionHtml preserves line breaks in escaped values', () => {
  const merge = { 'data.text': 'line one\nline two\n\nlast' };

  // An API caller passing a multi-line message saw it arrive as one run-on
  // paragraph, and nothing they could write in the template fixed it: the escaped
  // form collapsed the newlines and the raw form did too, since newlines are not
  // markup either.
  it('turns newlines into <br> for an escaped value', () => {
    expect(renderExpressionHtml('<div>{{data.text}}</div>', merge)).toBe(
      '<div>line one<br />line two<br /><br />last</div>',
    );
  });

  it('handles CRLF and bare CR the same way', () => {
    expect(renderExpressionHtml('{{a}}', { a: 'x\r\ny' })).toBe('x<br />y');
    expect(renderExpressionHtml('{{a}}', { a: 'x\ry' })).toBe('x<br />y');
  });

  // The triple form is for a value that IS html; it controls its own breaks.
  it('leaves a RAW value untouched', () => {
    expect(renderExpressionHtml('{{{data.text}}}', merge)).toBe('line one\nline two\n\nlast');
    expect(renderExpressionHtml('{{{h}}}', { h: '<p>a</p>\n<p>b</p>' })).toBe('<p>a</p>\n<p>b</p>');
  });

  // Line breaks must not come at the cost of the escaping that stops a profile
  // trait from becoming working markup in mail signed by the workspace's domain.
  it('still escapes markup while adding the breaks', () => {
    expect(renderExpressionHtml('{{a}}', { a: '<b>x</b>\ny' })).toBe('&lt;b&gt;x&lt;/b&gt;<br />y');
    expect(renderExpressionHtml('{{a}}', { a: '<a href="https://evil">hi</a>' })).not.toContain('<a href');
  });

  it('leaves a single-line value exactly as before', () => {
    expect(renderExpressionHtml('<p>{{a}}</p>', { a: 'plain' })).toBe('<p>plain</p>');
  });
});

describe('absolutizeUrls', () => {
  const base = 'https://journeys.on-grow.com';

  // An uploaded image is stored as `/assets/<id>`: fine in the designer's browser,
  // unreachable in a mail client, so every transactional email showed a broken
  // image.
  it('rewrites a root-relative asset src', () => {
    expect(absolutizeUrls('<img src="/assets/abc">', base)).toBe(`<img src="${base}/assets/abc">`);
  });

  it('leaves anything already resolvable alone', () => {
    const html = '<a href="https://x.com">x</a><img src="//cdn/x.png"><a href="#top">t</a><a href="mailto:a@b.com">m</a>';
    expect(absolutizeUrls(html, base)).toBe(html);
  });

  it('is idempotent, so a second pass cannot double the host', () => {
    const once = absolutizeUrls('<img src="/assets/abc">', base);
    expect(absolutizeUrls(once, base)).toBe(once);
  });

  it('does nothing without a base rather than producing a broken URL', () => {
    expect(absolutizeUrls('<img src="/assets/abc">', '')).toBe('<img src="/assets/abc">');
  });
});
