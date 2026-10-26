// Sidebar-footer controls for the per-browser display preferences:
// smaller / larger text and a light/dark toggle (store/appearance.ts).
import type { JSX } from 'preact';
import { useStore } from '../store/store.js';
import { FONT_SCALES, appearanceStore, changeFontScale, toggleTheme } from '../store/appearance.js';

const BTN =
  'grid h-8 flex-1 place-items-center rounded-md text-stone-300 transition hover:bg-white/5 hover:text-white disabled:pointer-events-none disabled:opacity-40';

export function AppearanceControls(): JSX.Element {
  const { theme, fontScale } = useStore(appearanceStore);
  const dark = theme === 'dark';
  return (
    <div class="mb-2 flex items-center gap-1 rounded-lg border border-white/10 p-0.5" role="group" aria-label="Display">
      <button
        type="button"
        data-testid="font-smaller"
        class={BTN}
        onClick={() => changeFontScale(-1)}
        disabled={fontScale === FONT_SCALES[0]}
        title="Smaller text"
        aria-label="Smaller text"
      >
        <span class="text-xs font-bold">A−</span>
      </button>
      <button
        type="button"
        data-testid="font-larger"
        class={BTN}
        onClick={() => changeFontScale(1)}
        disabled={fontScale === FONT_SCALES[FONT_SCALES.length - 1]}
        title="Larger text"
        aria-label="Larger text"
      >
        <span class="text-base font-bold leading-none">A+</span>
      </button>
      <span class="h-5 w-px bg-white/10" aria-hidden="true" />
      <button
        type="button"
        data-testid="theme-toggle"
        class={BTN}
        onClick={toggleTheme}
        title={dark ? 'Switch to light mode' : 'Switch to dark mode'}
        aria-label={dark ? 'Switch to light mode' : 'Switch to dark mode'}
        aria-pressed={dark}
      >
        {dark ? (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" class="h-4 w-4" aria-hidden="true">
            <circle cx="12" cy="12" r="4" />
            <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" stroke-linecap="round" />
          </svg>
        ) : (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" class="h-4 w-4" aria-hidden="true">
            <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z" stroke-linejoin="round" />
          </svg>
        )}
      </button>
    </div>
  );
}
