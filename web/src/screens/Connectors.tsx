// Connectors (§10) — a company connects PROVIDERS; each powers a messaging CHANNEL
// (email / sms / whatsapp). A channel is enabled when a provider that can send on it
// is connected; broadcasts + automations gate on that (GET /company/channels). A
// channel with several providers (Email: SES or Resend) shows a LOGO PICKER — you
// choose one provider and see only its connection details. Secrets are write-only.
import { useEffect, useState } from 'preact/hooks';
import type { JSX } from 'preact';
import { api } from '../store/session.js';
import { Button, Card, Field, Input } from '../ui/kit.js';
import { showToast } from '../ui/toast.tsx';

interface ProviderField {
  key: string;
  label: string;
  placeholder?: string;
  optional?: boolean;
}
interface ProviderSpec {
  provider: string;
  fields: ProviderField[];
  secretLabel: string;
  hint?: string;
}
interface ChannelSpec {
  channel: 'email' | 'sms' | 'whatsapp';
  label: string;
  providers: ProviderSpec[];
}

// --- provider "logos" (brand colour + glyph) ----------------------------------
function EnvelopeGlyph(): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" class="h-4 w-4" aria-hidden="true">
      <path d="M1.5 8.67v8.58a3 3 0 0 0 3 3h15a3 3 0 0 0 3-3V8.67l-8.928 5.493a3 3 0 0 1-3.144 0L1.5 8.67Z" />
      <path d="M22.5 6.908V6.75a3 3 0 0 0-3-3h-15a3 3 0 0 0-3 3v.158l9.714 5.978a1.5 1.5 0 0 0 1.572 0L22.5 6.908Z" />
    </svg>
  );
}
function ChatGlyph(): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" class="h-4 w-4" aria-hidden="true">
      <path d="M4.848 2.771A49 49 0 0 1 12 2.25c2.43 0 4.817.178 7.152.52 1.978.292 3.348 2.024 3.348 3.97v6.02c0 1.946-1.37 3.678-3.348 3.97a48 48 0 0 1-3.152.435l-3.6 3.6a.75.75 0 0 1-1.28-.53v-3.09a49 49 0 0 1-3.12-.415C2.87 16.438 1.5 14.706 1.5 12.76V6.74c0-1.946 1.37-3.678 3.348-3.97Z" />
    </svg>
  );
}
function WhatsAppGlyph(): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" class="h-4 w-4" aria-hidden="true">
      <path d="M12.04 2C6.58 2 2.13 6.45 2.13 11.91c0 1.75.46 3.45 1.32 4.95L2 22l5.25-1.38a9.9 9.9 0 0 0 4.79 1.22c5.46 0 9.91-4.45 9.91-9.91C21.95 6.45 17.5 2 12.04 2Zm5.8 14.09c-.24.68-1.2 1.26-1.97 1.42-.53.11-1.22.2-3.56-.77-2.99-1.24-4.9-4.28-5.05-4.48-.15-.2-1.2-1.6-1.2-3.06s.77-2.17 1.04-2.47c.24-.27.53-.34.7-.34.18 0 .35 0 .5.01.16.01.38-.06.59.45.24.57.8 1.98.87 2.12.07.14.12.31.02.5-.1.2-.15.31-.3.48-.15.17-.31.38-.44.51-.15.15-.3.31-.13.6.17.29.77 1.27 1.65 2.06 1.13 1.01 2.09 1.32 2.38 1.47.29.15.46.12.63-.07.17-.2.72-.84.91-1.13.19-.29.38-.24.64-.14.26.1 1.67.79 1.96.93.29.15.48.22.55.34.07.12.07.68-.17 1.36Z" />
    </svg>
  );
}
const PROVIDER_META: Record<string, { label: string; color: string; glyph: () => JSX.Element }> = {
  ses: { label: 'Amazon SES', color: '#FF9900', glyph: EnvelopeGlyph },
  resend: { label: 'Resend', color: '#0B0B0B', glyph: EnvelopeGlyph },
  '019': { label: '019 SMS', color: '#0EA5E9', glyph: ChatGlyph },
  meta_whatsapp: { label: 'Meta WhatsApp', color: '#25D366', glyph: WhatsAppGlyph },
};
function ProviderLogo({ provider, size = 'md' }: { provider: string; size?: 'sm' | 'md' }): JSX.Element {
  const m = PROVIDER_META[provider]!;
  const Glyph = m.glyph;
  return (
    <span
      class={`grid shrink-0 place-items-center rounded-lg text-white ${size === 'sm' ? 'h-7 w-7' : 'h-9 w-9'}`}
      style={{ backgroundColor: m.color }}
    >
      <Glyph />
    </span>
  );
}

