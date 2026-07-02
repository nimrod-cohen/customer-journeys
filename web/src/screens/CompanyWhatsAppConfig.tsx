// Per-company Meta WhatsApp Cloud API credentials (§10). The company brings its own
// WhatsApp Business phone number + a permanent access token; the dispatcher uses them to
// send WhatsApp for real. With NO config, WhatsApp sends use the deterministic mock. The
// access token is write-only — never returned by the API, so the field shows a "leave
// blank to keep" placeholder once a token is stored.
import { useEffect, useState } from 'preact/hooks';
import { api } from '../store/session.js';
import { Button, Card, Field, Input, Select } from '../ui/kit.js';

interface WhatsAppConfig {
  configured: boolean;
  phone_number_id?: string;
  waba_id?: string | null;
  api_version?: string | null;
  default_country?: string | null;
}

/** A small default-country list (ISO 3166-1 alpha-2) for the picker. */
const COUNTRY_OPTIONS: ReadonlyArray<{ code: string; label: string }> = [
  { code: 'IL', label: 'Israel (+972)' },
  { code: 'US', label: 'United States (+1)' },
  { code: 'GB', label: 'United Kingdom (+44)' },
  { code: 'CA', label: 'Canada (+1)' },
  { code: 'AU', label: 'Australia (+61)' },
  { code: 'DE', label: 'Germany (+49)' },
  { code: 'FR', label: 'France (+33)' },
  { code: 'ES', label: 'Spain (+34)' },
  { code: 'IT', label: 'Italy (+39)' },
  { code: 'NL', label: 'Netherlands (+31)' },
  { code: 'IN', label: 'India (+91)' },
  { code: 'BR', label: 'Brazil (+55)' },
  { code: 'MX', label: 'Mexico (+52)' },
];

export function CompanyWhatsAppConfig() {
  const [cfg, setCfg] = useState<WhatsAppConfig | null>(null);
  const [phoneNumberId, setPhoneNumberId] = useState('');
  const [wabaId, setWabaId] = useState('');
  const [apiVersion, setApiVersion] = useState('');
  const [defaultCountry, setDefaultCountry] = useState('');
  const [token, setToken] = useState('');
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = async (): Promise<void> => {
    const r = await api.get<WhatsAppConfig>('/company/whatsapp-config');
    setCfg(r);
    setPhoneNumberId(r.phone_number_id ?? '');
    setWabaId(r.waba_id ?? '');
    setApiVersion(r.api_version ?? '');
    setDefaultCountry(r.default_country ?? '');
    setToken('');
  };
  useEffect(() => {
    void load();
  }, []);

  const save = async (): Promise<void> => {
    setError('');
    setSaved(false);
    setBusy(true);
    try {
      await api.put('/company/whatsapp-config', {
        body: {
          phone_number_id: phoneNumberId.trim(),
          waba_id: wabaId.trim(),
          api_version: apiVersion.trim(),
          default_country: defaultCountry,
          access_token: token,
        },
      });
      setToken('');
      setSaved(true);
      await load();
    } catch (e) {
      setError((e as { error?: string })?.error ?? 'Could not save the WhatsApp credentials.');
    } finally {
      setBusy(false);
    }
  };

  const remove = async (): Promise<void> => {
    setError('');
    setSaved(false);
    try {
      await api.del('/company/whatsapp-config');
      setPhoneNumberId('');
      setWabaId('');
      setApiVersion('');
      setDefaultCountry('');
      setToken('');
      await load();
    } catch (e) {
      setError((e as { error?: string })?.error ?? 'Could not remove the WhatsApp credentials.');
    }
  };

  const configured = cfg?.configured ?? false;
  // New config needs a phone number id + a token; an existing one may be re-saved
  // with a blank token (kept) as long as the phone number id is present.
  const canSave = phoneNumberId.trim().length > 0 && (configured || token.length > 0);

  return (
    <Card data-testid="channel-whatsapp-config" class="mb-6 p-5">
      <div class="flex items-center justify-between gap-3">
        <h2 class="text-base font-bold text-ink-900">WhatsApp (Meta Cloud API)</h2>
        <span
          data-testid="channel-whatsapp-status"
          class={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${
            configured ? 'bg-emerald-100 text-emerald-700' : 'bg-amber-100 text-amber-700'
          }`}
        >
          {configured ? 'configured' : 'not configured'}
        </span>
      </div>
      <p class="mt-1 text-sm text-stone-500">
        This company's own Meta WhatsApp Business account. From the app's WhatsApp → API Setup, copy the{' '}
        <strong>Phone number ID</strong> and a <strong>permanent access token</strong> (a System User token with the
        WhatsApp messaging permissions). With no credentials, WhatsApp sends use a built-in simulator (mock). Note:
        outbound WhatsApp requires an <strong>approved message template</strong> — set that per send.
      </p>

      <div class="mt-4 grid max-w-xl gap-3">
        <Field label="Phone number ID">
          <Input
            data-testid="channel-whatsapp-phone-id"
            class="font-mono text-sm"
            placeholder="e.g. 100055512345678"
            value={phoneNumberId}
            onInput={(e: Event) => setPhoneNumberId((e.target as HTMLInputElement).value)}
          />
        </Field>
        <Field label="WhatsApp Business account ID (WABA) — for managing templates">
          <Input
            data-testid="channel-whatsapp-waba-id"
            class="font-mono text-sm"
            placeholder="e.g. 102290129340398"
            value={wabaId}
            onInput={(e: Event) => setWabaId((e.target as HTMLInputElement).value)}
          />
          <p class="mt-1 text-xs text-stone-500">
            Found in WhatsApp Manager next to your account name. Required to create/manage message templates in Asset
            management.
          </p>
        </Field>
        <Field label="API version (optional)">
          <Input
            data-testid="channel-whatsapp-version"
            class="font-mono text-sm"
            placeholder="e.g. v21.0 (blank = default)"
            value={apiVersion}
            onInput={(e: Event) => setApiVersion((e.target as HTMLInputElement).value)}
          />
        </Field>
        <Field label="Default country">
          <Select
            data-testid="channel-whatsapp-country"
            value={defaultCountry}
            onChange={(e: Event) => setDefaultCountry((e.target as HTMLSelectElement).value)}
          >
            <option value="">No default (numbers must be in +E.164)</option>
            {COUNTRY_OPTIONS.map((c) => (
              <option key={c.code} value={c.code}>
                {c.label}
              </option>
            ))}
          </Select>
          <p class="mt-1 text-xs text-stone-500">
            National numbers (a leading 0, no +) are converted to international E.164 using this country before sending.
          </p>
        </Field>
        <Field label="Access token">
          <Input
            data-testid="channel-whatsapp-token"
            type="password"
            class="font-mono text-sm"
            placeholder={configured ? '•••••••• (leave blank to keep current)' : 'paste the permanent access token'}
            value={token}
            onInput={(e: Event) => setToken((e.target as HTMLInputElement).value)}
          />
        </Field>
        <div class="flex items-center gap-3">
          <Button data-testid="channel-whatsapp-save" onClick={() => save()} disabled={busy || !canSave}>
            {busy ? 'Saving…' : 'Save WhatsApp credentials'}
          </Button>
          {configured ? (
            <Button data-testid="channel-whatsapp-remove" variant="danger" size="sm" onClick={() => remove()}>
              Remove
            </Button>
          ) : null}
          {saved ? <span class="text-sm text-emerald-600">Saved ✓</span> : null}
        </div>
        {error ? (
          <p data-testid="channel-whatsapp-error" class="text-sm text-rose-600">
            {error}
          </p>
        ) : null}
      </div>
    </Card>
  );
}
