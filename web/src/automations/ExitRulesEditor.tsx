// Exit rules editor — "while someone is in this journey, if X happens, take them
// out / start them over". Lives in a drawer opened from the builder toolbar; the
// rules save into the DRAFT definition like every other builder edit.
import { useState } from 'preact/hooks';
import { api } from '../store/session.js';
import { Button, Field, Input, Select } from '../ui/kit.js';
import { Suggest } from '../ui/Suggest.js';
import { showToast } from '../ui/toast.js';
import { RuleBuilder } from '../segments/RuleBuilder.js';
import { EventPayloadFilter } from './editors/NodeEditor.js';
import {
  blankExitRule,
  readExitRules,
  summarizeExitForm,
  writeExitRules,
  type ExitAction,
  type ExitRuleDsl,
  type ExitRuleForm,
  type ExitWhenKind,
} from './exit-rules.js';

export function ExitRulesEditor(props: {
  readonly rules: readonly ExitRuleDsl[];
  readonly segments: readonly { id: string; name: string }[];
  readonly triggerNode: { kind?: string; eventType?: string } | null;
  /** Persist the rules into the draft; rejects on a server validation error. */
  readonly onSave: (rules: ExitRuleDsl[]) => Promise<void>;
  readonly onDone: () => void;
}) {
  const [forms, setForms] = useState<ExitRuleForm[]>(() => readExitRules(props.rules));
  // ONE rule is open for editing at a time; the rest fold into a one-line summary.
  // A single existing rule opens straight away; several start folded.
  const [openId, setOpenId] = useState<string | null>(() => (forms.length === 1 ? forms[0]!.id : null));
  const patch = (i: number, p: Partial<ExitRuleForm>) => setForms((fs) => fs.map((f, idx) => (idx === i ? { ...f, ...p } : f)));
  const remove = (i: number) => setForms((fs) => fs.filter((_, idx) => idx !== i));
  const segmentName = (id: string): string | undefined => props.segments.find((s) => s.id === id)?.name;
  const add = (): void => {
    const r = blankExitRule();
    setForms((fs) => [...fs, r]);
    setOpenId(r.id);
  };

  const save = async (): Promise<void> => {
    const out = writeExitRules(forms);
    if ('error' in out) {
      showToast(out.error, { tone: 'error' });
      return;
    }
    await props.onSave(out.rules);
    props.onDone();
  };

  return (
    <div class="space-y-4" data-testid="exit-rules-editor">
      <p class="text-sm text-stone-600">
        While someone is in this journey, these rules can take them out of it or send them back to the start. Rules apply after
        you publish. Pending messages from the journey are cancelled when a rule fires.
      </p>

      {forms.length === 0 ? (
        <p data-testid="exit-rules-empty" class="rounded-lg border border-dashed border-stone-300 p-4 text-sm text-stone-500">
          No exit rules yet — people stay in the journey until they reach its end.
        </p>
      ) : null}

      {forms.map((f, i) =>
        f.id !== openId ? (
          <button
            key={f.id}
            type="button"
            data-testid="exit-rule-folded"
            class="flex w-full items-center gap-3 rounded-xl border border-stone-200 bg-stone-50 px-4 py-3 text-start text-sm text-ink-800 hover:border-brand-400 hover:bg-surface"
            onClick={() => setOpenId(f.id)}
            title="Edit this rule"
          >
            <span class="shrink-0 font-semibold text-stone-500">{i + 1}.</span>
            <span class="min-w-0 flex-1 truncate">{summarizeExitForm(f, segmentName)}</span>
            <span class="shrink-0 text-xs font-medium text-brand-700">Edit</span>
          </button>
        ) : (
        <div key={f.id} data-testid="exit-rule" class="space-y-3 rounded-xl border border-stone-200 bg-surface p-4">
          <div class="flex items-center justify-between">
            <span class="text-sm font-semibold text-stone-700">Rule {i + 1}</span>
            <span class="flex items-center gap-1">
              <Button data-testid="exit-rule-collapse" variant="ghost" onClick={() => setOpenId(null)}>
                Done
              </Button>
              <Button data-testid="exit-rule-remove" variant="ghost" onClick={() => remove(i)}>
                Remove
              </Button>
            </span>
          </div>
          <Field label="When">
            <Select
              data-testid="exit-rule-kind"
              value={f.kind}
              onChange={(e: Event) => patch(i, { kind: (e.target as HTMLSelectElement).value as ExitWhenKind })}
            >
              <option value="event">The person does an event</option>
              <option value="segment_exit">The person leaves a segment</option>
              <option value="segment_entry">The person enters a segment</option>
              <option value="profile_match">The person matches a condition</option>
            </Select>
          </Field>

          {f.kind === 'event' ? (
            <>
              <Field label="Event type" hint="e.g. purchase.">
                <Suggest
                  testId="exit-rule-event-type"
                  placeholder="purchase"
                  value={f.eventType}
                  onChange={(v) => patch(i, { eventType: v })}
                  fetcher={(q) => api.get<{ values: string[] }>('/events/types', { query: { q } }).then((r) => r.values)}
                />
              </Field>
              <Field label="Only when the event matches (optional)">
                <EventPayloadFilter form={f.filter} eventType={f.eventType} onChange={(filter) => patch(i, { filter })} />
              </Field>
            </>
          ) : null}

          {f.kind === 'segment_exit' || f.kind === 'segment_entry' ? (
            <Field label="Segment">
              <Select
                data-testid="exit-rule-segment"
                value={f.segmentId}
                onChange={(e: Event) => patch(i, { segmentId: (e.target as HTMLSelectElement).value })}
              >
                <option value="">Choose a segment…</option>
                {props.segments.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </Select>
            </Field>
          ) : null}

          {f.kind === 'profile_match' ? (
            <Field
              label="Condition"
              hint={
                f.action === 'restart'
                  ? 'Restarts when the condition BECOMES true (checked on updates, events and every journey step).'
                  : 'Exits as soon as the condition is true (checked on updates, events and every journey step).'
              }
            >
              <RuleBuilder
                group={f.condition}
                onChange={(condition) => patch(i, { condition })}
                allowEmptyRootRules
                context="automation"
                triggerIsEvent={props.triggerNode?.kind === 'event'}
                triggerEventType={props.triggerNode?.eventType ?? ''}
                segments={props.segments.map((s) => ({ id: s.id, name: s.name }))}
              />
            </Field>
          ) : null}

          <Field label="Then">
            <Select
              data-testid="exit-rule-action"
              value={f.action}
              onChange={(e: Event) => patch(i, { action: (e.target as HTMLSelectElement).value as ExitAction })}
            >
              <option value="exit">Take them out of the journey</option>
              <option value="restart">Send them back to the start</option>
            </Select>
          </Field>
          <Field label="Name (optional)" hint="Shown in the journey log, e.g. “Bought”.">
            <Input
              data-testid="exit-rule-label"
              value={f.label}
              onInput={(e: Event) => patch(i, { label: (e.target as HTMLInputElement).value })}
            />
          </Field>
        </div>
        ),
      )}

      <div class="flex items-center justify-between">
        <Button data-testid="exit-rule-add" variant="ghost" onClick={add}>
          + Add rule
        </Button>
        <Button data-testid="exit-rules-save" onClick={save}>
          Save rules
        </Button>
      </div>
    </div>
  );
}