const CHANNELS: ChannelSpec[] = [
  {
    channel: 'email',
    label: 'Email',
    providers: [
      {
        provider: 'ses',
        fields: [
          { key: 'region', label: 'AWS region', placeholder: 'il-central-1' },
          { key: 'access_key_id', label: 'Access key ID', placeholder: 'AKIA…' },
        ],
        secretLabel: 'Secret access key',
        hint: 'Needs a verified sending domain (Workspace settings → Sending domains). The region must match where you verify domains in SES.',
      },
      {
        provider: 'resend',
        fields: [{ key: 'from', label: 'From', placeholder: 'Acme <news@acme.com>' }],
        secretLabel: 'API key',
        hint: 'Verify your domain in the Resend dashboard, then enter your API key + the From you send as. No in-app domain verification needed.',
      },
    ],
  },
  {
    channel: 'sms',
    label: 'SMS',
    providers: [
      {
        provider: '019',
        fields: [
          { key: 'api_url', label: 'API URL', placeholder: 'https://…' },
          { key: 'username', label: 'Username' },
          { key: 'source', label: 'Source (sender)' },
          { key: 'default_country', label: 'Default country (ISO-2)', placeholder: 'IL', optional: true },
        ],
        secretLabel: 'Bearer token',
      },
    ],
  },
  {
    channel: 'whatsapp',
    label: 'WhatsApp',
    providers: [
      {
        provider: 'meta_whatsapp',
        fields: [
          { key: 'phone_number_id', label: 'Phone number ID' },
          { key: 'waba_id', label: 'WhatsApp Business Account ID', optional: true },
          { key: 'api_version', label: 'API version', placeholder: 'v21.0', optional: true },
          { key: 'default_country', label: 'Default country (ISO-2)', placeholder: 'IL', optional: true },
        ],
        secretLabel: 'Access token',
      },
    ],
  },
];

interface Connector {
  id: string;
  channel: string;
  provider: string;
  config: Record<string, unknown>;
  enabled: boolean;
  has_secret: boolean;
}
interface Channels {
  email: boolean;
  sms: boolean;
  whatsapp: boolean;
}

export function ConnectorsPanel() {
  const [connectors, setConnectors] = useState<Connector[]>([]);
  const [channels, setChannels] = useState<Channels>({ email: false, sms: false, whatsapp: false });

  const load = async (): Promise<void> => {
    const [c, ch] = await Promise.all([
      api.get<{ connectors: Connector[] }>('/company/connectors'),
      api.get<{ channels: Channels }>('/company/channels'),
    ]);
    setConnectors(c.connectors);
    setChannels(ch.channels);
  };
  useEffect(() => {
    void load();
  }, []);

  return (
    <section data-testid="connectors-screen">
      {CHANNELS.map((ch) => (
        <ChannelBox key={ch.channel} ch={ch} connectors={connectors} enabled={channels[ch.channel]} onChanged={load} />
      ))}
    </section>
  );
}

