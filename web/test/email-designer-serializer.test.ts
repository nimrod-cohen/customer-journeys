// The email designer serializes its design JSON to MJML (§11 — "the editor emits
// MJML, never hand-rolled HTML"). Every shape the designer can produce must
// compile under the REAL server compiler in STRICT mode — that is the contract
// these tests pin: designToMjml output is guaranteed-compilable.
import { describe, it, expect } from 'vitest';
import { compileMjml } from '@cdp/email';
import { designToMjml } from '../src/email-designer/mjml-serializer.js';
import { emptyDesign, isEmailDesign, type EmailDesign, type DesignRow, type LeafElement } from '../src/email-designer/model.js';

const row = (elements: DesignRow['elements'], props?: DesignRow['props']): DesignRow => ({
  id: 'row-1',
  ...(props ? { props } : {}),
  elements,
});

const design = (rows: DesignRow[], settings?: EmailDesign['settings']): EmailDesign => ({
  version: 1,
  ...(settings ? { settings } : {}),
  rows,
});

const heading: LeafElement = { id: 'e1', type: 'heading', props: { text: 'Hello', level: 'h2' } };
const text: LeafElement = { id: 'e2', type: 'text', props: { html: 'Some <b>rich</b> text' } };
const image: LeafElement = { id: 'e3', type: 'image', props: { src: 'https://x.example/pic.png', alt: 'pic' } };
const button: LeafElement = {
  id: 'e4',
  type: 'button',
  props: { text: 'Click me', url: 'https://x.example', bgColor: '#4a90d9', color: '#ffffff', borderRadius: 6 },
};
const list: LeafElement = {
  id: 'e5',
  type: 'list',
  props: { listType: 'ul', items: [{ id: 'i1', text: 'One' }, { id: 'i2', text: 'Two & <three>' }] },
};
const separator: LeafElement = {
  id: 'e6',
  type: 'separator',
  props: { lineColor: '#cccccc', lineThickness: 2, lineStyle: 'dashed', lineWidth: 80 },
};

describe('designToMjml — structure', () => {
  it('an empty design yields a valid, compilable document', () => {
    const mjml = designToMjml(emptyDesign());
    expect(mjml.startsWith('<mjml>')).toBe(true);
    expect(mjml).toContain('<mj-body');
    expect(() => compileMjml(mjml)).not.toThrow();
  });

  it('every leaf element type compiles (strict)', () => {
    const mjml = designToMjml(design([row([heading, text, image, button, list, separator])]));
    expect(mjml).toContain('<mj-wrapper');
    expect(mjml).toContain('<h2');
    expect(mjml).toContain('Some <b>rich</b> text');
    expect(mjml).toContain('<mj-image');
    expect(mjml).toContain('<mj-button');
    expect(mjml).toContain('<ul');
    expect(mjml).toContain('<mj-divider');
    expect(() => compileMjml(mjml)).not.toThrow();
  });

  it('a grid becomes a multi-column section; cells carry width/bg/padding', () => {
    const grid: DesignRow['elements'][number] = {
      id: 'g1',
      type: 'grid',
      props: { columns: 2 },
      children: [
        { id: 'c1', props: { width: 30, bgColor: '#f0f0f0', padding: { top: 10, left: 10 } }, elements: [text] },
        { id: 'c2', props: { width: 70 }, elements: [button] },
      ],
    };
    const mjml = designToMjml(design([row([grid])]));
    expect(mjml).toContain('width="30%"');
    expect(mjml).toContain('width="70%"');
    expect(mjml).toContain('background-color="#f0f0f0"');
    expect(() => compileMjml(mjml)).not.toThrow();
  });

  it('leaves around a grid split into separate sections inside ONE wrapper (no section-in-column)', () => {
    const grid: DesignRow['elements'][number] = {
      id: 'g1',
      type: 'grid',
      props: { columns: 2 },
      children: [
        { id: 'c1', elements: [text] },
        { id: 'c2', elements: [] },
      ],
    };
    const mjml = designToMjml(design([row([heading, grid, button])]));
    // one wrapper, three sections: [heading] [grid] [button]
    expect(mjml.match(/<mj-wrapper/g)).toHaveLength(1);
    expect(mjml.match(/<mj-section/g)).toHaveLength(3);
    expect(() => compileMjml(mjml)).not.toThrow();
  });

  it('an empty grid cell still compiles (empty mj-column)', () => {
    const grid: DesignRow['elements'][number] = {
      id: 'g1',
      type: 'grid',
      props: { columns: 2 },
      children: [
        { id: 'c1', elements: [text] },
        { id: 'c2', elements: [] },
      ],
    };
    expect(() => compileMjml(designToMjml(design([row([grid])])))).not.toThrow();
  });

  it('empty rows are skipped', () => {
    const mjml = designToMjml(design([{ id: 'r0', elements: [] }, row([text])]));
    expect(mjml.match(/<mj-wrapper/g)).toHaveLength(1);
  });
});

