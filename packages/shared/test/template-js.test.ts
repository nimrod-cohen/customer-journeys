// `{{ return … }}` — JavaScript inside merge braces, in every message text.
//
// The renderers (isomorphic) only RECOGNISE the block and hand its code to an
// injected runner; the runner (`@cdp/shared/js-sandbox`, Node-only) evaluates it in
// the same empty-context, time-limited vm sandbox as update-profile JS values.
import { describe, it, expect } from 'vitest';
import { renderExpression, renderExpressionHtml, decodeHtmlCode } from '../src/expression.js';
import { makeTemplateJs, runSandboxedJs, customerJsObject, varsFromMerge } from '../src/js-sandbox.js';

const js = makeTemplateJs({
  customer: customerJsObject({ email: 'd@x.com', attributes: { first_name: 'Dana', tier: 3 } }),
  event: { items: [{ sku: 'A' }, { sku: 'B' }], total: 250 },
  journey: {},
  data: { code: '42' },
});

describe('{{ return … }} in the plain-text renderer (subjects, SMS)', () => {
  it('runs the code against customer / event / data', () => {
    expect(renderExpression('{{ return customer.first_name?.length ? customer.first_name + ", " : "" }}hello', {}, js)).toBe('Dana, hello');
    expect(renderExpression('{{return event.items.length}} items, total {{ return event.total > 100 ? "big" : "small" }}', {}, js)).toBe(
      '2 items, total big',
    );
    expect(renderExpression('code {{ return data.code }}', {}, js)).toBe('code 42');
  });

  it('an empty value renders nothing; plain tags still work beside code', () => {
    const noName = makeTemplateJs({ customer: customerJsObject({ email: 'x@y.z', attributes: {} }) });
    expect(renderExpression('{{ return customer.first_name?.length ? customer.first_name + ", " : "" }}hi {{customer.email}}', { 'customer.email': 'x@y.z' }, noName)).toBe(
      'hi x@y.z',
    );
  });

  it('without a runner the block is left as written (never silently dropped)', () => {
    expect(renderExpression('{{ return 1 }}', {})).toBe('{{ return 1 }}');
  });

  it('a plain tag that merely CONTAINS the word return is not code', () => {
    expect(renderExpression('{{customer.return_date}}', { 'customer.attributes.return_date': 'Mon' }, js)).toBe('Mon');
  });

  it('an error or a runaway loop renders empty, never throws', () => {
    expect(renderExpression('a{{ return nope.x.y }}b', {}, js)).toBe('ab');
    expect(renderExpression('a{{ return (() => { while (true) {} })() }}b', {}, js)).toBe('ab');
  });
});

describe('{{ return … }} in the HTML renderer (email bodies)', () => {
  it('ESCAPES the result like any merge value; {{{ return … }}} writes it raw', () => {
    const evil = makeTemplateJs({ customer: customerJsObject({ attributes: { first_name: '<b>x</b>' } }) });
    expect(renderExpressionHtml('<p>{{ return customer.first_name }}</p>', {}, 'empty', undefined, evil)).toBe('<p>&lt;b&gt;x&lt;/b&gt;</p>');
    // As the editor saves it: a `<` typed inside code is stored as `&lt;`.
    expect(renderExpressionHtml('<p>{{{ return &quot;&lt;i&gt;&quot; + customer.first_name + &quot;&lt;/i&gt;&quot; }}}</p>', {}, 'empty', undefined, evil)).toBe(
      '<p><i><b>x</b></i></p>',
    );
  });

  it('decodes the code the email editor HTML-encoded before running it', () => {
    // What a text block saves when you type: return customer.tier > 2 && "VIP" || ''
    const saved = '<p>{{ return customer.tier &gt; 2 &amp;&amp; &quot;VIP&quot; || &#39;&#39; }}</p>';
    expect(renderExpressionHtml(saved, {}, 'empty', undefined, js)).toBe('<p>VIP</p>');
    // A line break or a formatting tag the editor slipped into the code is markup, not code.
    expect(renderExpressionHtml('{{ return <span>customer.first_name</span><br>}}', {}, 'empty', undefined, js)).toBe('Dana');
  });

  it("keeps the dispatcher's 'keep' behaviour when no runner is given", () => {
    expect(renderExpressionHtml('{{ return 1 }}', {}, 'keep')).toBe('{{ return 1 }}');
  });
});

describe('decodeHtmlCode', () => {
  it('strips tags and decodes entities, including &nbsp; and numeric ones', () => {
    expect(decodeHtmlCode('a&nbsp;&lt;&gt;&amp;&#x27;&#34;<br/>b')).toBe('a <>&\'"b');
  });
});

describe('the sandbox', () => {
  it('has no host globals', () => {
    expect(runSandboxedJs('return typeof process + typeof require + typeof globalThis.fetch', {})).toBe('undefinedundefinedundefined');
  });
  it('defeats the constructor realm escape', () => {
    expect(runSandboxedJs("return customer.constructor.constructor('return typeof process')()", { customer: {} })).toBe('undefined');
  });
});

describe('varsFromMerge — the fallback when only a flat merge map exists', () => {
  it('rebuilds nested objects and arrays from dotted keys', () => {
    const v = varsFromMerge({ 'event.items.0.sku': 'A', 'event.items.1.sku': 'B', 'event.order.id': '7', 'journey.coupon': 'X' });
    expect(v.event).toEqual({ items: [{ sku: 'A' }, { sku: 'B' }], order: { id: '7' } });
    expect(v.journey).toEqual({ coupon: 'X' });
  });
});