function ChannelBox({ ch, connectors, enabled, onChanged }: { ch: ChannelSpec; connectors: Connector[]; enabled: boolean; onChanged: () => Promise<void> }) {
  const configured = connectors.find((c) => c.channel === ch.channel) ?? null;
  const [selected, setSelected] = useState<string>(configured?.provider ?? ch.providers[0]!.provider);
  // Follow the configured provider when it loads/changes.
  useEffect(() => {
    if (configured) setSelected(configured.provider);
  }, [configured?.provider]);
  const spec = ch.providers.find((p) => p.provider === selected) ?? ch.providers[0]!;
  const existing = connectors.find((c) => c.provider === selected) ?? null;
  const multi = ch.providers.length > 1;

  return (
    <Card data-testid={`connector-channel-${ch.channel}`} class="mb-6 p-5">
      <div class="flex items-center justify-between gap-3">
        <h2 class="text-base font-bold text-ink-900">{ch.label}</h2>
        <span
          data-testid={`channel-status-${ch.channel}`}
          class={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${
            enabled ? 'bg-emerald-100 text-emerald-700' : 'bg-stone-200 text-stone-600'
          }`}
        >
          {enabled ? 'enabled' : 'disabled'}
        </span>
      </div>
      <p class="mt-1 text-sm text-stone-500">
        {enabled
          ? `Broadcasts and automations can send over ${ch.label}.`
          : `Connect a provider to enable ${ch.label}. Until then, ${ch.label} steps are ignored in broadcasts and automations.`}
      </p>

      {multi ? (
        <div class="mt-4">
          <p class="mb-2 text-xs font-semibold uppercase tracking-wide text-stone-500">Provider</p>
          <div class="flex flex-wrap gap-2">
            {ch.providers.map((p) => {
              const isSel = p.provider === selected;
              const isConnected = connectors.some((c) => c.provider === p.provider);
              return (
                <button
                  key={p.provider}
                  type="button"
                  data-testid={`connector-pick-${p.provider}`}
                  onClick={() => setSelected(p.provider)}
                  class={`flex items-center gap-2.5 rounded-xl border px-3 py-2 text-left transition ${
                    isSel ? 'border-brand-400 bg-brand-50 ring-1 ring-brand-300' : 'border-stone-200 bg-white hover:border-stone-300'
                  }`}
                >
                  <ProviderLogo provider={p.provider} />
                  <span class="min-w-0">
                    <span class="block text-sm font-semibold text-ink-900">{PROVIDER_META[p.provider]!.label}</span>
                    <span class={`block text-[11px] font-medium ${isConnected ? 'text-emerald-600' : 'text-stone-400'}`}>
                      {isConnected ? 'connected' : 'not connected'}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      ) : null}

      <div class="mt-4">
        <ConnectorCard spec={spec} existing={existing} onChanged={onChanged} />
      </div>
    </Card>
  );
}

function ConnectorCard({ spec, existing, onChanged }: { spec: ProviderSpec; existing: Connector | null; onChanged: () => Promise<void> }) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [secret, setSecret] = useState('');
  const [busy, setBusy] = useState(false);
  const configured = existing !== null;
  const meta = PROVIDER_META[spec.provider]!;

  useEffect(() => {
    const v: Record<string, string> = {};
    for (const f of spec.fields) v[f.key] = String((existing?.config as Record<string, unknown> | undefined)?.[f.key] ?? '');
    setValues(v);
    setSecret('');
  }, [existing, spec.provider]);

  const requiredFilled = spec.fields.every((f) => f.optional || String(values[f.key] ?? '').trim());
  const canSave = requiredFilled && (configured || secret.trim().length > 0);

  const save = async (): Promise<void> => {
    setBusy(true);
    try {
      const config: Record<string, string> = {};
      for (const f of spec.fields) if (String(values[f.key] ?? '').trim()) config[f.key] = String(values[f.key]).trim();
      await api.put('/company/connectors', { body: { provider: spec.provider, config, secret } });
      setSecret('');
      showToast(`${meta.label} connected.`, { tone: 'success' });
      await onChanged();
    } catch (e) {
      showToast((e as { error?: string })?.error ?? `Could not save ${meta.label}.`, { tone: 'error' });
    } finally {
      setBusy(false);
    }
  };

  const remove = async (): Promise<void> => {
    if (!existing) return;
    setBusy(true);
    try {
      await api.del(`/company/connectors/${existing.id}`);
      showToast(`${meta.label} disconnected.`, { tone: 'success' });
      await onChanged();
    } catch (e) {
      showToast((e as { error?: string })?.error ?? 'Could not disconnect.', { tone: 'error' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div data-testid={`connector-${spec.provider}`} class="rounded-xl border border-stone-200 p-4">
      <div class="flex items-center gap-3">
        <ProviderLogo provider={spec.provider} />
        <div class="min-w-0 flex-1">
          <h3 class="text-sm font-bold text-ink-900">{meta.label}</h3>
          <p class="text-[11px] font-medium text-stone-400">Connection details</p>
        </div>
        <span
          data-testid={`connector-${spec.provider}-status`}
          class={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${configured ? 'bg-emerald-100 text-emerald-700' : 'bg-amber-100 text-amber-700'}`}
        >
          {configured ? 'connected' : 'not connected'}
        </span>
      </div>
      {spec.hint ? <p class="mt-2 text-xs text-stone-500">{spec.hint}</p> : null}
      <div class="mt-3 grid max-w-xl gap-3">
        {spec.fields.map((f) => (
          <Field key={f.key} label={f.optional ? `${f.label} (optional)` : f.label}>
            <Input
              data-testid={`connector-${spec.provider}-${f.key}`}
              class="font-mono text-sm"
              placeholder={f.placeholder}
              value={values[f.key] ?? ''}
              onInput={(e: Event) => setValues((v) => ({ ...v, [f.key]: (e.target as HTMLInputElement).value }))}
            />
          </Field>
        ))}
        <Field label={spec.secretLabel}>
          <Input
            data-testid={`connector-${spec.provider}-secret`}
            type="password"
            class="font-mono text-sm"
            placeholder={configured ? '•••••••• (leave blank to keep current)' : `enter the ${spec.secretLabel.toLowerCase()}`}
            value={secret}
            onInput={(e: Event) => setSecret((e.target as HTMLInputElement).value)}
          />
        </Field>
        <div class="flex items-center gap-3">
          <Button data-testid={`connector-${spec.provider}-save`} size="sm" onClick={() => save()} disabled={busy || !canSave}>
            {busy ? 'Saving…' : configured ? 'Update' : 'Connect'}
          </Button>
          {configured ? (
            <Button data-testid={`connector-${spec.provider}-remove`} variant="danger" size="sm" onClick={() => remove()} disabled={busy}>
              Disconnect
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
