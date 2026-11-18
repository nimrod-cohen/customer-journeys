// "Send test" for an automation send step: render the step's message with a REAL
// customer's data and deliver it to the person testing — never to the customer.
//
// No search: the panel lists the last 10 customers the automation's trigger WOULD
// have enrolled (GET /automations/:id/test-send/candidates) — the latest to fire the
// trigger event (each with that event, so {{event.*}} renders from it), to enter or
// exit the trigger segment, or to be created/updated. The server
// (POST /automations/:id/send-nodes/:nodeId/test-send) writes nothing about them.
import { useEffect, useState } from 'preact/hooks';
import { api, sessionStore } from '../../store/session.js';
import { useStore } from '../../store/store.js';
import { Button, Field, Input } from '../../ui/kit.js';
import { showToast } from '../../ui/toast.js';
import type { SendMedium } from '../node-config.js';

interface Candidate {
  profile_id: string;
  email: string | null;
  phone: string | null;
  at: string;
  event_id?: string;
  event_type?: string;
}

interface CandidatesResponse {
  trigger: string;
  profileChange?: string;
  triggerOn?: 'enter' | 'exit';
  candidates: Candidate[];
}

interface TestSendResult {
  sent: boolean;
  to: string;
  reason?: string;
  simulated?: boolean;
}

/** What made this customer a candidate, in a few words. */
function triggerVerb(res: CandidatesResponse, c: Candidate): string {
  switch (res.trigger) {
    case 'event':
      return `fired ${c.event_type ?? 'the event'}`;
    case 'segment_entry':
      return res.triggerOn === 'exit' ? 'left the segment' : 'entered the segment';
    case 'profile':
      return res.profileChange === 'created' ? 'created' : 'updated';
    default:
      return 'last updated';
  }
}

/** The empty-list explanation, per trigger. */
function emptyText(trigger: string): string {
  switch (trigger) {
    case 'event':
      return 'Nobody has fired this trigger event yet (with its filter applied). Set the trigger event first, or wait for one to arrive.';
    case 'segment_entry':
      return 'Nobody has entered or left the trigger segment yet. Choose the segment on the trigger first.';
    default:
      return 'No customers yet.';
  }
}

export function TestSendPanel(props: { automationId: string | null; nodeId: string; medium: SendMedium }) {
  const session = useStore(sessionStore);
  const [open, setOpen] = useState(false);
  const [list, setList] = useState<CandidatesResponse | null>(null);
  const [picked, setPicked] = useState<Candidate | null>(null);
  const isText = props.medium !== 'email';
  const [to, setTo] = useState('');

  // The recipient defaults to the signed-in user's own email; a text step needs a phone.
  useEffect(() => {
    setTo(isText ? '' : session.email ?? '');
  }, [isText, session.email]);

  // Re-read every time the panel opens: the trigger may have just been edited.
  useEffect(() => {
    if (!open || !props.automationId) return;
    setList(null);
    setPicked(null);
    void api
      .get<CandidatesResponse>(`/automations/${props.automationId}/test-send/candidates`)
      .then((r) => {
        setList(r);
        setPicked(r.candidates[0] ?? null);
      })
      .catch((e: unknown) => {
        setList({ trigger: '', candidates: [] });
        showToast((e as { error?: string })?.error ?? 'Could not load recent customers.', { tone: 'error' });
      });
  }, [open, props.automationId]);

  if (!props.automationId) return null;

  const send = async (): Promise<void> => {
    if (!picked) {
      showToast('Choose a customer to test with.', { tone: 'error' });
      return;
    }
    try {
      const res = await api.post<TestSendResult>(
        `/automations/${props.automationId}/send-nodes/${props.nodeId}/test-send`,
        {
          body: {
            profile_id: picked.profile_id,
            ...(picked.event_id ? { event_id: picked.event_id } : {}),
            ...(to.trim() ? { to: to.trim() } : {}),
          },
        },
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
            Pick one of the last customers this automation would have enrolled. The message uses their data but goes only
            to you, marked [TEST] — they get nothing and aren&apos;t enrolled. Sends this step as last saved.
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
        {list === null ? (
          <p class="text-sm text-stone-400">Loading recent customers…</p>
        ) : list.candidates.length === 0 ? (
          <p data-testid="send-test-empty" class="text-sm text-stone-500">
            {emptyText(list.trigger)}
          </p>
        ) : (
          <div role="radiogroup" data-testid="send-test-candidates" class="divide-y divide-stone-100 rounded-lg border border-stone-200 bg-surface">
            {list.candidates.map((c) => {
              const selected = picked?.profile_id === c.profile_id;
              return (
                <button
                  key={c.profile_id}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  data-testid="send-test-candidate"
                  onClick={() => setPicked(c)}
                  class={`flex w-full items-center gap-3 px-3 py-2 text-left ${selected ? 'bg-brand-50' : 'hover:bg-stone-50'}`}
                >
                  <span
                    class={`h-3.5 w-3.5 shrink-0 rounded-full border ${selected ? 'border-4 border-brand-600' : 'border-stone-300'}`}
                  />
                  <span class="min-w-0 flex-1">
                    <span class="block truncate text-sm text-ink-900">{c.email ?? c.phone ?? c.profile_id}</span>
                    <span class="block truncate text-xs text-stone-500">
                      {triggerVerb(list, c)} · {new Date(c.at).toLocaleString()}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </Field>
      <Field label={isText ? 'Send to phone' : 'Send to'}>
        <Input
          data-testid="send-test-to"
          type={isText ? 'tel' : 'email'}
          placeholder={isText ? '+972…' : 'you@example.com'}
          value={to}
          onInput={(e: Event) => setTo((e.target as HTMLInputElement).value)}
        />
      </Field>
      <Button data-testid="send-test-submit" disabled={!picked || !to.trim()} onClick={send}>
        Send test
      </Button>
    </div>
  );
}
