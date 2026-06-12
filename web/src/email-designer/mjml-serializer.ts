// EmailDesign → MJML serializer (§11 — the "editor emits MJML, never hand-rolled
// HTML" invariant). Pure string building, framework-free, unit-tested against the
// REAL strict server compiler (compileMjml) so everything emitted here is
// guaranteed-compilable.
//
// Structure produced:
//   <mjml>
//     <mj-head>  mj-font? + mj-attributes (font, RTL defaults) + mj-style (RTL)
//     <mj-body width bgcolor>
//       per row → <mj-wrapper bg/padding/border>     (the row's chrome)
//         runs of leaf elements → <mj-section><mj-column> leaves …
//         grid element        → <mj-section> <mj-column per cell> …
//
// MJML cannot nest a section inside a column — which is exactly why the model
// forbids grid-in-grid (GridCell holds LeafElement only).
import {
  FONT_SIZE_EMS,
  HEADING_SIZE_EMS,
  type Border,
  type DesignElement,
  type DesignRow,
  type DesignSettings,
  type EmailDesign,
  type GridElement,
  type LeafElement,
  type Radius,
  type Spacing,
} from './model.js';

const DEFAULT_BODY_WIDTH = 600;
const DEFAULT_BASE_FONT = 16;

/** Escape a value placed into an MJML/HTML ATTRIBUTE. */
function esc(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Escape plain TEXT content (list items, headings — not rich text html). */
function escText(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Render an attribute string from a record, skipping null/undefined/empty. */
function attrs(map: Record<string, string | number | undefined | null>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(map)) {
    if (v === undefined || v === null || v === '') continue;
    parts.push(`${k}="${esc(String(v))}"`);
  }
  return parts.length ? ` ${parts.join(' ')}` : '';
}

/** Spacing → MJML padding attribute value ("Tpx Rpx Bpx Lpx"); undefined when absent. */
function padding(s: Spacing | undefined): string | undefined {
  if (!s) return undefined;
  const { top = 0, right = 0, bottom = 0, left = 0 } = s;
  if (!top && !right && !bottom && !left) return undefined;
  return `${top}px ${right}px ${bottom}px ${left}px`;
}

/** Border → MJML border attribute value ("2px solid #ccc"); undefined when absent. */
function border(b: Border | undefined): string | undefined {
  if (!b || !b.width || b.style === 'none') return undefined;
  return `${b.width}px ${b.style ?? 'solid'} ${b.color ?? '#000000'}`;
}

/** Radius → border-radius attribute value; undefined when absent. */
function radius(r: Radius | undefined): string | undefined {
  if (!r) return undefined;
  const { topLeft = 0, topRight = 0, bottomRight = 0, bottomLeft = 0 } = r;
  if (!topLeft && !topRight && !bottomRight && !bottomLeft) return undefined;
  return `${topLeft}px ${topRight}px ${bottomRight}px ${bottomLeft}px`;
}

/** Resolve a font-size key to px from the base size. */
function sizePx(key: string | undefined, base: number): number | undefined {
  if (!key) return undefined;
  const em = FONT_SIZE_EMS[key];
  return em === undefined ? undefined : Math.round(em * base);
}

// ── Leaf serializers ─────────────────────────────────────────────────────────

function leafToMjml(el: LeafElement, base: number, dir: 'rtl' | 'ltr'): string {
  switch (el.type) {
    case 'heading': {
      const p = el.props;
      const px = Math.round((HEADING_SIZE_EMS[p.level] ?? 1) * base);
      const a = attrs({
        align: p.textAlign,
        color: p.color,
        'font-size': `${px}px`,
        'font-weight': '700',
        padding: padding(p.padding) ?? '10px 25px',
      });
      // The heading TAG rides inside mj-text (mj-text is MJML's only text block).
      return `<mj-text${a}><${p.level} style="margin:0;font-size:inherit;">${escText(p.text)}</${p.level}></mj-text>`;
    }
    case 'text': {
      const p = el.props;
      const a = attrs({
        align: p.textAlign,
        color: p.color,
        'font-size': sizePx(p.fontSize, base) ? `${sizePx(p.fontSize, base)}px` : undefined,
        'line-height': p.lineHeight,
        padding: padding(p.padding) ?? '10px 25px',
      });
      return `<mj-text${a}>${p.html}</mj-text>`;
    }
    case 'image': {
      const p = el.props;
      const a = attrs({
        src: p.src,
        alt: p.alt,
        width: p.width ? `${p.width}px` : undefined,
        align: p.align,
        href: p.href,
        'border-radius': radius(p.radius),
        padding: padding(p.padding) ?? '10px 25px',
      });
      return `<mj-image${a} />`;
    }
    case 'button': {
      const p = el.props;
      const a = attrs({
        href: p.url,
        'background-color': p.bgColor,
        color: p.color,
        'border-radius': p.borderRadius !== undefined ? `${p.borderRadius}px` : undefined,
        'font-size': sizePx(p.fontSize, base) ? `${sizePx(p.fontSize, base)}px` : undefined,
        align: p.align,
        padding: padding(p.padding) ?? '10px 25px',
      });
      return `<mj-button${a}>${escText(p.text)}</mj-button>`;
    }
    case 'list': {
      const p = el.props;
      const items = p.items.map((i) => `<li>${escText(i.text)}</li>`).join('');
      // Lists ride inside mj-text; direction-aware padding so bullets sit on the
      // correct side in RTL.
      const listPad = dir === 'rtl' ? 'padding:0 24px 0 0;' : 'padding:0 0 0 24px;';
      const a = attrs({
        align: p.textAlign,
        color: p.color,
        'font-size': sizePx(p.fontSize, base) ? `${sizePx(p.fontSize, base)}px` : undefined,
        padding: padding(p.padding) ?? '10px 25px',
      });
      return `<mj-text${a}><${p.listType} style="margin:0;${listPad}">${items}</${p.listType}></mj-text>`;
    }
    case 'separator': {
      const p = el.props;
      const a = attrs({
        'border-color': p.lineColor ?? '#dddddd',
        'border-width': `${p.lineThickness ?? 1}px`,
        'border-style': p.lineStyle ?? 'solid',
        width: p.lineWidth ? `${p.lineWidth}%` : undefined,
        padding: padding(p.padding) ?? '10px 25px',
      });
      return `<mj-divider${a} />`;
    }
  }
}

// ── Grid / row serializers ───────────────────────────────────────────────────

function gridToMjml(grid: GridElement, base: number, dir: 'rtl' | 'ltr'): string {
  const cells = grid.children
    .map((cell) => {
      const p = cell.props ?? {};
      const a = attrs({
        width: p.width ? `${p.width}%` : undefined,
        'background-color': p.bgColor,
        padding: padding(p.padding),
        border: border(p.border),
        'border-radius': radius(p.radius),
      });
      const inner = cell.elements.map((el) => leafToMjml(el, base, dir)).join('');
      return `<mj-column${a}>${inner}</mj-column>`;
    })
    .join('');
  const a = attrs({ padding: padding(grid.props.padding) ?? '0px' });
  return `<mj-section${a}>${cells}</mj-section>`;
}

/**
 * Serialize one row: its chrome (bg/padding/border) on an mj-wrapper, with runs
 * of consecutive leaf elements grouped into single-column sections and each grid
 * becoming its own multi-column section.
 */
function rowToMjml(row: DesignRow, base: number, dir: 'rtl' | 'ltr'): string {
  if (row.elements.length === 0) return '';
  const sections: string[] = [];
  let run: LeafElement[] = [];
  const flush = (): void => {
    if (run.length === 0) return;
    const inner = run.map((el) => leafToMjml(el, base, dir)).join('');
    sections.push(`<mj-section padding="0px"><mj-column>${inner}</mj-column></mj-section>`);
    run = [];
  };
  for (const el of row.elements as readonly DesignElement[]) {
    if (el.type === 'grid') {
      flush();
      sections.push(gridToMjml(el, base, dir));
    } else {
      run.push(el);
    }
  }
  flush();

  const p = row.props ?? {};
  const a = attrs({
    'background-color': p.bgColor,
    padding: padding(p.padding) ?? '0px',
    border: border(p.border),
    'border-radius': radius(p.radius),
  });
  return `<mj-wrapper${a}>${sections.join('')}</mj-wrapper>`;
}

// ── Head ─────────────────────────────────────────────────────────────────────

/**
 * The document head: an optional Google font (mj-font + font-family default for
 * all components) and the RTL defaults. RTL keeps the established `cdp-rtl`
 * marker class (the editor + tests detect direction from it) and renders every
 * mj-text right-to-left in the compiled output.
 */
function headToMjml(settings: DesignSettings): string {
  const parts: string[] = [];
  const attributeParts: string[] = [];
  const rtl = settings.direction === 'rtl';

  if (settings.fontFamily) {
    const fam = settings.fontFamily;
    const href = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(fam)}:wght@300;400;500;600;700&display=swap`;
    parts.push(`<mj-font name="${esc(fam)}" href="${esc(href)}" />`);
    attributeParts.push(`<mj-all font-family="${esc(`${fam}, Helvetica, Arial, sans-serif`)}" />`);
  }
  if (rtl) {
    attributeParts.push('<mj-text css-class="cdp-rtl" align="right" />');
  }
  if (attributeParts.length) {
    parts.push(`<mj-attributes>${attributeParts.join('')}</mj-attributes>`);
  }
  if (rtl) {
    parts.push('<mj-style>.cdp-rtl div{direction:rtl;}</mj-style>');
  }
  return parts.length ? `<mj-head>${parts.join('')}</mj-head>` : '';
}

// ── Entry point ──────────────────────────────────────────────────────────────

/**
 * Serialize a design document to a complete MJML document. Deterministic, pure;
 * always rooted at <mjml> with an <mj-body> (an empty design yields an empty but
 * valid, compilable document).
 */
export function designToMjml(design: EmailDesign): string {
  const settings = design.settings ?? {};
  const base = settings.baseFontSize ?? DEFAULT_BASE_FONT;
  const dir: 'rtl' | 'ltr' = settings.direction === 'rtl' ? 'rtl' : 'ltr';

  const head = headToMjml(settings);
  const bodyAttrs = attrs({
    width: `${settings.bodyWidth ?? DEFAULT_BODY_WIDTH}px`,
    'background-color': settings.bgColor,
  });
  const rows = design.rows.map((r) => rowToMjml(r, base, dir)).join('');
  return `<mjml>${head}<mj-body${bodyAttrs}>${rows}</mj-body></mjml>`;
}
