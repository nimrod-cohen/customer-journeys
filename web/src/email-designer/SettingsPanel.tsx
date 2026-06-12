// Template settings panel (port of nomentor's Settings.jsx, narrowed to the
// per-template email settings stored in design.settings): direction (RTL),
// Google font (curated list incl. Hebrew-capable families — serialized as
// mj-font), base font size, body width, page background and the color palette
// (quick-pick chips in the color fields).
import type { JSX } from 'preact';
import { useState } from 'preact/hooks';
import { settings, updateSettings } from './state.js';

/** Curated Google fonts (all load via mj-font); Hebrew-capable ones marked. */
const FONTS: ReadonlyArray<readonly [string, string]> = [
  ['', 'Default (Ubuntu/Helvetica)'],
  ['Rubik', 'Rubik (עברית)'],
  ['Heebo', 'Heebo (עברית)'],
  ['Assistant', 'Assistant (עברית)'],
  ['Open Sans', 'Open Sans (עברית)'],
  ['Noto Sans Hebrew', 'Noto Sans Hebrew (עברית)'],
  ['Roboto', 'Roboto'],
  ['Lato', 'Lato'],
  ['Montserrat', 'Montserrat'],
  ['Poppins', 'Poppins'],
  ['Merriweather', 'Merriweather'],
  ['Playfair Display', 'Playfair Display'],
];

const loadedFonts = new Set<string>();
function loadGoogleFontCss(family: string): void {
  if (!family || loadedFonts.has(family)) return;
  loadedFonts.add(family);
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(family)}:wght@300;400;500;600;700&display=swap`;
  document.head.appendChild(link);
}

export function SettingsPanel(): JSX.Element {
  const st = settings.value;
  const [colorName, setColorName] = useState('');
  const [colorValue, setColorValue] = useState('#4a90d9');
  if (st.fontFamily) loadGoogleFontCss(st.fontFamily);

  return (
    <div data-testid="designer-settings" class="nm-props">
      <div class="nm-panel-title">Template settings</div>

      <label class="nm-prop-field">
        <span class="nm-prop-label">Direction</span>
        <select
          data-testid="settings-direction"
          class="nm-prop-input"
          value={st.direction ?? 'ltr'}
          onChange={(e) => updateSettings({ direction: (e.target as HTMLSelectElement).value as 'rtl' | 'ltr' })}
        >
          <option value="ltr">Left to right</option>
          <option value="rtl">Right to left (עברית)</option>
        </select>
      </label>

      <label class="nm-prop-field">
        <span class="nm-prop-label">Font</span>
        <select
          data-testid="settings-font"
          class="nm-prop-input"
          value={st.fontFamily ?? ''}
          onChange={(e) => {
            const v = (e.target as HTMLSelectElement).value;
            if (v) loadGoogleFontCss(v);
            updateSettings({ fontFamily: v || undefined });
          }}
        >
          {FONTS.map(([v, label]) => (
            <option key={v} value={v} style={v ? { fontFamily: v } : undefined}>
              {label}
            </option>
          ))}
        </select>
      </label>

      <label class="nm-prop-field">
        <span class="nm-prop-label">Base font size (px)</span>
        <input
          class="nm-prop-input"
          type="number"
          min={10}
          max={24}
          value={st.baseFontSize ?? 16}
          onChange={(e) => updateSettings({ baseFontSize: Number((e.target as HTMLInputElement).value) || 16 })}
        />
      </label>

      <label class="nm-prop-field">
        <span class="nm-prop-label">Email width (px)</span>
        <input
          class="nm-prop-input"
          type="number"
          min={320}
          max={800}
          value={st.bodyWidth ?? 600}
          onChange={(e) => updateSettings({ bodyWidth: Number((e.target as HTMLInputElement).value) || 600 })}
        />
      </label>

      <label class="nm-prop-field">
        <span class="nm-prop-label">Page background</span>
        <div class="nm-color-field">
          <input
            type="color"
            value={st.bgColor ?? '#f4f4f4'}
            onChange={(e) => updateSettings({ bgColor: (e.target as HTMLInputElement).value })}
          />
          <input
            class="nm-prop-input"
            type="text"
            value={st.bgColor ?? ''}
            placeholder="none"
            onChange={(e) => updateSettings({ bgColor: (e.target as HTMLInputElement).value || undefined })}
          />
        </div>
      </label>

      <label class="nm-prop-field">
        <span class="nm-prop-label">Color palette</span>
        <div class="nm-list-items">
          {(st.colors ?? []).map((c) => (
            <div key={c.name} class="nm-list-item-row">
              <span class="nm-palette-chip" style={{ backgroundColor: c.value }} />
              <span class="nm-palette-name">{c.name}</span>
              <button
                type="button"
                class="nm-mini-btn"
                title="Remove color"
                onClick={() => updateSettings({ colors: (st.colors ?? []).filter((x) => x.name !== c.name) })}
              >
                ✕
              </button>
            </div>
          ))}
          <div class="nm-list-item-row">
            <input type="color" value={colorValue} onInput={(e) => setColorValue((e.target as HTMLInputElement).value)} />
            <input
              class="nm-prop-input"
              type="text"
              placeholder="name (e.g. brand)"
              value={colorName}
              onInput={(e) => setColorName((e.target as HTMLInputElement).value)}
            />
            <button
              type="button"
              class="nm-mini-btn"
              disabled={!colorName.trim()}
              onClick={() => {
                const name = colorName.trim();
                if (!name) return;
                const others = (st.colors ?? []).filter((x) => x.name !== name);
                updateSettings({ colors: [...others, { name, value: colorValue }] });
                setColorName('');
              }}
            >
              +
            </button>
          </div>
        </div>
      </label>
    </div>
  );
}
