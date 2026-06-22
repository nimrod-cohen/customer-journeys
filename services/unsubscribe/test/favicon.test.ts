// The public unsubscribe/preference pages are served by the API (not the SPA), so
// the app favicon is inlined as a data-URI <link> in the page head.
import { describe, it, expect } from 'vitest';
import { confirmPage, donePage } from '../src/handler.js';
import { FAVICON_LINK } from '../src/core.js';

describe('favicon on the public pages', () => {
  it('FAVICON_LINK is an svg data-uri icon link', () => {
    expect(FAVICON_LINK).toContain('rel="icon"');
    expect(FAVICON_LINK).toContain('data:image/svg+xml;base64,');
  });

  it('the unsubscribe pages include the favicon link', () => {
    expect(confirmPage('a@b.com', 'https://x/u')).toContain(FAVICON_LINK);
    expect(donePage('a@b.com')).toContain('rel="icon"');
  });
});
