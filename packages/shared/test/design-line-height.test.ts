// The email's default line height (Template settings) — every text block inherits
// it unless the block sets its own.
import { describe, it, expect } from 'vitest';
import { designToMjml, type EmailDesign } from '../src/email-design/index.js';

const design = (settings: Record<string, unknown>, lineHeight?: number): EmailDesign =>
  ({
    version: 1,
    settings,
    rows: [{ id: 'r1', elements: [{ id: 'e1', type: 'text', props: { html: '<p>hi</p>', ...(lineHeight ? { lineHeight } : {}) } }] }],
  }) as unknown as EmailDesign;

describe('template line height', () => {
  it('sets the default for every text block', () => {
    const mjml = designToMjml(design({ lineHeight: 1.6 }));
    expect(mjml).toContain('<mj-text line-height="1.6" />');
  });

  it("a block's own line height still wins (it is on the element)", () => {
    const mjml = designToMjml(design({ lineHeight: 1.6 }, 2));
    expect(mjml).toMatch(/<mj-text[^>]*line-height="2"[^>]*><p>hi<\/p><\/mj-text>/);
  });

  it('unset → no default emitted (MJML keeps its own)', () => {
    expect(designToMjml(design({}))).not.toContain('line-height="');
  });
});
