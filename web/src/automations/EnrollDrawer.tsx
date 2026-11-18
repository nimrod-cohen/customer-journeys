// Manual enrollment into an automation whose trigger is "manual" — from either end:
//   - the automation page: pick ONE customer or a SEGMENT (everyone in it right now);
//   - a customer's profile: pick the automation to put them in.
// Both call POST /automations/:id/enroll, which only accepts a live (active)
// automation and never enrolls the same person twice ('once' policy) — the toast says
// how many were new and how many were already in it.
import { useEffect, useState } from 'preact/hooks';
import { api } from '../store/session.js';
import { Button, Drawer, Field, Select } from '../ui/kit.js';
import { ProfilePicker, type PickedProfile } from '../ui/ProfilePicker.js';
import { showToast } from '../ui/toast.js';
import { askConfirm } from '../ui/dialog.js';

interface EnrollResult {
  enrolled: number;
  already: number;
}

/** Enroll, then toast what actually happened. Resolves true when the call succeeded. */
async function enroll(automationId: string, body: { profile_id: string } | { segment_id: string }, what: string): Promise<boolean> {
  try {
    const r = await api.post<EnrollResult>(`/automations/${automationId}/enroll`, { body });
    if (r.enrolled === 0 && r.already === 0) {
      showToast(`Nobody to enroll — ${what} is empty.`, { tone: 'info' });
    } else if (r.enrolled === 0) {
      showToast(r.already === 1 ? 'Already enrolled — nothing changed.' : `All ${r.already} were already enrolled — nothing changed.`, {
        tone: 'info',
      });
    } else {
      const people = r.enrolled === 1 ? '1 person' : `${r.enrolled} people`;
      showToast(`Enrolled ${people}${r.already ? ` (${r.already} already in it)` : ''}.`, { tone: 'success' });
    }
    return true;
  } catch (e) {
    showToast((e as { error?: string })?.error ?? 'Could not enroll.', { tone: 'error' });
    return false;
  }
}

/** Automation page: enroll a customer or a segment snapshot into THIS automation. */
export function EnrollIntoAutomationDrawer(props: {
  open: boolean;
  automationId: string;
  segments: readonly { id: string; name: string }[];
  onClose: () => void;
  onEnrolled: () => void;
}) {
  const [mode, setMode] = useState<'profile' | 'segment'>('profile');
  const [profile, setProfile] = useState<PickedProfile | null>(null);
  const [segmentId, setSegmentId] = useState('');

  useEffect(() => {
    if (!props.open) return;
    setMode('profile');
    setProfile(null);
    setSegmentId('');
  }, [props.open]);

  const submit = async (): Promise<void> => {
    if (mode === 'profile') {
      if (!profile) return;
      if (await enroll(props.automationId, { profile_id: profile.id }, 'the customer')) props.onEnrolled();
      return;
    }
    const seg = props.segments.find((s) => s.id === segmentId);
    if (!seg) return;
    // A segment can be large and this starts a real journey for each of them.
    const yes = await askConfirm({
      title: 'Enroll the whole segment?',
      message: `Everyone in "${seg.name}" right now will start this automation. People who join the segment later are not added.`,
      confirmLabel: 'Enroll them',
    });
    if (!yes) return;
    if (await enroll(props.automationId, { segment_id: seg.id }, 'the segment')) props.onEnrolled();
  };

  const ready = mode === 'profile' ? profile !== null : segmentId !== '';
  return (
    <Drawer
      open={props.open}
      onClose={props.onClose}
      title="Enroll in this automation"
      subtitle="Start the journey for a customer, or for everyone in a segment right now."
      testId="enroll-drawer"
      footer={
        <Button data-testid="enroll-submit" disabled={!ready} onClick={submit}>
          Enroll
        </Button>
      }
    >
      <div class="space-y-4">
        <div role="radiogroup" class="inline-flex rounded-lg bg-stone-100 p-1">
          {(['profile', 'segment'] as const).map((m) => (
            <button
              key={m}
              type="button"
              role="radio"
              aria-checked={mode === m}
              data-testid={`enroll-mode-${m}`}
              onClick={() => setMode(m)}
              class={`rounded-md px-3 py-1.5 text-sm font-medium ${mode === m ? 'bg-surface text-ink-900 shadow-sm' : 'text-stone-500'}`}
            >
              {m === 'profile' ? 'A customer' : 'A segment'}
            </button>
          ))}
        </div>
        {mode === 'profile' ? (
          <Field label="Customer">
            <ProfilePicker testId="enroll-profile" value={profile} onChange={setProfile} />
          </Field>
        ) : (
          <Field label="Segment" hint="Enrolls everyone in it at this moment. Anyone already in the automation is skipped.">
            <Select
              data-testid="enroll-segment"
              value={segmentId}
              onChange={(e: Event) => setSegmentId((e.target as HTMLSelectElement).value)}
            >
              <option value="">Choose a segment…</option>
              {props.segments.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </Select>
          </Field>
        )}
      </div>
    </Drawer>
  );
}

interface AutomationRow {
  id: string;
  name: string;
  status: string;
  trigger_kind: string;
}

/** Customer profile: put this customer into a live, manually-enrolled automation. */
export function EnrollProfileDrawer(props: { open: boolean; profileId: string; onClose: () => void; onEnrolled: () => void }) {
  const [automations, setAutomations] = useState<AutomationRow[] | null>(null);
  const [automationId, setAutomationId] = useState('');

  useEffect(() => {
    if (!props.open) return;
    setAutomationId('');
    setAutomations(null);
    void api
      .get<{ automations: AutomationRow[] }>('/automations')
      .then((r) => setAutomations(r.automations.filter((a) => a.status === 'active' && a.trigger_kind === 'manual')))
      .catch(() => setAutomations([]));
  }, [props.open]);

  const submit = async (): Promise<void> => {
    if (!automationId) return;
    if (await enroll(automationId, { profile_id: props.profileId }, 'the customer')) props.onEnrolled();
  };

  return (
    <Drawer
      open={props.open}
      onClose={props.onClose}
      title="Enroll in an automation"
      subtitle="Start a manually-enrolled automation for this customer."
      testId="enroll-profile-drawer"
      footer={
        <Button data-testid="enroll-profile-submit" disabled={!automationId} onClick={submit}>
          Enroll
        </Button>
      }
    >
      {automations === null ? (
        <p class="text-sm text-stone-400">Loading automations…</p>
      ) : automations.length === 0 ? (
        <p data-testid="enroll-profile-empty" class="text-sm text-stone-500">
          No live automation is set to manual enrollment. Give an automation the “Manual” trigger and publish it first.
        </p>
      ) : (
        <Field label="Automation" hint="Only published automations with a manual trigger are listed.">
          <Select
            data-testid="enroll-profile-automation"
            value={automationId}
            onChange={(e: Event) => setAutomationId((e.target as HTMLSelectElement).value)}
          >
            <option value="">Choose an automation…</option>
            {automations.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </Select>
        </Field>
      )}
    </Drawer>
  );
}
