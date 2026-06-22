// Per-company LOGO (CLAUDE.md company-settings). The company can set one logo
// (an uploaded image) that renders atop the public unsubscribe + manage-
// subscription pages. Reuses the existing asset pipeline: the file is uploaded
// via POST /assets (workspace-scoped, served public-by-uuid), then the company
// is pointed at it via PUT /company/logo. The logo is OPTIONAL — Remove clears
// it. Server-calling buttons return their promise so the kit Button auto-locks.
import { useEffect, useRef, useState } from 'preact/hooks';
import { api } from '../store/session.js';
import { apiBaseUrl } from '../api/client.js';
import { Button, Card } from '../ui/kit.js';

interface LogoState {
  logo_url: string | null;
}

/** Read a File as a bare base64 string (no data: prefix) — same as AssetManager. */
function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const s = String(reader.result ?? '');
      resolve(s.includes(',') ? s.slice(s.indexOf(',') + 1) : s);
    };
    reader.onerror = () => reject(new Error('could not read file'));
    reader.readAsDataURL(file);
  });
}

export function CompanyLogo() {
  const [logoUrl, setLogoUrl] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  const load = async (): Promise<void> => {
    const r = await api.get<LogoState>('/company/logo');
    setLogoUrl(r.logo_url ?? null);
  };
  useEffect(() => {
    void load();
  }, []);

  const upload = async (file: File): Promise<void> => {
    setError('');
    setStatus('');
    try {
      const data_base64 = await fileToBase64(file);
      // 1) upload the image into the workspace gallery (the existing pipeline)…
      const up = await api.post<{ id: string; path: string }>('/assets', {
        body: { filename: file.name, mime: file.type, data_base64, folder: 'logos' },
      });
      // 2) …then point the company at it.
      const r = await api.put<LogoState>('/company/logo', { body: { asset_id: up.id } });
      setLogoUrl(r.logo_url ?? null);
      setStatus('Logo updated');
    } catch (e) {
      setError((e as { error?: string })?.error ?? 'Could not upload the logo.');
    }
  };

  const remove = async (): Promise<void> => {
    setError('');
    setStatus('');
    try {
      await api.del('/company/logo');
      setLogoUrl(null);
      setStatus('Logo removed');
    } catch (e) {
      setError((e as { error?: string })?.error ?? 'Could not remove the logo.');
    }
  };

  return (
    <Card data-testid="company-logo" class="mb-6 p-5">
      <h2 class="text-base font-bold text-ink-900">Logo</h2>
      <p class="mt-1 text-sm text-stone-500">
        Shown at the top of the public unsubscribe and subscription-preference pages your recipients see. Optional — a PNG
        or JPG works best.
      </p>

      <div class="mt-4 flex flex-wrap items-center gap-4">
        {logoUrl ? (
          <img
            data-testid="company-logo-img"
            src={`${apiBaseUrl()}${logoUrl}`}
            alt="Company logo"
            class="max-h-16 rounded border border-stone-200 bg-white p-1"
          />
        ) : (
          <div class="grid h-16 w-32 place-items-center rounded border border-dashed border-stone-300 text-xs text-stone-400">
            No logo
          </div>
        )}
        <div class="flex items-center gap-2">
          <input
            ref={fileRef}
            type="file"
            accept="image/png,image/jpeg,image/gif,image/webp,image/svg+xml"
            class="hidden"
            data-testid="company-logo-file"
            onChange={(e: Event) => {
              const f = (e.target as HTMLInputElement).files?.[0];
              if (f) void upload(f);
              (e.target as HTMLInputElement).value = '';
            }}
          />
          <Button
            data-testid="company-logo-upload"
            variant="secondary"
            size="sm"
            onClick={async () => {
              fileRef.current?.click();
            }}
          >
            {logoUrl ? 'Replace logo' : 'Upload logo'}
          </Button>
          {logoUrl ? (
            <Button data-testid="company-logo-remove" variant="danger" size="sm" onClick={() => remove()}>
              Remove
            </Button>
          ) : null}
        </div>
      </div>

      {status ? (
        <p data-testid="company-logo-status" class="mt-2 text-sm text-emerald-600">
          {status}
        </p>
      ) : null}
      {error ? (
        <p data-testid="company-logo-error" class="mt-2 text-sm text-rose-600">
          {error}
        </p>
      ) : null}
    </Card>
  );
}
