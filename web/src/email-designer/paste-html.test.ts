// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';
import { cleanPastedHtml } from './paste-html.js';

const clean = (html: string): string => cleanPastedHtml(html, document);

describe('cleanPastedHtml', () => {
  it('drops layout styles (margins, padding, line-height, fonts) from wrappers', () => {
    const out = clean(
      '<div style="margin-top:80px;padding:40px;line-height:2;font-family:Arial">שלום <span style="font-size:14pt;line-height:2.4">עולם</span></div>',
    );
    expect(out).toBe('<p>שלום עולם</p>');
  });

  it('unwraps the Google Docs <b style="font-weight:normal"> wrapper instead of bolding everything', () => {
    const out = clean('<meta charset="utf-8"><b style="font-weight:normal;" id="docs-internal-guid-1"><p dir="rtl" style="line-height:1.38;margin-top:0pt">hi</p></b>');
    expect(out).toBe('<p dir="rtl">hi</p>');
  });

  it('keeps bold/italic/underline/colour expressed as spans', () => {
    const out = clean('<span style="font-weight:700;color:#ff0000;font-size:20px">A</span><span style="font-style:italic;font-weight:400">B</span>');
    expect(out).toBe('<span style="font-weight:700;color:#ff0000">A</span><span style="font-style:italic">B</span>');
  });

  it('keeps basic tags, links with safe schemes, and lists', () => {
    expect(clean('<p><b>x</b> <a href="https://a.com" target="_blank" class="c">l</a></p><ul><li>1</li></ul>')).toBe(
      '<p><b>x</b> <a href="https://a.com">l</a></p><ul><li>1</li></ul>',
    );
    expect(clean('<a href="javascript:alert(1)">x</a>')).toBe('<a>x</a>');
    expect(clean('<a href="{{unsubscribe_url}}">x</a>')).toBe('<a href="{{unsubscribe_url}}">x</a>');
  });

  it('removes scripts, styles, images and comments with their content', () => {
    expect(clean('<style>p{margin:9px}</style><!-- c --><script>x()</script><img src="a.png">ok')).toBe('ok');
  });

  it('trims empty paragraphs and line breaks at the start and end', () => {
    expect(clean('<p><br></p><p>&nbsp;</p><br><p>text</p><p></p><br>')).toBe('<p>text</p>');
  });

  it('keeps empty paragraphs BETWEEN text (a deliberate blank line)', () => {
    expect(clean('<p>a</p><p><br></p><p>b</p>')).toBe('<p>a</p><p><br></p><p>b</p>');
  });

  it('unwraps a div that wraps paragraphs rather than nesting them', () => {
    expect(clean('<div><p>a</p></div>')).toBe('<p>a</p>');
    expect(clean('<div style="margin-top:80px"><p><br></p><p>PASTED</p><p>b</p></div>')).toBe('<p>PASTED</p><p>b</p>');
  });

  it('removes leading/trailing line breaks inside the first and last paragraph', () => {
    expect(clean('<p><br>&nbsp;x</p><p>y<br><br></p>')).toBe('<p>&nbsp;x</p><p>y</p>');
  });

  it('keeps merge tags as text', () => {
    expect(clean('<span>היי {{ customer.first_name | default: "" }},</span>')).toBe('היי {{ customer.first_name | default: "" }},');
  });
});
