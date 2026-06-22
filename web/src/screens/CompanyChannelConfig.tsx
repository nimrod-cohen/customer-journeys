// Per-company text-channel (019 SMS) credentials (§10). The company brings its
// own 019 SMS gateway account; the dispatcher uses it to send SMS for real. With
// NO config the platform falls back to the deterministic mock provider, so dev/
// tests keep working. The bearer is write-only — never returned by the API, so
// the field shows a "leave blank to keep" placeholder once a bearer is stored.
import { useEffect, useState } from 'preact/hooks';
import { api } from '../store/session.js';
import { Button, Card, Field, Input } from '../ui/kit.js';

interface ChannelConfig {
  configured: boolean;
  provider?: string;
  api_url?: string;
  username?: string;
  source?: string;
}

export function CompanyChannelConfig() {
  const [cfg, setCfg] = useState<ChannelConfig | null>(null);
  const [apiUrl, setApiUrl] = useState('');
  const [username, setUsername] = useState('');
  const [source, setSource] = useState('');
  const [secret, setSecret] = useState('');
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = async (): Promise<void> => {
    const r = await api.get<ChannelConfig>('/company/channel-config');
    setCfg(r);
    setApiUrl(r.api_url ?? '');
    setUsername(r.username ?? '');
    setSource(r.source ?? '');
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
      await api.put('/company/channel-config', {
        body: { provider: '019', api_url: apiUrl.trim(), username: username.trim(), source: source.trim(), secret },
      });
      setSecret('');
      setSaved(true);
      await load();
    } catch (e) {
      setError((e as { error?: string })?.error ?? 'Could not save the SMS credentials.');
    } finally {
      setBusy(false);
    }
  };

  const remove = async (): Promise<void> => {
    setError('');
    setSaved(false);
    try {
      await api.del('/company/channel-config');
      setApiUrl('');
      setUsername('');
      setSource('');
      setSecret('');
      await load();
    } catch (e) {
      setError((e as { error?: string })?.error ?? 'Could not remove the SMS credentials.');
    }
  };

  const configured = cfg?.configured ?? false;
  // New config requires a bearer; an existing one may be re-saved with a blank
  // bearer (kept) as long as url + username + source are present.
  const canSave =
    apiUrl.trim().length > 0 &&
    username.trim().length > 0 &&
    source.trim().length > 0 &&
    (configured || secret.length > 0);

  return (
    <Card data-testid="channel-019-config" class="mb-6 p-5">
      <div class="flex items-center justify-between gap-3">
        <h2 class="text-base font-bold text-ink-900">Text messaging (019 SMS)</h2>
        <span
          data-testid="channel-019-status"
          class={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${
            configured ? 'bg-emerald-100 text-emerald-700' : 'bg-amber-100 text-amber-700'
          }`}
        >
          {configured ? 'configured' : 'not configured'}
        </span>
      </div>
      <p class="mt-1 text-sm text-stone-500">
        This company's own 019 SMS gateway account. Used to send SMS broadcasts and campaign messages for real. With no
        credentials, SMS sends use a built-in simulator (mock) so nothing leaves the platform.
      </p>

      <div class="mt-4 grid max-w-xl gap-3">
        <Field label="API URL">
          <Input
            data-testid="channel-019-url"
            class="font-mono text-sm"
            placeholder="https://019sms.co.il/api"
            value={apiUrl}
            onInput={(e: Event) => setApiUrl((e.target as HTMLInputElement).value)}
          />
        </Field>
        <Field label="Username">
          <Input
            data-testid="channel-019-username"
            class="font-mono text-sm"
            placeholder="your 019 username"
            value={username}
            onInput={(e: Event) => setUsername((e.target as HTMLInputElement).value)}
          />
        </Field>
        <Field label="Source (sender)">
          <Input
            data-testid="channel-019-source"
            class="font-mono text-sm"
            placeholder="e.g. MyBrand"
            value={source}
            onInput={(e: Event) => setSource((e.target as HTMLInputElement).value)}
          />
        </Field>
        <Field label="Bearer token">
          <Input
            data-testid="channel-019-secret"
            type="password"
            class="font-mono text-sm"
            placeholder={configured ? '•••••••• (leave blank to keep current)' : 'enter the API bearer token'}
            value={secret}
            onInput={(e: Event) => setSecret((e.target as HTMLInputElement).value)}
          />
        </Field>
        <div class="flex items-center gap-3">
          <Button data-testid="channel-019-save" onClick={() => save()} disabled={busy || !canSave}>
            {busy ? 'Saving…' : 'Save SMS credentials'}
          </Button>
          {configured ? (
            <Button data-testid="channel-019-remove" variant="danger" size="sm" onClick={() => remove()}>
              Remove
            </Button>
          ) : null}
          {saved ? <span class="text-sm text-emerald-600">Saved ✓</span> : null}
        </div>
        {error ? (
          <p data-testid="channel-019-error" class="text-sm text-rose-600">
            {error}
          </p>
        ) : null}
      </div>
    </Card>
  );
}
