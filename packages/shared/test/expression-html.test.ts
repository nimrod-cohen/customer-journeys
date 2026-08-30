// Merge values rendered into an HTML sink must be ESCAPED.
//
// The reason is not cosmetic. A merge map for a broadcast is built from profile
// attributes, and profile attributes are writable with the `pk_live_` key we
// document as safe to embed in a public web page — keyed by email, so the writer
// is not limited to their own profile. Unescaped, a trait of
// `<a href="https://phish.example">Update your details</a>` renders as a working
// link in mail sent from the workspace's verified, DKIM-signed domain.
//
// `{{{token}}}` is the deliberate opt-out for a value that really is a designed
// HTML block, so the escaping has something to be an exception to.
import { describe, it, expect } from 'vitest';
import {
  escapeHtmlValue,
  renderExpressionHtml,
  renderExpression,
  sanitizeHrefSchemes,
} from '../src/expression.js';

const merge = {
  'customer.first_name': 'Jane',
  'customer.attributes.tier': 'gold',
  'data.markup': '<b>hi</b>',
  'data.amp': 'Smith & Sons',
  'data.nested': 'x {{data.amp}} y',
};

describe('escapeHtmlValue', () => {
  it('escapes the five HTML-significant characters', () => {
    expect(escapeHtmlValue(`<a href="x" title='y'>&</a>`)).toBe(
      '&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;&lt;/a&gt;',
    );
  });

  // `&` has to go first: escaping it after `<` would turn the `&` of `&lt;` into
  // `&amp;lt;` and show the tag as text to the recipient.
  it('does not double-escape an ampersand', () => {
    expect(escapeHtmlValue('Smith & Sons')).toBe('Smith &amp; Sons');
    expect(escapeHtmlValue('<b>')).toBe('&lt;b&gt;');
  });
});

describe('renderExpressionHtml', () => {
  it('escapes a double-brace value', () => {
    expect(renderExpressionHtml('<p>{{data.markup}}</p>', merge)).toBe('<p>&lt;b&gt;hi&lt;/b&gt;</p>');
    expect(renderExpressionHtml('<p>{{data.amp}}</p>', merge)).toBe('<p>Smith &amp; Sons</p>');
  });

  it('writes a triple-brace value verbatim', () => {
    expect(renderExpressionHtml('<p>{{{data.markup}}}</p>', merge)).toBe('<p><b>hi</b></p>');
  });

  // Substituting raw HTML and then scanning the result for tokens would let a
  // value inject a token of its own — a self-inflicted injection. One pass only.
  it('does not re-scan a raw value for further tokens', () => {
    expect(renderExpressionHtml('{{{data.nested}}}', merge)).toBe('x {{data.amp}} y');
  });

  it('expands the customer.* shorthand in both forms', () => {
    expect(renderExpressionHtml('{{customer.tier}}', merge)).toBe('gold');
    expect(renderExpressionHtml('{{{customer.tier}}}', merge)).toBe('gold');
    expect(renderExpressionHtml('{{customer.attributes.tier}}', merge)).toBe('gold');
  });

  // The two existing callers differ deliberately and the difference is visible in
  // delivered mail, so it stays a parameter rather than being unified.
  it('honours the unknown-token behaviour of each caller', () => {
    expect(renderExpressionHtml('a{{nope}}b', merge)).toBe('ab');
    expect(renderExpressionHtml('a{{nope}}b', merge, 'keep')).toBe('a{{nope}}b');
    expect(renderExpressionHtml('a{{{nope}}}b', merge, 'keep')).toBe('a{{{nope}}}b');
  });

  it('leaves the template alone where there are no tokens', () => {
    expect(renderExpressionHtml('<p>plain &amp; already escaped</p>', merge)).toBe(
      '<p>plain &amp; already escaped</p>',
    );
  });
});

describe('renderExpression (the non-HTML sinks) is unchanged', () => {
  // Subjects, To addresses, SMS bodies and profile attribute writes all go through
  // this one. Entity-escaping any of them puts a literal `&amp;` in front of a
  // person or into the database.
  it('does not escape', () => {
    expect(renderExpression('{{data.amp}}', merge)).toBe('Smith & Sons');
    expect(renderExpression('{{data.markup}}', merge)).toBe('<b>hi</b>');
  });
});

// A token can sit INSIDE an href, where escaping buys nothing: `javascript:alert(1)`
// contains no HTML-significant character. The scheme is the only thing that decides.
describe('sanitizeHrefSchemes', () => {
  it('keeps the schemes an email legitimately uses', () => {
    const html =
      '<a href="https://acme.com">a</a><a href="http://acme.com">b</a>' +
      '<a href="mailto:a@b.com">c</a><a href="tel:+972541111111">d</a>';
    expect(sanitizeHrefSchemes(html)).toBe(html);
  });

  it('drops a javascript: href, leaving the anchor text', () => {
    expect(sanitizeHrefSchemes(`<a href="javascript:alert(1)">Click</a>`)).toBe('<a >Click</a>');
  });

  it('drops data: and vbscript: too', () => {
    expect(sanitizeHrefSchemes(`<a href='data:text/html,<script>x</script>'>x</a>`)).not.toContain('data:');
    expect(sanitizeHrefSchemes(`<a href="VBScript:msgbox">x</a>`)).not.toContain('VBScript');
  });

  // Mail clients ignore whitespace and control characters inside a scheme, so a
  // naive `startsWith('javascript:')` check misses the form that actually runs.
  it('sees through whitespace and control characters in the scheme', () => {
    expect(sanitizeHrefSchemes('<a href="java\tscript:alert(1)">x</a>')).toBe('<a >x</a>');
    expect(sanitizeHrefSchemes('<a href=" JAVASCRIPT:alert(1)">x</a>')).toBe('<a >x</a>');
  });

  it('leaves a relative or fragment href alone', () => {
    const html = '<a href="#top">t</a><a href="/page">p</a>';
    expect(sanitizeHrefSchemes(html)).toBe(html);
  });
});

// `{{unsubscribe}}` is an anchor the dispatcher builds from the recipient's signed
// token. Escaping it would print the tag as text in every marketing email, leaving
// the message with no working unsubscribe link.
describe('system-generated HTML values', () => {
  const link = '<a href="https://x/manage-subscription?t=abc">Unsubscribe</a>';

  it('writes {{unsubscribe}} verbatim', () => {
    expect(renderExpressionHtml('<p>{{unsubscribe}}</p>', { unsubscribe: link })).toBe(`<p>${link}</p>`);
  });

  // Only that key. A profile attribute of the same name lands under `customer.*`
  // and stays escaped.
  it('does not extend the trust to a same-named profile attribute', () => {
    expect(
      renderExpressionHtml('{{customer.unsubscribe}}', { 'customer.attributes.unsubscribe': link }),
    ).toContain('&lt;a href=');
  });
});
