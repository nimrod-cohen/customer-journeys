// The email designer's document model (§11 — replaces GrapesJS with the
// nomentor-derived designer). This is the SOURCE OF TRUTH a template's design is
// stored as (email_templates.design jsonb); the MJML the server compiles is
// DERIVED from it by mjml-serializer.ts. The model is nomentor's layout tree
// narrowed to what MJML can express:
//   - rows[] → elements[]; a grid element holds cells[] of elements (DEPTH 1 —
//     MJML cannot nest sections inside columns, so grids can't contain grids).
//   - element types: heading | text | image | button | list | separator | grid.
//     (form/timer/video are not email-capable and were dropped in the port.)
//   - spacing is PADDING-only (MJML has no margin), no per-viewport overrides
//     (MJML auto-stacks on mobile), no box-shadow/effects (poor client support).

export interface NamedColor {
  readonly name: string;
  readonly value: string;
}

/** Per-template settings (stored inside the design). */
export interface DesignSettings {
  /** Document direction; 'rtl' renders Hebrew/Arabic correctly end-to-end. */
  readonly direction?: 'rtl' | 'ltr';
  /** Google-font family for the whole email (serialized as mj-font). */
  readonly fontFamily?: string;
  /** Base font size in px (default 16) — size keys scale from it. */
  readonly baseFontSize?: number;
  /** Email body width in px (default 600). */
  readonly bodyWidth?: number;
  /** Page background behind the body. */
  readonly bgColor?: string;
  /** Named color palette (a picker convenience; props store raw CSS colors). */
  readonly colors?: readonly NamedColor[];
}

/** Padding box in px. Omitted sides are 0. */
export interface Spacing {
  readonly top?: number;
  readonly right?: number;
  readonly bottom?: number;
  readonly left?: number;
}

export interface Border {
  readonly width?: number;
  readonly style?: 'solid' | 'dashed' | 'dotted' | 'none';
  readonly color?: string;
}

/** Corner radii in px. */
export interface Radius {
  readonly topLeft?: number;
  readonly topRight?: number;
  readonly bottomRight?: number;
  readonly bottomLeft?: number;
}

export type Align = 'left' | 'center' | 'right';

/** Relative size keys (nomentor's scale); resolved to px via settings.baseFontSize. */
export const FONT_SIZE_EMS: Readonly<Record<string, number>> = {
  xs: 0.75,
  sm: 0.875,
  base: 1,
  lg: 1.125,
  xl: 1.25,
  '2xl': 1.5,
  '3xl': 1.875,
  '4xl': 2.25,
};
export type FontSizeKey = keyof typeof FONT_SIZE_EMS & string;

/** Heading sizes in em of the base (nomentor defaults). */
export const HEADING_SIZE_EMS: Readonly<Record<string, number>> = {
  h1: 2.5,
  h2: 2,
  h3: 1.75,
  h4: 1.5,
  h5: 1.25,
  h6: 1,
};
export type HeadingLevel = 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6';

// ── Element props (narrowed to MJML-expressible) ────────────────────────────

export interface HeadingProps {
  readonly text: string;
  readonly level: HeadingLevel;
  readonly color?: string;
  readonly textAlign?: Align;
  readonly padding?: Spacing;
}

export interface TextProps {
  /** Rich inline HTML (the user's own content; placed inside mj-text). */
  readonly html: string;
  readonly color?: string;
  readonly fontSize?: FontSizeKey;
  readonly textAlign?: Align;
  readonly lineHeight?: number;
  readonly padding?: Spacing;
}

export interface ImageProps {
  readonly src: string;
  readonly alt?: string;
  /** Rendered width in px (omit = full column width). */
  readonly width?: number;
  readonly align?: Align;
  readonly padding?: Spacing;
  readonly radius?: Radius;
  /** Optional link target (the whole image becomes a link). */
  readonly href?: string;
}

export interface ButtonProps {
  readonly text: string;
  readonly url?: string;
  readonly bgColor?: string;
  readonly color?: string;
  /** Corner radius in px. */
  readonly borderRadius?: number;
  readonly fontSize?: FontSizeKey;
  readonly align?: Align;
  readonly padding?: Spacing;
}

export interface ListItem {
  readonly id: string;
  readonly text: string;
}

export interface ListProps {
  readonly listType: 'ul' | 'ol';
  readonly items: readonly ListItem[];
  readonly color?: string;
  readonly fontSize?: FontSizeKey;
  readonly textAlign?: Align;
  readonly padding?: Spacing;
}

export interface SeparatorProps {
  readonly lineColor?: string;
  /** Thickness in px (default 1). */
  readonly lineThickness?: number;
  /** Width as a CSS percentage 1–100 (omit = full width). */
  readonly lineWidth?: number;
  readonly lineStyle?: 'solid' | 'dashed' | 'dotted';
  readonly padding?: Spacing;
}

export interface GridProps {
  /** Number of columns (the cells array length is authoritative). */
  readonly columns: number;
  readonly padding?: Spacing;
}

export interface CellProps {
  /** Column width in % (omit = equal share). */
  readonly width?: number;
  readonly bgColor?: string;
  readonly padding?: Spacing;
  readonly border?: Border;
  readonly radius?: Radius;
  /** Horizontal alignment of the cell's content. */
  readonly align?: Align;
}

// ── Tree nodes ───────────────────────────────────────────────────────────────

export interface HeadingElement {
  readonly id: string;
  readonly type: 'heading';
  readonly props: HeadingProps;
}
export interface TextElement {
  readonly id: string;
  readonly type: 'text';
  readonly props: TextProps;
}
export interface ImageElement {
  readonly id: string;
  readonly type: 'image';
  readonly props: ImageProps;
}
export interface ButtonElement {
  readonly id: string;
  readonly type: 'button';
  readonly props: ButtonProps;
}
export interface ListElement {
  readonly id: string;
  readonly type: 'list';
  readonly props: ListProps;
}
export interface SeparatorElement {
  readonly id: string;
  readonly type: 'separator';
  readonly props: SeparatorProps;
}

/** A leaf element — everything except grid (grids cannot nest). */
export type LeafElement =
  | HeadingElement
  | TextElement
  | ImageElement
  | ButtonElement
  | ListElement
  | SeparatorElement;

export interface GridCell {
  readonly id: string;
  readonly props?: CellProps;
  readonly elements: readonly LeafElement[];
}

export interface GridElement {
  readonly id: string;
  readonly type: 'grid';
  readonly props: GridProps;
  readonly children: readonly GridCell[];
}

export type DesignElement = LeafElement | GridElement;

export interface RowProps {
  readonly bgColor?: string;
  readonly padding?: Spacing;
  readonly border?: Border;
  readonly radius?: Radius;
}

export interface DesignRow {
  readonly id: string;
  readonly props?: RowProps;
  readonly elements: readonly DesignElement[];
}

/** The stored design document (email_templates.design). */
export interface EmailDesign {
  readonly version: 1;
  readonly settings?: DesignSettings;
  readonly rows: readonly DesignRow[];
}

/** A fresh, empty design. */
export function emptyDesign(): EmailDesign {
  return { version: 1, settings: {}, rows: [] };
}

/** Loose runtime check that a stored jsonb value looks like an EmailDesign. */
export function isEmailDesign(value: unknown): value is EmailDesign {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as { version?: unknown; rows?: unknown };
  return v.version === 1 && Array.isArray(v.rows);
}
