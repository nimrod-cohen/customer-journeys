// Image picker for the email designer (replaces nomentor's WP MediaPicker).
// Uploads through POST /assets (base64 JSON; capability-gated, workspace-scoped)
// and commits the PUBLIC asset URL (GET /assets/:id — the CloudFront model) as
// the image src. A plain URL can also be pasted.
import type { JSX } from 'preact';
import { useState } from 'preact/hooks';
import { api } from '../store/session.js';
import { apiBaseUrl } from '../api/client.js';

export function AssetPicker({ value, onCommit }: { value: string; onCommit: (src: string) => void }): JSX.Element {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const onFile = async (file: File): Promise<void> => {
    setBusy(true);
    setError('');
    try {
      const data_base64 = await fileToBase64(file);
      const r = await api.post<{ id: string; path: string }>('/assets', {
        body: { filename: file.name, mime: file.type, data_base64 },
      });
      onCommit(`${apiBaseUrl()}${r.path}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Upload failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <label class="nm-prop-field">
      <span class="nm-prop-label">Image</span>
      {value ? <img class="nm-asset-preview" src={value} alt="" /> : null}
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
        data-testid="asset-url"
        class="nm-prop-input"
        type="text"
        placeholder="…or paste an image URL"
        value={value}
        onChange={(e) => onCommit((e.target as HTMLInputElement).value)}
      />
      {busy ? <span class="nm-props-hint">Uploading…</span> : null}
      {error ? <span class="nm-props-error">{error}</span> : null}
    </label>
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
