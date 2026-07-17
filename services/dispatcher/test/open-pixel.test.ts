// Open tracking (§10): the dispatcher embeds a 1x1 pixel `<img src="/o/<token>">`
// whose token is DETERMINISTIC per (workspace, source, profile) — so a re-send /
// retry to the same recipient reuses the same token (one tracked_opens row per
// recipient ⇒ counting rows = distinct-profile opens). Pure (sha256), no I/O.
import { describe, it, expect } from 'vitest';
import { openPixelToken, buildOpenPixelImg, injectOpenPixel } from '../src/core.js';

const base = { baseUrl: 'https://app.test', workspaceId: 'ws1', broadcastId: 'bc1', automationId: null, profileId: 'p1' };

describe('openPixelToken', () => {
  it('is deterministic per (workspace, source, profile)', () => {
    expect(openPixelToken(base)).toBe(openPixelToken(base));
  });

  it('differs by profile, by source, and by workspace', () => {
    const t = openPixelToken(base);
    expect(openPixelToken({ ...base, profileId: 'p2' })).not.toBe(t);
    expect(openPixelToken({ ...base, broadcastId: null, automationId: 'cm1' })).not.toBe(t);
    expect(openPixelToken({ ...base, workspaceId: 'ws2' })).not.toBe(t);
  });
});

describe('injectOpenPixel', () => {
  it('appends an <img>/o/<token> pixel and returns the token', () => {
    const { html, token } = injectOpenPixel('<p>hi</p>', base);
    expect(token).toBe(openPixelToken(base));
    expect(html).toContain(`https://app.test/o/${token}`);
    expect(html).toContain('width="1"');
    expect(html).toContain('height="1"');
    // The pixel goes at the very end of the body content.
    expect(html.indexOf('<p>hi</p>')).toBeLessThan(html.indexOf('/o/'));
  });

  it('places the pixel before </body> when present', () => {
    const { html } = injectOpenPixel('<html><body><p>hi</p></body></html>', base);
    expect(html.indexOf('/o/')).toBeLessThan(html.indexOf('</body>'));
  });

  it('buildOpenPixelImg builds a transparent 1x1 img tag', () => {
    const img = buildOpenPixelImg('https://app.test/o/abc');
    expect(img).toContain('src="https://app.test/o/abc"');
    expect(img).toContain('alt=""');
  });
});
