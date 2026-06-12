import { describe, it, expect } from 'vitest';
import { compileMjml, MjmlCompileError } from '../src/mjml.js';

// §11 — compileMjml runs the REAL `mjml` compiler (not mocked). Valid MJML
// becomes cross-client HTML; invalid MJML throws.
describe('compileMjml (real mjml)', () => {
  it('compiles valid MJML to HTML', () => {
    const mjml = `<mjml><mj-body><mj-section><mj-column><mj-text>Hello</mj-text></mj-column></mj-section></mj-body></mjml>`;
    const html = compileMjml(mjml);
    expect(html).toContain('<html');
    expect(html.toLowerCase()).toContain('hello');
  });

  it('throws MjmlCompileError on invalid MJML (unknown tag)', () => {
    const bad = `<mjml><mj-body><mj-not-a-real-tag>x</mj-not-a-real-tag></mj-body></mjml>`;
    expect(() => compileMjml(bad)).toThrow(MjmlCompileError);
  });

  it('throws on empty input', () => {
    expect(() => compileMjml('')).toThrow(MjmlCompileError);
    expect(() => compileMjml('   ')).toThrow(MjmlCompileError);
  });

  it('surfaces the validation issues on the error', () => {
    const bad = `<mjml><mj-body><mj-bogus /></mj-body></mjml>`;
    try {
      compileMjml(bad);
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(MjmlCompileError);
      expect((err as MjmlCompileError).issues.length).toBeGreaterThan(0);
    }
  });

  // RTL (Hebrew/Arabic): `dir` on mj-text is INVALID under strict MJML, so the
  // editor expresses RTL via a head (mj-attributes default css-class + mj-style).
  // The compiled HTML must carry direction:rtl. (Guards the editor's RTL output.)
  it('rejects an invalid dir attribute on mj-text (strict)', () => {
    const bad = `<mjml><mj-body><mj-section><mj-column><mj-text dir="rtl">שלום</mj-text></mj-column></mj-section></mj-body></mjml>`;
    expect(() => compileMjml(bad)).toThrow(MjmlCompileError);
  });

  // The editor exposes per-component layout traits (padding/align/width) that map
  // to real MJML attributes — assert those compile under strict validation.
  it('compiles per-component layout attributes (padding/align/width)', () => {
    const doc =
      '<mjml><mj-body>' +
      '<mj-section padding="20px"><mj-column width="50%" padding="5px">' +
      '<mj-text padding="10px 25px" align="right">hi</mj-text>' +
      '<mj-image padding="5px" align="center" width="200px" src="https://x/y.png" />' +
      '<mj-button padding="5px" align="left" width="150px">b</mj-button>' +
      '</mj-column></mj-section></mj-body></mjml>';
    expect(() => compileMjml(doc)).not.toThrow();
  });

  it('compiles the RTL head (mj-attributes + mj-style) to direction:rtl HTML', () => {
    const rtl =
      '<mjml><mj-head><mj-attributes><mj-text css-class="cdp-rtl" align="right" /></mj-attributes>' +
      '<mj-style>.cdp-rtl div{direction:rtl;text-align:right}</mj-style></mj-head>' +
      '<mj-body><mj-section><mj-column><mj-text>שלום עולם</mj-text></mj-column></mj-section></mj-body></mjml>';
    const html = compileMjml(rtl);
    expect(html.toLowerCase()).toContain('direction:rtl');
    expect(html).toContain('שלום עולם');
  });
});