describe('designToMjml — props & settings', () => {
  it('row chrome (bg, padding, border, radius) lands on the wrapper and compiles', () => {
    const mjml = designToMjml(
      design([
        row([text], {
          bgColor: '#ffeecc',
          padding: { top: 20, bottom: 20 },
          border: { width: 1, style: 'solid', color: '#ddd' },
          radius: { topLeft: 8, topRight: 8, bottomRight: 8, bottomLeft: 8 },
        }),
      ]),
    );
    expect(mjml).toContain('background-color="#ffeecc"');
    expect(mjml).toContain('padding="20px 0px 20px 0px"');
    expect(mjml).toContain('border="1px solid #ddd"');
    expect(mjml).toContain('border-radius="8px 8px 8px 8px"');
    expect(() => compileMjml(mjml)).not.toThrow();
  });

  it('font-size keys resolve to px from baseFontSize', () => {
    const sized: LeafElement = { id: 't', type: 'text', props: { html: 'big', fontSize: '2xl' } };
    const mjml = designToMjml(design([row([sized])], { baseFontSize: 20 }));
    expect(mjml).toContain('font-size="30px"'); // 1.5em × 20px
    expect(() => compileMjml(mjml)).not.toThrow();
  });

  it('heading levels scale from the base size', () => {
    const mjml = designToMjml(design([row([heading])])); // h2 = 2em × 16
    expect(mjml).toContain('font-size="32px"');
  });

  it('body width + background come from settings', () => {
    const mjml = designToMjml(design([row([text])], { bodyWidth: 700, bgColor: '#fafafa' }));
    expect(mjml).toContain('width="700px"');
    expect(mjml).toContain('background-color="#fafafa"');
    expect(() => compileMjml(mjml)).not.toThrow();
  });

  it('a Google font serializes as mj-font + a font-family default', () => {
    const mjml = designToMjml(design([row([text])], { fontFamily: 'Rubik' }));
    expect(mjml).toContain('<mj-font name="Rubik"');
    expect(mjml).toContain('fonts.googleapis.com');
    expect(mjml).toContain('font-family="Rubik, Helvetica, Arial, sans-serif"');
    expect(() => compileMjml(mjml)).not.toThrow();
  });

  it('RTL emits the cdp-rtl head and compiles to direction:rtl', () => {
    const hebrew: LeafElement = { id: 't', type: 'text', props: { html: 'שלום עולם.' } };
    const mjml = designToMjml(design([row([hebrew])], { direction: 'rtl' }));
    expect(mjml).toContain('cdp-rtl');
    const html = compileMjml(mjml);
    expect(html.toLowerCase()).toContain('direction:rtl');
  });

  it('RTL lists pad on the right side', () => {
    const mjml = designToMjml(design([row([list])], { direction: 'rtl' }));
    expect(mjml).toContain('padding:0 24px 0 0;');
    expect(() => compileMjml(mjml)).not.toThrow();
  });

  it('list items and button text are escaped; attribute injection is neutralized', () => {
    const evil: LeafElement = {
      id: 'b',
      type: 'button',
      props: { text: 'a<b>"c', url: 'https://x.example/?q="><mj-bogus>' },
    };
    const mjml = designToMjml(design([row([evil, list])]));
    expect(mjml).not.toContain('<mj-bogus'); // the attribute value was escaped
    expect(mjml).toContain('Two &amp; &lt;three&gt;');
    expect(() => compileMjml(mjml)).not.toThrow();
  });

  it('image width/align/radius/href serialize and compile', () => {
    const img: LeafElement = {
      id: 'i',
      type: 'image',
      props: {
        src: 'https://x.example/p.png',
        width: 200,
        align: 'center',
        href: 'https://x.example',
        radius: { topLeft: 4, topRight: 4, bottomRight: 4, bottomLeft: 4 },
      },
    };
    const mjml = designToMjml(design([row([img])]));
    expect(mjml).toContain('width="200px"');
    expect(mjml).toContain('align="center"');
    expect(mjml).toContain('href="https://x.example"');
    expect(() => compileMjml(mjml)).not.toThrow();
  });
});

describe('isEmailDesign (stored jsonb guard)', () => {
  it('accepts a v1 design and rejects garbage', () => {
    expect(isEmailDesign(emptyDesign())).toBe(true);
    expect(isEmailDesign(null)).toBe(false);
    expect(isEmailDesign({})).toBe(false);
    expect(isEmailDesign({ version: 2, rows: [] })).toBe(false);
  });
});
