// Per-company Amazon SES credentials (§10). The company brings its own AWS SES
// account; these are used to verify the company's sending domains and (later) to
// send. The secret is write-only — never returned by the API, so the field shows
// a "leave blank to keep" placeholder once a secret is stored.
import { useEffect, useState } from 'preact/hooks';
import { api } from '../store/session.js';
import { Button, Card, Field, Input } from '../ui/kit.js';

interface SesConfig {
  configured: boolean;
  region?: string;
  access_key_id?: string;
}

export function CompanySesConfig() {
  const [cfg, setCfg] = useState<SesConfig | null>(null);
  const [region, setRegion] = useState('');
  const [accessKey, setAccessKey] = useState('');
  const [secret, setSecret] = useState('');
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = async (): Promise<void> => {
    const r = await api.get<SesConfig>('/company/ses-config');
    setCfg(r);
    setRegion(r.region ?? '');
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
      await api.put('/company/ses-config', {
        body: { region: region.trim(), access_key_id: accessKey.trim(), secret_access_key: secret },
      });
      setSecret('');
      setSaved(true);
      await load();
    } catch (e) {
      setError((e as { error?: string })?.error ?? 'Could not save the SES credentials.');
    } finally {
      setBusy(false);
    }
  };

  const remove = async (): Promise<void> => {
    setError('');
    setSaved(false);
    try {
      await api.del('/company/ses-config');
      setRegion('');
      setAccessKey('');
      setSecret('');
      await load();
    } catch (e) {
      setError((e as { error?: string })?.error ?? 'Could not remove the SES credentials.');
    }
  };

  const configured = cfg?.configured ?? false;
  // New config requires a secret; an existing one may be re-saved with a blank
  // secret (kept) as long as region + key are present.
  const canSave = region.trim().length > 0 && accessKey.trim().length > 0 && (configured || secret.length > 0);

  return (
    <Card data-testid="ses-config" class="mb-6 p-5">
      <div class="flex items-center justify-between gap-3">
        <h2 class="text-base font-bold text-ink-900">Amazon SES (email sending)</h2>
        <span
          data-testid="ses-status"
          class={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${
            configured ? 'bg-emerald-100 text-emerald-700' : 'bg-amber-100 text-amber-700'
          }`}
        >
          {configured ? 'configured' : 'not configured'}
        </span>
      </div>
      <p class="mt-1 text-sm text-stone-500">
        This company's own AWS SES credentials. Used to verify its sending domains and send email. The region must match
        where you verify domains in SES.
      </p>

      <div class="mt-4 grid max-w-xl gap-3">
        <Field label="AWS region">
          <Input
            data-testid="ses-region"
            class="font-mono text-sm"
            placeholder="il-central-1"
            value={region}
            onInput={(e: Event) => setRegion((e.target as HTMLInputElement).value)}
          />
        </Field>
        <Field label="Access key ID">
          <Input
            data-testid="ses-access-key"
            class="font-mono text-sm"
            placeholder="AKIA…"
            value={accessKey}
            onInput={(e: Event) => setAccessKey((e.target as HTMLInputElement).value)}
          />
        </Field>
        <Field label="Secret access key">
          <Input
            data-testid="ses-secret"
            type="password"
            class="font-mono text-sm"
            placeholder={configured ? '•••••••• (leave blank to keep current)' : 'enter the secret access key'}
            value={secret}
            onInput={(e: Event) => setSecret((e.target as HTMLInputElement).value)}
          />
        </Field>
        <div class="flex items-center gap-3">
          <Button data-testid="ses-save" onClick={() => void save()} disabled={busy || !canSave}>
            {busy ? 'Saving…' : 'Save SES credentials'}
          </Button>
          {configured ? (
            <Button data-testid="ses-remove" variant="danger" size="sm" onClick={() => void remove()}>
              Remove
            </Button>
          ) : null}
          {saved ? <span class="text-sm text-emerald-600">Saved ✓</span> : null}
        </div>
        {error ? (
          <p data-testid="ses-error" class="text-sm text-rose-600">
            {error}
          </p>
        ) : null}
      </div>
    </Card>
  );
}
