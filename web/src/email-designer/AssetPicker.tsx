// Image field for the properties panel (§11): a preview + a "Select image"
// button that opens the full Asset Manager modal (gallery folders, search,
// upload) — no raw file input in the panel. A URL can still be pasted directly.
import type { JSX } from 'preact';
import { useState } from 'preact/hooks';
import { AssetManager } from './AssetManager.tsx';
import { ImagePlus } from './manager-icons.ts';

export function AssetPicker({ value, onCommit }: { value: string; onCommit: (src: string) => void }): JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <div class="nm-prop-field">
      <span class="nm-prop-label">Image</span>
      {value ? <img class="nm-asset-preview" src={value} alt="" /> : null}
      <button type="button" data-testid="asset-select" class="nm-btn nm-am-open" onClick={() => setOpen(true)}>
        <ImagePlus size={14} /> {value ? 'Change image…' : 'Select image…'}
      </button>
      <input
        data-testid="asset-url"
        class="nm-prop-input nm-mt-4"
        type="text"
        placeholder="…or paste an image URL"
        value={value}
        onChange={(e) => onCommit((e.target as HTMLInputElement).value)}
      />
      {open ? (
        <AssetManager
          onSelect={(url) => {
            onCommit(url);
            setOpen(false);
          }}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </div>
  );
}
