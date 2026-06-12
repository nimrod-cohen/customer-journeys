// Canvas preview styles (port of nomentor's utils.js, narrowed). These MIRROR
// what mjml-serializer.ts emits so the canvas approximates the compiled email:
// padding-only spacing, border/radius, align, font sizes from the settings scale.
// Keep the two in sync when changing how an element renders.
import { FONT_SIZE_EMS, HEADING_SIZE_EMS, type Border, type DesignSettings, type Radius, type Spacing } from './model.js';

export type Style = Record<string, string>;

export function paddingCss(s: Spacing | undefined, fallback: string): string {
  if (!s) return fallback;
  const { top = 0, right = 0, bottom = 0, left = 0 } = s;
  if (!top && !right && !bottom && !left) return fallback;
  return `${top}px ${right}px ${bottom}px ${left}px`;
}

export function borderCss(b: Border | undefined): string | undefined {
  if (!b || !b.width || b.style === 'none') return undefined;
  return `${b.width}px ${b.style ?? 'solid'} ${b.color ?? '#000000'}`;
}

export function radiusCss(r: Radius | undefined): string | undefined {
  if (!r) return undefined;
  const { topLeft = 0, topRight = 0, bottomRight = 0, bottomLeft = 0 } = r;
  if (!topLeft && !topRight && !bottomRight && !bottomLeft) return undefined;
  return `${topLeft}px ${topRight}px ${bottomRight}px ${bottomLeft}px`;
}

export function fontSizeCss(key: string | undefined, settings: DesignSettings): string | undefined {
  if (!key) return undefined;
  const em = FONT_SIZE_EMS[key];
  if (em === undefined) return undefined;
  return `${Math.round(em * (settings.baseFontSize ?? 16))}px`;
}

export function headingSizeCss(level: string, settings: DesignSettings): string {
  return `${Math.round((HEADING_SIZE_EMS[level] ?? 1) * (settings.baseFontSize ?? 16))}px`;
}

/** The default content padding mj-text/image/button get when none is set. */
export const DEFAULT_CONTENT_PADDING = '10px 25px';
