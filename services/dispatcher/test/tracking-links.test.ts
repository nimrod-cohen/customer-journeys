// Click-tracking link rewriting (§10): rewrite http(s) hrefs to /t/<token>,
// deterministic per (workspace, source, url) so it's idempotent and shared across
// a send's recipients; leaves non-http hrefs alone.
import { describe, it, expect } from 'vitest';
import { rewriteTrackingLinks } from '../src/core.js';

const opts = { baseUrl: 'https://app.test', workspaceId: 'ws1', broadcastId: 'bc1', automationId: null };

describe('rewriteTrackingLinks', () => {
  it('rewrites http(s) links to /t/<token> and returns them', () => {
    const html = '<a href="https://acme.com/sale">Sale</a> and <a href="http://x.io/y">y</a>';
    const { html: out, links } = rewriteTrackingLinks(html, opts);
    expect(links).toHaveLength(2);
    for (const l of links) expect(out).toContain(`https://app.test/t/${l.token}`);
    expect(out).not.toContain('https://acme.com/sale');
  });

  it('is deterministic + dedupes a repeated url to one token', () => {
    const html = '<a href="https://a.com/x">1</a><a href="https://a.com/x">2</a>';
    const a = rewriteTrackingLinks(html, opts);
    const b = rewriteTrackingLinks(html, opts);
    expect(a.links).toHaveLength(1); // same url → one token
    expect(a.links[0]!.token).toBe(b.links[0]!.token); // deterministic across runs
  });

  it('leaves non-http hrefs (mailto, anchors, relative) untouched', () => {
    const html = '<a href="mailto:a@b.com">m</a><a href="#top">t</a><a href="/rel">r</a>';
    const { html: out, links } = rewriteTrackingLinks(html, opts);
    expect(links).toHaveLength(0);
    expect(out).toBe(html);
  });

  it('different source (broadcast vs automation) → different token for the same url', () => {
    const html = '<a href="https://a.com/x">x</a>';
    const bc = rewriteTrackingLinks(html, { ...opts, broadcastId: 'bc1', automationId: null });
    const cm = rewriteTrackingLinks(html, { ...opts, broadcastId: null, automationId: 'cm1' });
    expect(bc.links[0]!.token).not.toBe(cm.links[0]!.token);
  });
});
