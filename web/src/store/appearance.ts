// Per-browser display preferences: light/dark theme and text size. Both live in
// localStorage (a per-viewer convenience, not account data) and are applied as a
// class + root font-size on <html>. Tailwind sizes are rem, so changing the root
// font-size scales the whole UI. index.html applies the same values before first
// paint so a reload never flashes the wrong theme.
//
// Text size is a percent of BASE_FONT_PERCENT (the app's default root size, also
// set in index.css), so 100 = the default and the slider reads naturally.
import { createStore, type Store } from './store.js';

export type Theme = 'light' | 'dark';

export const THEME_KEY = 'cdp.theme';
export const TEXT_SIZE_KEY = 'cdp.textSize';
/** The default root font-size, in percent of the browser default (16px → 20px). */
export const BASE_FONT_PERCENT = 125;
/** Slider range for text size, in percent of the default. */
export const TEXT_SIZE_MIN = 80;
export const TEXT_SIZE_MAX = 140;
export const TEXT_SIZE_STEP = 5;
export const DEFAULT_TEXT_SIZE = 100;

export interface Appearance {
  theme: Theme;
  textSize: number;
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

/** Snap a text size to the slider's grid and range. */
export function clampTextSize(n: number): number {
  if (!Number.isFinite(n)) return DEFAULT_TEXT_SIZE;
  const snapped = Math.round(n / TEXT_SIZE_STEP) * TEXT_SIZE_STEP;
  return Math.min(TEXT_SIZE_MAX, Math.max(TEXT_SIZE_MIN, snapped));
}

/** Parse stored values; anything missing or unknown falls back to the default. */
export function parseAppearance(theme: string | null, size: string | null, fallbackTheme: Theme): Appearance {
  return {
    theme: theme === 'dark' || theme === 'light' ? theme : fallbackTheme,
    textSize: size === null || size === '' ? DEFAULT_TEXT_SIZE : clampTextSize(Number(size)),
  };
}

/** The root font-size for a text size, e.g. 100 → '125%'. */
export function rootFontSize(textSize: number): string {
  return `${(BASE_FONT_PERCENT * textSize) / 100}%`;
}

export const appearanceStore: Store<Appearance> = createStore<Appearance>(
  parseAppearance(read(THEME_KEY), read(TEXT_SIZE_KEY), systemTheme()),
);

function apply(a: Appearance): void {
  if (typeof document === 'undefined') return; // unit tests run without a DOM
  const root = document.documentElement;
  root.classList.toggle('dark', a.theme === 'dark');
  root.style.fontSize = rootFontSize(a.textSize);
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

export function setTextSize(n: number): void {
  const textSize = clampTextSize(n);
  write(TEXT_SIZE_KEY, String(textSize));
  appearanceStore.set((a) => ({ ...a, textSize }));
}
