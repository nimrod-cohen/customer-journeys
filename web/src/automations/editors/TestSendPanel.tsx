// "Send test" for an automation send step: render the step's message with a REAL
// customer's data (and, for an event trigger, one of their real trigger events) and
// deliver it to the person testing — never to the customer. The server
// (POST /automations/:id/send-nodes/:nodeId/test-send) writes nothing about the
// customer; this panel only collects who to impersonate and where to send it.
import { useEffect, useState } from 'preact/hooks';
import { api, sessionStore } from '../../store/session.js';
import { useStore } from '../../store/store.js';
import { Button, Field, Input, Select } from '../../ui/kit.js';
import { ProfilePicker, type PickedProfile } from '../../ui/ProfilePicker.js';
import { showToast } from '../../ui/toast.js';
import type { SendMedium } from '../node-config.js';

interface ProfileEvent {
  event_id: string;
  type: string;
  occurred_at: string;
}

interface TestSendResult {
  sent: boolean;
  to: string;
  reason?: string;
  simulated?: boolean;
}

export function TestSendPanel(props: {
  automationId: string | null;
  nodeId: string;
  medium: SendMedium;
  /** The automation's trigger node — an event trigger offers the customer's real events. */
  triggerNode?: { kind?: string; eventType?: string; eventTypes?: readonly string[] } | null | undefined;
}) {
  const session = useStore(sessionStore);
  const [open, setOpen] = useState(false);
  const [profile, setProfile] = useState<PickedProfile | null>(null);
  const [events, setEvents] = useState<ProfileEvent[]>([]);
  const [eventId, setEventId] = useState('');
  const isText = props.medium !== 'email';
  const [to, setTo] = useState('');
  const isEventTrigger = props.triggerNode?.kind === 'event';
  const triggerTypes = new Set(
    [...(props.triggerNode?.eventTypes ?? []), props.triggerNode?.eventType ?? ''].filter((t) => t),
  );

  // The recipient defaults to the signed-in user's own email; a text step needs a phone.
  useEffect(() => {
    setTo(isText ? '' : session.email ?? '');
  }, [isText, session.email]);

  // The picked customer's real trigger events, newest first — the first one is preselected.
  useEffect(() => {
    setEvents([]);
    setEventId('');
    if (!profile || !isEventTrigger) return;
    void api
      .get<{ events: ProfileEvent[] }>(`/profiles/${profile.id}/events`)
      .then((r) => {
        const matching = r.events.filter((e) => triggerTypes.size === 0 || triggerTypes.has(e.type));
        setEvents(matching);
        setEventId(matching[0]?.event_id ?? '');
      })
      .catch(() => setEvents([]));
  }, [profile?.id, isEventTrigger]);

  if (!props.automationId) return null;

  const send = async (): Promise<void> => {
    if (!profile) {
      showToast('Choose a customer to test with.', { tone: 'error' });
      return;
    }
    try {
      const res = await api.post<TestSendResult>(
        `/automations/${props.automationId}/send-nodes/${props.nodeId}/test-send`,
        { body: { profile_id: profile.id, ...(eventId ? { event_id: eventId } : {}), ...(to.trim() ? { to: to.trim() } : {}) } },
      );
      if (!res.sent) {
        showToast(`Test not sent: ${res.reason ?? 'refused'}.`, { tone: 'error' });
      } else if (res.simulated) {
        showToast(`Test rendered for ${res.to}, but no email provider is connected, so nothing was delivered.`, { tone: 'info' });
      } else {
        showToast(`Test sent to ${res.to}.`, { tone: 'success' });
      }
    } catch (e) {
      showToast((e as { error?: string })?.error ?? 'Could not send the test.', { tone: 'error' });
    }
  };

  if (!open) {
    return (
      <Button data-testid="send-test-open" variant="secondary" onClick={() => setOpen(true)}>
        Send test…
      </Button>
    );
  }

  return (
    <div data-testid="send-test-panel" class="space-y-3 rounded-xl border border-stone-200 bg-stone-50/60 p-4">
      <div class="flex items-start justify-between gap-2">
        <div>
          <p class="text-sm font-semibold text-ink-900">Send a test</p>
          <p class="text-xs text-stone-500">
            Uses a real customer&apos;s data, but goes only to you, marked [TEST]. The customer gets nothing and isn&apos;t
            enrolled. Sends this step as last saved.
          </p>
        </div>
        <button
          type="button"
          data-testid="send-test-close"
          aria-label="Close"
          class="grid h-6 w-6 shrink-0 place-items-center rounded-full text-stone-400 hover:bg-stone-100 hover:text-ink-900"
          onClick={() => setOpen(false)}
        >
          ×
        </button>
      </div>
      <Field label="Customer">
        <ProfilePicker testId="send-test-profile" value={profile} onChange={setProfile} />
      </Field>
      {isEventTrigger && profile ? (
        <Field
          label="Trigger event"
          {...(events.length ? {} : { hint: 'This customer has no matching events — event fields will be empty.' })}
        >
          <Select
            data-testid="send-test-event"
            value={eventId}
            onChange={(e: Event) => setEventId((e.target as HTMLSelectElement).value)}
          >
            <option value="">No event</option>
            {events.map((ev) => (
              <option key={ev.event_id} value={ev.event_id}>
                {ev.type} · {new Date(ev.occurred_at).toLocaleString()}
              </option>
            ))}
          </Select>
        </Field>
      ) : null}
      <Field label={isText ? 'Send to phone' : 'Send to'}>
        <Input
          data-testid="send-test-to"
          type={isText ? 'tel' : 'email'}
          placeholder={isText ? '+972…' : 'you@example.com'}
          value={to}
          onInput={(e: Event) => setTo((e.target as HTMLInputElement).value)}
        />
      </Field>
      <Button data-testid="send-test-submit" disabled={!profile || !to.trim()} onClick={send}>
        Send test
      </Button>
    </div>
  );
}
