// WhatsApp — a TAB in Workspace settings. Each workspace connects its OWN WhatsApp
// Business number (Meta Cloud API) to our platform app. Saving verifies the number
// and subscribes the app to the account's webhooks, so a save that succeeds is a
// connection that works. The access token is write-only (never returned).
import { useEffect, useState } from 'preact/hooks';
import { api } from '../store/session.js';
import { Badge, Button, Card, Field, Input } from '../ui/kit.js';
import { askConfirm } from '../ui/dialog.tsx';
import { showToast } from '../ui/toast.tsx';
import { refreshReadiness } from '../store/readiness.js';
import { NO_AUTOFILL, SECRET_NO_AUTOFILL } from '../ui/autofill.js';

interface WhatsappConfig {
  configured: boolean;
  phone_number_id?: string;
  waba_id?: string | null;
  api_version?: string | null;
  default_country?: string | null;
  display_phone_number?: string | null;
  verified_name?: string | null;
}

export function WhatsAppSettingsPanel() {
  const [cfg, setCfg] = useState<WhatsappConfig | null>(null);
  const [phoneNumberId, setPhoneNumberId] = useState('');
  const [wabaId, setWabaId] = useState('');
  const [token, setToken] = useState('');
  const [apiVersion, setApiVersion] = useState('');
  const [country, setCountry] = useState('');
  // Meta's reason stays on screen: it names what to fix (token, id, permission).
  const [error, setError] = useState('');

  const load = async (): Promise<void> => {
    const r = await api.get<WhatsappConfig>('/workspace/whatsapp');
    setCfg(r);
    setPhoneNumberId(r.phone_number_id ?? '');
    setWabaId(r.waba_id ?? '');
    setApiVersion(r.api_version ?? '');
    setCountry(r.default_country ?? '');
    setToken('');
  };
  useEffect(() => {
    void load();
  }, []);

  const save = async (): Promise<void> => {
    setError('');
    try {
      await api.put('/workspace/whatsapp', {
        body: {
          phone_number_id: phoneNumberId,
          waba_id: wabaId,
          access_token: token,
          api_version: apiVersion,
          default_country: country,
        },
      });
      showToast('WhatsApp connected.', { tone: 'success' });
      await load();
      refreshReadiness();
    } catch (e) {
      setError((e as { error?: string })?.error ?? 'Could not connect WhatsApp.');
    }
  };

  const disconnect = async (): Promise<void> => {
    const ok = await askConfirm({
      title: 'Disconnect WhatsApp?',
      message: 'This workspace will stop sending WhatsApp messages until a number is connected again.',
      confirmLabel: 'Disconnect',
      danger: true,
    });
    if (!ok) return;
    try {
      await api.del('/workspace/whatsapp');
      showToast('WhatsApp disconnected.', { tone: 'success' });
      await load();
      refreshReadiness();
    } catch (e) {
      showToast((e as { error?: string })?.error ?? 'Could not disconnect WhatsApp.', { tone: 'error' });
    }
  };

  if (!cfg) return <p class="text-sm text-stone-500">Loading…</p>;
  const configured = cfg.configured;
  const canSave = phoneNumberId.trim() !== '' && wabaId.trim() !== '' && (configured || token.trim() !== '');

  return (
    <Card data-testid="whatsapp-settings" class="p-5">
      <div class="flex items-center justify-between gap-3">
        <h2 class="text-base font-bold text-ink-900">WhatsApp</h2>
        <Badge data-testid="whatsapp-status" tone={configured ? 'success' : 'warn'}>
          {configured ? 'connected' : 'not connected'}
        </Badge>
      </div>
      {configured && (cfg.display_phone_number || cfg.verified_name) ? (
        <p data-testid="whatsapp-number" class="mt-1 text-sm text-ink-800">
          Sending as <strong>{cfg.verified_name ?? ''}</strong> {cfg.display_phone_number ? `(${cfg.display_phone_number})` : ''}
        </p>
      ) : null}
      <p class="mt-1 text-sm text-stone-500">
        This workspace's own WhatsApp Business number. A number can be connected to one workspace only.
      </p>
      <p class="mt-2 text-sm text-stone-500">
        To connect: in Meta Business Manager → <strong>Partners</strong>, share your WhatsApp Business Account with our
        business. We then create the access token for it on our side. A token made in your own Meta app will not
        work: replies and delivery receipts would go to your app instead of here.
      </p>

      <div class="mt-4 grid max-w-xl gap-3">
        <Field label="Phone number ID">
          <Input
            data-testid="wa-phone-number-id"
            {...NO_AUTOFILL}
            class="font-mono text-sm"
            value={phoneNumberId}
            onInput={(e: Event) => setPhoneNumberId((e.target as HTMLInputElement).value)}
          />
        </Field>
        <Field label="WhatsApp Business Account ID">
          <Input
            data-testid="wa-waba-id"
            {...NO_AUTOFILL}
            class="font-mono text-sm"
            value={wabaId}
            onInput={(e: Event) => setWabaId((e.target as HTMLInputElement).value)}
          />
        </Field>
        <Field label="Access token">
          <Input
            data-testid="wa-access-token"
            {...SECRET_NO_AUTOFILL}
            class="font-mono text-sm"
            placeholder={configured ? 'Saved — leave blank to keep it' : ''}
            value={token}
            onInput={(e: Event) => setToken((e.target as HTMLInputElement).value)}
          />
        </Field>
        <div class="grid grid-cols-2 gap-3">
          <Field label="API version (optional)">
            <Input
              data-testid="wa-api-version"
              {...NO_AUTOFILL}
              class="font-mono text-sm"
              placeholder="v21.0"
              value={apiVersion}
              onInput={(e: Event) => setApiVersion((e.target as HTMLInputElement).value)}
            />
          </Field>
          <Field label="Default country (optional)">
            <Input
              data-testid="wa-default-country"
              {...NO_AUTOFILL}
              class="font-mono text-sm"
              placeholder="IL"
              value={country}
              onInput={(e: Event) => setCountry((e.target as HTMLInputElement).value)}
            />
          </Field>
        </div>
      </div>

      {error ? (
        <p data-testid="whatsapp-error" class="mt-3 text-sm text-red-600">
          {error}
        </p>
      ) : null}

      <div class="mt-4 flex gap-2">
        <Button data-testid="wa-save" disabled={!canSave} onClick={save}>
          {configured ? 'Save' : 'Connect'}
        </Button>
        {configured ? (
          <Button data-testid="wa-disconnect" variant="secondary" onClick={disconnect}>
            Disconnect
          </Button>
        ) : null}
      </div>
    </Card>
  );
}
