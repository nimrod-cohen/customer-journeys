// Image picker for the email designer (§11). Every upload lands in the
// workspace's GALLERY (the assets table) under an optional folder; picking an
// image offers BOTH: upload a new one (into a folder) or browse the gallery by
// subfolder and reuse an existing image. Serving is public-by-uuid (the
// CloudFront model) so the chosen URL works inside delivered emails.
import type { JSX } from 'preact';
import { useState } from 'preact/hooks';
import { api } from '../store/session.js';
import { apiBaseUrl } from '../api/client.js';

interface GalleryAsset {
  readonly id: string;
  readonly filename: string;
  readonly mime: string;
  readonly folder: string;
  readonly path: string;
}

export function AssetPicker({ value, onCommit }: { value: string; onCommit: (src: string) => void }): JSX.Element {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [folder, setFolder] = useState('');
  const [galleryOpen, setGalleryOpen] = useState(false);
  const [assets, setAssets] = useState<GalleryAsset[] | null>(null);
  const [activeFolder, setActiveFolder] = useState('');

  const loadGallery = async (): Promise<void> => {
    const r = await api.get<{ assets: GalleryAsset[] }>('/assets');
    setAssets(r.assets);
  };

  const onFile = async (file: File): Promise<void> => {
    setBusy(true);
    setError('');
    try {
      const data_base64 = await fileToBase64(file);
      const r = await api.post<{ id: string; path: string }>('/assets', {
        body: { filename: file.name, mime: file.type, data_base64, folder },
      });
      onCommit(`${apiBaseUrl()}${r.path}`);
      if (assets) void loadGallery(); // the gallery (if open) shows the new upload
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Upload failed');
    } finally {
      setBusy(false);
    }
  };

  const folders = [...new Set((assets ?? []).map((a) => a.folder))].sort();
  const shown = (assets ?? []).filter((a) => a.folder === activeFolder);

  return (
    <div class="nm-prop-field">
      <span class="nm-prop-label">Image</span>
      {value ? <img class="nm-asset-preview" src={value} alt="" /> : null}

      {/* Upload a new image (into a gallery folder) */}
      <input
        data-testid="asset-file"
        class="nm-prop-input"
        type="file"
        accept="image/png,image/jpeg,image/gif,image/webp,image/svg+xml"
        disabled={busy}
        onChange={(e) => {
          const file = (e.target as HTMLInputElement).files?.[0];
          if (file) void onFile(file);
        }}
      />
      <input
        data-testid="asset-folder"
        class="nm-prop-input nm-mt-4"
        type="text"
        list="nm-gallery-folders"
        placeholder="Gallery folder (e.g. logos) — optional"
        value={folder}
        onInput={(e) => setFolder((e.target as HTMLInputElement).value)}
        onFocus={() => {
          if (!assets) void loadGallery(); // folder suggestions
        }}
      />
      <datalist id="nm-gallery-folders">
        {folders.filter(Boolean).map((f) => (
          <option key={f} value={f} />
        ))}
      </datalist>

      {/* Browse the gallery */}
      <button
        type="button"
        data-testid="gallery-toggle"
        class="nm-btn nm-mt-4"
        onClick={() => {
          setGalleryOpen((v) => !v);
          if (!assets) void loadGallery();
        }}
      >
        {galleryOpen ? 'Close gallery' : 'Choose from gallery…'}
      </button>
      {galleryOpen ? (
        <div data-testid="asset-gallery" class="nm-gallery">
          <div class="nm-gallery-folders">
            <button
              type="button"
              class={`nm-mini-btn ${activeFolder === '' ? 'nm-active' : ''}`}
              onClick={() => setActiveFolder('')}
            >
              (root)
            </button>
            {folders.filter(Boolean).map((f) => (
              <button
                key={f}
                type="button"
                data-testid="gallery-folder"
                class={`nm-mini-btn ${activeFolder === f ? 'nm-active' : ''}`}
                onClick={() => setActiveFolder(f)}
              >
                {f}
              </button>
            ))}
          </div>
          {assets === null ? (
            <p class="nm-props-hint">Loading…</p>
          ) : shown.length === 0 ? (
            <p class="nm-props-hint">No images in this folder yet.</p>
          ) : (
            <div class="nm-gallery-grid">
              {shown.map((a) => (
                <button
                  key={a.id}
                  type="button"
                  data-testid="gallery-item"
                  class="nm-gallery-item"
                  title={a.filename}
                  onClick={() => {
                    onCommit(`${apiBaseUrl()}${a.path}`);
                    setGalleryOpen(false);
                  }}
                >
                  <img src={`${apiBaseUrl()}${a.path}`} alt={a.filename} loading="lazy" />
                  <span>{a.filename}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      ) : null}

      {/* …or paste a URL directly */}
      <input
        data-testid="asset-url"
        class="nm-prop-input nm-mt-4"
        type="text"
        placeholder="…or paste an image URL"
        value={value}
        onChange={(e) => onCommit((e.target as HTMLInputElement).value)}
      />
      {busy ? <span class="nm-props-hint">Uploading…</span> : null}
      {error ? <span class="nm-props-error">{error}</span> : null}
    </div>
  );
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const s = String(reader.result ?? '');
      resolve(s.includes(',') ? s.slice(s.indexOf(',') + 1) : s); // strip the data: prefix
    };
    reader.onerror = () => reject(new Error('could not read file'));
    reader.readAsDataURL(file);
  });
}
