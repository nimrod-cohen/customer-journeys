// SendEventDrawer (§7/§12): record a SINGLE behavioral event "on a profile's
// behalf" — a type + an optional JSON payload. It lands in the same `events`
// stream as ingested events (feeds segment rules, the timeline, and the rolling
// features), so it's how an operator can simulate/backfill an event manually.
import { useEffect, useState } from 'preact/hooks';
import { api } from '../store/session.js';
import { Button, Drawer, Field, Input, Textarea } from '../ui/kit.js';

export function SendEventDrawer({
  open,
  profileId,
  onClose,
  onSent,
}: {
  open: boolean;
  profileId: string;
  onClose: () => void;
  onSent: () => void;
}) {
  const [type, setType] = useState('');
  const [payloadText, setPayloadText] = useState('{\n  \n}');
  const [knownTypes, setKnownTypes] = useState<string[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setType('');
    setPayloadText('{\n  \n}');
    setError('');
    // Suggest existing event types (autocomplete) so manual events stay consistent
    // with the ingested vocabulary.
    void api
      .get<{ types: string[] }>('/events/types')
      .then((r) => setKnownTypes(r.types ?? []))
      .catch(() => setKnownTypes([]));
  }, [open]);

  // Parse the payload as JSON for validation/preview. Empty / whitespace = {}.
  const parsePayload = (): { ok: true; value: Record<string, unknown> } | { ok: false; message: string } => {
    const raw = payloadText.trim();
    if (raw === '') return { ok: true, value: {} };
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { ok: false, message: 'Content must be valid JSON.' };
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return { ok: false, message: 'Content must be a JSON object (e.g. {"amount": 50}).' };
    }
    return { ok: true, value: parsed as Record<string, unknown> };
  };

  const parsed = parsePayload();
  const canSend = type.trim() !== '' && parsed.ok && !busy;

  const send = async () => {
    setError('');
    if (type.trim() === '') {
      setError('An event type is required.');
      return;
    }
    if (!parsed.ok) {
      setError(parsed.message);
      return;
    }
    setBusy(true);
    try {
      await api.post(`/profiles/${profileId}/events`, { body: { type: type.trim(), payload: parsed.value } });
      onSent();
    } catch (e) {
      setError((e as { error?: string })?.error ?? 'Could not record the event.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title="Send event"
      subtitle="Record a single event on this profile's behalf. It feeds segments, the timeline, and rolling features — just like an ingested event."
      testId="send-event-drawer"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button data-testid="send-event-confirm" onClick={send} disabled={!canSend}>
            Send event
          </Button>
        </>
      }
    >
      <div class="space-y-4">
        <Field label="Event type" hint="A short name, e.g. purchase, page_view, demo_requested.">
          <Input
            data-testid="send-event-type"
            list="send-event-type-options"
            placeholder="event_name"
            value={type}
            onInput={(e: Event) => setType((e.target as HTMLInputElement).value)}
          />
          <datalist id="send-event-type-options">
            {knownTypes.map((t) => (
              <option key={t} value={t} />
            ))}
          </datalist>
        </Field>

        <Field label="Content (JSON)" hint="Optional JSON object — e.g. {&quot;amount&quot;: 50, &quot;sku&quot;: &quot;book&quot;}.">
          <Textarea
            data-testid="send-event-payload"
            rows={8}
            class="font-mono text-sm"
            value={payloadText}
            onInput={(e: Event) => setPayloadText((e.target as HTMLTextAreaElement).value)}
          />
          {!parsed.ok && payloadText.trim() !== '' ? (
            <p data-testid="send-event-json-error" class="mt-1 text-xs font-medium text-amber-700">
              {parsed.message}
            </p>
          ) : null}
        </Field>

        {error ? (
          <p data-testid="send-event-error" class="text-sm text-rose-600">
            {error}
          </p>
        ) : null}
      </div>
    </Drawer>
  );
}
