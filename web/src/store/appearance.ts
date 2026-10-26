// Per-browser display preferences: light/dark theme and text size. Both live in
// localStorage (a per-viewer convenience, not account data) and are applied as a
// class + root font-size on <html>. Tailwind sizes are rem, so changing the root
// font-size scales the whole UI. index.html applies the same values before first
// paint so a reload never flashes the wrong theme.
import { createStore, type Store } from './store.js';

export type Theme = 'light' | 'dark';

export const THEME_KEY = 'cdp.theme';
export const FONT_SCALE_KEY = 'cdp.fontScale';
/** Root font-size steps, in percent of the browser default. */
export const FONT_SCALES = [87.5, 100, 112.5, 125, 137.5] as const;
export const DEFAULT_FONT_SCALE = 100;

export interface Appearance {
  theme: Theme;
  fontScale: number;
}

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* private mode / blocked storage: the choice just won't persist */
  }
}

function systemTheme(): Theme {
  try {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  } catch {
    return 'light';
  }
}

/** Parse stored values; anything unknown falls back to the default. */
export function parseAppearance(theme: string | null, scale: string | null, fallbackTheme: Theme): Appearance {
  const n = Number(scale);
  return {
    theme: theme === 'dark' || theme === 'light' ? theme : fallbackTheme,
    fontScale: (FONT_SCALES as readonly number[]).includes(n) ? n : DEFAULT_FONT_SCALE,
  };
}

/** The next font step up (+1) or down (-1), clamped to the ends of the range. */
export function stepFontScale(current: number, dir: 1 | -1): number {
  const i = FONT_SCALES.indexOf(current as (typeof FONT_SCALES)[number]);
  const at = i < 0 ? FONT_SCALES.indexOf(DEFAULT_FONT_SCALE) : i;
  return FONT_SCALES[Math.min(FONT_SCALES.length - 1, Math.max(0, at + dir))]!;
}

export const appearanceStore: Store<Appearance> = createStore<Appearance>(
  parseAppearance(read(THEME_KEY), read(FONT_SCALE_KEY), systemTheme()),
);

function apply(a: Appearance): void {
  if (typeof document === 'undefined') return; // unit tests run without a DOM
  const root = document.documentElement;
  root.classList.toggle('dark', a.theme === 'dark');
  root.style.fontSize = a.fontScale === DEFAULT_FONT_SCALE ? '' : `${a.fontScale}%`;
}

apply(appearanceStore.get());
appearanceStore.subscribe(apply);

export function toggleTheme(): void {
  appearanceStore.set((a) => {
    const theme: Theme = a.theme === 'dark' ? 'light' : 'dark';
    write(THEME_KEY, theme);
    return { ...a, theme };
  });
}

export function changeFontScale(dir: 1 | -1): void {
  appearanceStore.set((a) => {
    const fontScale = stepFontScale(a.fontScale, dir);
    write(FONT_SCALE_KEY, String(fontScale));
    return { ...a, fontScale };
  });
}
