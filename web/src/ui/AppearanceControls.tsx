// Sidebar-footer controls for the per-browser display preferences:
// a text-size slider and a light/dark toggle (store/appearance.ts).
import type { JSX } from 'preact';
import { useStore } from '../store/store.js';
import {
  TEXT_SIZE_MAX,
  TEXT_SIZE_MIN,
  TEXT_SIZE_STEP,
  appearanceStore,
  setTextSize,
  toggleTheme,
} from '../store/appearance.js';

export function AppearanceControls(): JSX.Element {
  const { theme, textSize } = useStore(appearanceStore);
  const dark = theme === 'dark';
  return (
    <div class="mb-2 flex items-center gap-2 rounded-lg border border-white/10 py-1 pl-2.5 pr-0.5" role="group" aria-label="Display">
      <span class="text-[11px] font-bold text-stone-400" aria-hidden="true">
        A
      </span>
      <input
        type="range"
        data-testid="text-size"
        min={TEXT_SIZE_MIN}
        max={TEXT_SIZE_MAX}
        step={TEXT_SIZE_STEP}
        value={textSize}
        onInput={(e) => setTextSize(Number((e.target as HTMLInputElement).value))}
        onDblClick={() => setTextSize(100)}
        class="h-1 min-w-0 flex-1 cursor-pointer accent-brand-400"
        title={`Text size ${textSize}% (double-click to reset)`}
        aria-label="Text size"
        aria-valuetext={`${textSize}%`}
      />
      <span class="text-base font-bold leading-none text-stone-400" aria-hidden="true">
        A
      </span>
      <span class="h-5 w-px bg-white/10" aria-hidden="true" />
      <button
        type="button"
        data-testid="theme-toggle"
        class="grid h-8 w-8 shrink-0 place-items-center rounded-md text-stone-300 transition hover:bg-white/5 hover:text-white"
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
