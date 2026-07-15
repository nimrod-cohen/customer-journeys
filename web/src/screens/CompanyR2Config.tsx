// Per-company image storage (Cloudflare R2, S3-compatible). The company brings its
// own bucket + keys so it pays for its own storage; uploaded images go there and
// are streamed back through the app (same domain). The secret is write-only — never
// returned by the API. A one-time "Migrate existing images" moves any images still
// stored in the database into the bucket.
import { useEffect, useState } from 'preact/hooks';
import { api } from '../store/session.js';
import { Button, Card, Field, Input } from '../ui/kit.js';
import { showToast } from '../ui/toast.tsx';

interface R2Config {
  configured: boolean;
  endpoint?: string;
  bucket?: string;
  access_key_id?: string;
  region?: string;
  pending_db_assets?: number;
}

export function CompanyR2Config() {
  const [cfg, setCfg] = useState<R2Config | null>(null);
  const [endpoint, setEndpoint] = useState('');
  const [bucket, setBucket] = useState('');
  const [accessKey, setAccessKey] = useState('');
  const [secret, setSecret] = useState('');
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = async (): Promise<void> => {
    const r = await api.get<R2Config>('/company/r2-config');
    setCfg(r);
    setEndpoint(r.endpoint ?? '');
    setBucket(r.bucket ?? '');
    setAccessKey(r.access_key_id ?? '');
    setSecret('');
  };
  useEffect(() => {
    void load();
  }, []);

  const save = async (): Promise<void> => {
    setError('');
    setSaved(false);
    setBusy(true);
    try {
      await api.put('/company/r2-config', {
        body: { endpoint: endpoint.trim(), bucket: bucket.trim(), access_key_id: accessKey.trim(), secret_access_key: secret },
      });
      setSecret('');
      setSaved(true);
      await load();
    } catch (e) {
      setError((e as { error?: string })?.error ?? 'Could not save the R2 credentials.');
    } finally {
      setBusy(false);
    }
  };

  const remove = async (): Promise<void> => {
    setError('');
    setSaved(false);
    try {
      await api.del('/company/r2-config');
      setEndpoint('');
      setBucket('');
      setAccessKey('');
      setSecret('');
      await load();
    } catch (e) {
      setError((e as { error?: string })?.error ?? 'Could not remove the R2 credentials.');
    }
  };

  // Move any images still stored in the database into the bucket (one-time).
  const backfill = async (): Promise<void> => {
    try {
      const r = await api.post<{ migrated: number }>('/assets/backfill-r2', { body: {} });
      showToast(
        r.migrated > 0 ? `Migrated ${r.migrated} image${r.migrated === 1 ? '' : 's'} to R2.` : 'No images left in the database — all set.',
        { tone: 'success' },
      );
      await load(); // refresh pending count → the button hides once nothing's left
    } catch (e) {
      showToast((e as { error?: string })?.error ?? 'Could not migrate images.', { tone: 'error' });
    }
  };

  const configured = cfg?.configured ?? false;
  const pendingDbAssets = cfg?.pending_db_assets ?? 0;
  const canSave =
    endpoint.trim().length > 0 && bucket.trim().length > 0 && accessKey.trim().length > 0 && (configured || secret.length > 0);

  return (
    <Card data-testid="r2-config" class="mb-6 p-5">
      <div class="flex items-center justify-between gap-3">
        <h2 class="text-base font-bold text-ink-900">Image storage (Cloudflare R2)</h2>
        <span
          data-testid="r2-status"
          class={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${
            configured ? 'bg-emerald-100 text-emerald-700' : 'bg-amber-100 text-amber-700'
          }`}
        >
          {configured ? 'configured' : 'not configured'}
        </span>
      </div>
      <p class="mt-1 text-sm text-stone-500">
        This company's own Cloudflare R2 (S3-compatible) bucket for uploaded images. When set, uploads go to your bucket and
        are served through the app; without it, images are kept in the database. Create an R2 API token (Object Read &amp;
        Write) for the values below.
      </p>

      <div class="mt-4 grid max-w-xl gap-3">
        <Field label="S3 endpoint">
          <Input
            data-testid="r2-endpoint"
            class="font-mono text-sm"
            placeholder="https://<accountid>.r2.cloudflarestorage.com"
            value={endpoint}
            onInput={(e: Event) => setEndpoint((e.target as HTMLInputElement).value)}
          />
        </Field>
        <Field label="Bucket">
          <Input
            data-testid="r2-bucket"
            class="font-mono text-sm"
            placeholder="my-company-assets"
            value={bucket}
            onInput={(e: Event) => setBucket((e.target as HTMLInputElement).value)}
          />
        </Field>
        <Field label="Access key ID">
          <Input
            data-testid="r2-access-key"
            class="font-mono text-sm"
            placeholder="R2 token access key id"
            value={accessKey}
            onInput={(e: Event) => setAccessKey((e.target as HTMLInputElement).value)}
          />
        </Field>
        <Field label="Secret access key">
          <Input
            data-testid="r2-secret"
            type="password"
            class="font-mono text-sm"
            placeholder={configured ? '•••••••• (leave blank to keep current)' : 'enter the secret access key'}
            value={secret}
            onInput={(e: Event) => setSecret((e.target as HTMLInputElement).value)}
          />
        </Field>
        <div class="flex flex-wrap items-center gap-3">
          <Button data-testid="r2-save" onClick={() => save()} disabled={busy || !canSave}>
            {busy ? 'Saving…' : 'Save R2 credentials'}
          </Button>
          {configured ? (
            <>
              {pendingDbAssets > 0 ? (
                <Button data-testid="r2-backfill" variant="secondary" size="sm" onClick={() => backfill()}>
                  Migrate {pendingDbAssets} existing image{pendingDbAssets === 1 ? '' : 's'}
                </Button>
              ) : null}
              <Button data-testid="r2-remove" variant="danger" size="sm" onClick={() => remove()}>
                Remove
              </Button>
            </>
          ) : null}
          {saved ? <span class="text-sm text-emerald-600">Saved ✓</span> : null}
        </div>
        {error ? (
          <p data-testid="r2-error" class="text-sm text-rose-600">
            {error}
          </p>
        ) : null}
      </div>
    </Card>
  );
}
