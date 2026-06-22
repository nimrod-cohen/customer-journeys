// Per-node CONFIG editors for the campaign builder (§9B phase 6). Each node type
// gets a focused editor rendered inside the kit Drawer; the dispatcher <NodeEditor>
// picks the right one for the selected card. Editors are CONTROLLED forms over the
// pure node-config serializers (web/src/campaigns/node-config.ts) — they read a
// node into a form, edit locally, and on Save serialize back to a DslNode patch
// (applied immutably via applyNodeConfig, preserving every edge). The owning
// CampaignBuilder persists the model (PUT /campaigns/:id) so the change round-trips.
//
// Reuse, not reinvent: the IF editor mounts the SAME shared RuleBuilder the segment
// screen uses (→ ONE §8 AstNode); the SEND editor reuses the broadcast clone/return
// flow (POST .../attach-template + editorReturn) for its email instance. Standing
// UI rules: every server-calling button RETURNS its promise (kit Button auto-locks);
// NO native dialogs (inline hints + showToast); every control has a data-testid.
import { useEffect, useState } from 'preact/hooks';
import { api } from '../../store/session.js';
import { navigate } from '../../router.js';
import { setEditorReturn } from '../../store/editorReturn.js';
import { Button, Field, Input, Select, Textarea } from '../../ui/kit.js';
import { Suggest } from '../../ui/Suggest.js';
import { showToast } from '../../ui/toast.js';
import { RuleBuilder } from '../../segments/RuleBuilder.js';
import { groupFromAst, BUILDER_OPERATORS, type AstNode, type RuleGroup, type BuilderOperator } from '../../segments/ast-builder.js';
import { displayType, type CanvasNode, type DslNode } from '../model.js';
import {
  readTriggerConfig,
  writeTriggerConfig,
  readWaitSeconds,
  writeWaitConfig,
  readWaitUntilInput,
  writeWaitUntilConfig,
  readHourWindow,
  writeHourWindowConfig,
  writeConditionConfig,
  conditionGroupIsEmpty,
  readEventPayloadFilter,
  writeEventPayloadFilter,
  emptyEventFilterRow,
  type EventFilterForm,
  type EventFilterRow,
  readSetAttributeValue,
  writeSetAttributeConfig,
  setAttributeFormHasKey,
  emptyAssignmentRow,
  readWebhookConfig,
  writeWebhookConfig,
  webhookSecretHeaders,
  sendNodeTemplateId,
  sendNodeMedium,
  readSendConfig,
  writeSendConfig,
  type SendMedium,
  type TriggerKind,
  type ProfileChange,
  type HourWindowForm,
  type ValueMode,
  type AssignmentRow,
  type SetAttributeForm,
  type WebhookForm,
  type WebhookHeaderRow,
} from '../node-config.js';

interface SegmentLite {
  id: string;
  name: string;
}

/** Shared props every node editor receives. */
export interface NodeEditorProps {
  readonly campaignId: string | null;
  readonly node: CanvasNode;
  /** Workspace timezone (from GET /campaigns/:id) — governs all time math. */
  readonly timeZone: string;
  /** Segments for the trigger picker (GET /segments). */
  readonly segments: readonly SegmentLite[];
  /** The campaign-row trigger_segment_id (segment_entry trigger). */
  readonly triggerSegmentId: string | null;
  /** Persist a node config patch into the model (applyNodeConfig + PUT). */
  readonly onSaveNode: (patch: DslNode) => Promise<void>;
  /** Persist the trigger_segment_id into the DRAFT (PUT /campaigns/:id/draft). */
  readonly onSaveTriggerSegment: (segmentId: string | null) => Promise<void>;
  /**
   * Re-fetch the campaign into the builder's model (GET /campaigns/:id). The SEND
   * editor calls this after a SERVER-SIDE mutation (attach-template repoints the
   * node's template_id in the DB) so the local model picks up the change — without
   * it, a later openEditor would re-persist the STALE model and wipe the attach.
   */
  readonly onReloadCampaign: () => Promise<void>;
  /** Close the drawer (after a successful save). */
  readonly onDone: () => void;
}

const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// ── TRIGGER ─────────────────────────────────────────────────────────────────────

function TriggerEditor(props: NodeEditorProps) {
  const initial = readTriggerConfig(props.node.node);
  const [kind, setKind] = useState<TriggerKind>(initial.kind);
  const [name, setName] = useState(initial.label ?? '');
  const [eventType, setEventType] = useState(initial.eventType ?? '');
  // The optional filter NARROWS the already-chosen event by its PAYLOAD only —
  // a list of `payload.<key> <op> <value>` rows (match all/any), NOT the full
  // segment rule builder (which would re-ask "did event X" / profile fields).
  const [filterForm, setFilterForm] = useState<EventFilterForm>(() => readEventPayloadFilter(initial.filter ?? null));
  const [segmentId, setSegmentId] = useState<string>(props.triggerSegmentId ?? '');
  const [profileChange, setProfileChange] = useState<ProfileChange>(initial.profileChange ?? 'any');

  const save = async (): Promise<void> => {
    if (kind === 'event' && !eventType.trim()) {
      showToast('Enter the event type that enrolls a profile.', { tone: 'error' });
      return;
    }
    const filterAst = kind === 'event' ? writeEventPayloadFilter(filterForm) : null;
    await props.onSaveNode(
      writeTriggerConfig({
        kind,
        ...(name.trim() ? { label: name } : {}),
        ...(eventType.trim() ? { eventType } : {}),
        ...(filterAst ? { filter: filterAst } : {}),
        ...(kind === 'profile' ? { profileChange } : {}),
      }),
    );
    // The segment_entry trigger's segment is a CAMPAIGN-ROW field — saved separately.
    if (kind === 'segment_entry') await props.onSaveTriggerSegment(segmentId || null);
    props.onDone();
  };

  return (
    <div class="space-y-4">
      <Field label="Name (optional)" hint="A short label shown on the trigger card, e.g. “New VIPs”.">
        <Input
          data-testid="trigger-name"
          value={name}
          placeholder="Trigger"
          onInput={(e: Event) => setName((e.target as HTMLInputElement).value)}
        />
      </Field>
      <Field label="Enrollment trigger" hint="How a profile enters this journey.">
        <Select data-testid="trigger-kind" value={kind} onChange={(e: Event) => setKind((e.target as HTMLSelectElement).value as TriggerKind)}>
          <option value="segment_entry">When a profile enters a segment</option>
          <option value="event">When a profile does an event</option>
          <option value="profile">When a profile is created or updated</option>
          <option value="manual">Manually enrolled</option>
        </Select>
      </Field>

      {kind === 'segment_entry' ? (
        <Field label="Segment" hint="The audience whose entry enrolls a profile.">
          <Select data-testid="trigger-segment" value={segmentId} onChange={(e: Event) => setSegmentId((e.target as HTMLSelectElement).value)}>
            <option value="">Choose a segment…</option>
            {props.segments.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </Select>
        </Field>
      ) : null}

      {kind === 'event' ? (
        <>
          <Field label="Event type" hint="e.g. purchase, signup, lead.">
            <Suggest
              testId="trigger-event-type"
              placeholder="purchase"
              value={eventType}
              onChange={setEventType}
              fetcher={(q) => api.get<{ values: string[] }>('/events/types', { query: { q } }).then((r) => r.values)}
            />
          </Field>
          <Field label="Only when the event matches (optional)" hint="Narrow it by the event's own attributes (payload).">
            <EventPayloadFilter form={filterForm} eventType={eventType} onChange={setFilterForm} />
          </Field>
        </>
      ) : null}

      {kind === 'profile' ? (
        <Field label="Enroll when the profile is" hint="A profile created and/or updated enrolls into this journey.">
          <Select
            data-testid="trigger-profile-change"
            value={profileChange}
            onChange={(e: Event) => setProfileChange((e.target as HTMLSelectElement).value as ProfileChange)}
          >
            <option value="created">Created</option>
            <option value="updated">Updated</option>
            <option value="any">Created or updated</option>
          </Select>
        </Field>
      ) : null}

      {kind === 'manual' ? <p data-testid="trigger-manual-note" class="text-sm text-stone-500">Profiles are enrolled manually (or by the API). No extra config.</p> : null}

      <div class="flex justify-end">
        <Button data-testid="node-save" onClick={save}>
          Save trigger
        </Button>
      </div>
    </div>
  );
}

/**
 * The event trigger's PAYLOAD-ONLY filter: match all/any + a list of
 * `payload.<attr> <op> <value>` rows. The attribute key autocompletes from the
 * workspace's known payload keys for the chosen event type (/events/payload-keys).
 * Distinct from the full RuleBuilder (the IF editor / segments use that) — here
 * the event type is fixed, so only its attributes can narrow enrollment.
 */
function EventPayloadFilter(props: {
  form: EventFilterForm;
  eventType: string;
  onChange: (form: EventFilterForm) => void;
}) {
  const { form, eventType, onChange } = props;
  const setRow = (i: number, patch: Partial<EventFilterRow>): void =>
    onChange({ ...form, rows: form.rows.map((r, idx) => (idx === i ? { ...r, ...patch } : r)) });
  const addRow = (): void => onChange({ ...form, rows: [...form.rows, emptyEventFilterRow()] });
  const removeRow = (i: number): void => {
    const rows = form.rows.filter((_, idx) => idx !== i);
    onChange({ ...form, rows: rows.length ? rows : [emptyEventFilterRow()] });
  };

  return (
    <div data-testid="trigger-event-filter" class="space-y-3">
      <div class="flex items-center gap-2 text-sm text-stone-600">
        <span>Match</span>
        <Select
          data-testid="event-filter-match"
          class="w-40 shrink-0"
          value={form.match}
          onChange={(e: Event) => onChange({ ...form, match: (e.target as HTMLSelectElement).value as 'and' | 'or' })}
        >
          <option value="and">all (AND)</option>
          <option value="or">any (OR)</option>
        </Select>
        <span>of these event attributes</span>
      </div>

      {form.rows.map((row, i) => (
        <div key={i} data-testid="event-filter-row" class="flex items-start gap-2">
          <Suggest
            testId="event-filter-field"
            wrapperClass="relative flex-1 min-w-0"
            placeholder="attribute (e.g. webinar_id)"
            value={row.field}
            onChange={(v) => setRow(i, { field: v })}
            fetcher={(q) =>
              api
                .get<{ values: string[] }>('/events/payload-keys', { query: { type: eventType.trim(), q } })
                .then((r) => r.values)
            }
          />
          <Select
            data-testid="event-filter-op"
            class="w-28 shrink-0"
            value={row.operator}
            onChange={(e: Event) => setRow(i, { operator: (e.target as HTMLSelectElement).value as BuilderOperator })}
          >
            {BUILDER_OPERATORS.map((op) => (
              <option key={op} value={op}>
                {op}
              </option>
            ))}
          </Select>
          {row.operator !== 'exists' ? (
            <Suggest
              testId="event-filter-value"
              wrapperClass="relative flex-1 min-w-0"
              placeholder="value"
              value={row.value}
              onChange={(v) => setRow(i, { value: v })}
              fetcher={
                row.field.trim()
                  ? (q) =>
                      api
                        .get<{ values: string[] }>('/events/payload-values', {
                          query: { type: eventType.trim(), key: row.field.trim(), q },
                        })
                        .then((r) => r.values)
                  : null
              }
            />
          ) : null}
          <Button
            data-testid="event-filter-remove"
            variant="ghost"
            aria-label="Remove this attribute filter"
            onClick={() => removeRow(i)}
          >
            ✕
          </Button>
        </div>
      ))}

      <Button data-testid="event-filter-add" variant="ghost" onClick={addRow}>
        + Add event attribute filter
      </Button>
    </div>
  );
}

// ── WAIT ──────────────────────────────────────────────────────────────────────

const WAIT_UNITS: { label: string; seconds: number }[] = [
  { label: 'minutes', seconds: 60 },
  { label: 'hours', seconds: 3600 },
  { label: 'days', seconds: 86400 },
];

function WaitEditor(props: NodeEditorProps) {
  const initialSecs = readWaitSeconds(props.node.node) || 86400;
  // Pick the largest whole unit for display.
  const initialUnit = initialSecs % 86400 === 0 ? 86400 : initialSecs % 3600 === 0 ? 3600 : 60;
  const [unit, setUnit] = useState(initialUnit);
  const [amount, setAmount] = useState(String(Math.max(1, Math.round(initialSecs / initialUnit))));

  const save = async (): Promise<void> => {
    const n = Math.max(1, Math.floor(Number(amount) || 1));
    await props.onSaveNode(writeWaitConfig(n * unit));
    props.onDone();
  };

  return (
    <div class="space-y-4">
      <Field label="Wait for" hint="Pause the journey for a relative duration.">
        <div class="flex items-center gap-2">
          <Input data-testid="wait-amount" type="number" min={1} class="w-24" value={amount} onInput={(e: Event) => setAmount((e.target as HTMLInputElement).value)} />
          <Select data-testid="wait-unit" class="w-32" value={String(unit)} onChange={(e: Event) => setUnit(Number((e.target as HTMLSelectElement).value))}>
            {WAIT_UNITS.map((u) => (
              <option key={u.seconds} value={String(u.seconds)}>
                {u.label}
              </option>
            ))}
          </Select>
        </div>
      </Field>
      <div class="flex justify-end">
        <Button data-testid="node-save" onClick={save}>
          Save wait
        </Button>
      </div>
    </div>
  );
}

// ── WAIT-UNTIL ──────────────────────────────────────────────────────────────────

function WaitUntilEditor(props: NodeEditorProps) {
  const [local, setLocal] = useState(() => readWaitUntilInput(props.node.node, props.timeZone));

  const save = async (): Promise<void> => {
    if (!local) {
      showToast('Pick a date and time.', { tone: 'error' });
      return;
    }
    await props.onSaveNode(writeWaitUntilConfig(local, props.timeZone));
    props.onDone();
  };

  return (
    <div class="space-y-4">
      <Field label="Wait until" hint={`Interpreted in the workspace timezone (${props.timeZone}).`}>
        <Input data-testid="wait-until-input" type="datetime-local" value={local} onInput={(e: Event) => setLocal((e.target as HTMLInputElement).value)} />
      </Field>
      <p data-testid="wait-until-tz" class="text-xs text-stone-400">
        Timezone: {props.timeZone}
      </p>
      <div class="flex justify-end">
        <Button data-testid="node-save" onClick={save}>
          Save wait-until
        </Button>
      </div>
    </div>
  );
}

// ── HOUR-OF-DAY WINDOW ────────────────────────────────────────────────────────────

function HourWindowEditor(props: NodeEditorProps) {
  const init = readHourWindow(props.node.node);
  const [startHour, setStartHour] = useState(init.startHour);
  const [endHour, setEndHour] = useState(init.endHour);
  const [days, setDays] = useState<number[]>([...init.daysOfWeek]);

  const toggleDay = (d: number) => setDays((ds) => (ds.includes(d) ? ds.filter((x) => x !== d) : [...ds, d]));

  const save = async (): Promise<void> => {
    const form: HourWindowForm = { startHour, endHour, daysOfWeek: days };
    await props.onSaveNode(writeHourWindowConfig(form));
    props.onDone();
  };

  const hours = Array.from({ length: 24 }, (_, h) => h);
  return (
    <div class="space-y-4">
      <p class="text-sm text-stone-500">Only let the journey proceed within these hours (and, optionally, days). Steps that arrive outside the window wait until it opens.</p>
      <div class="flex items-center gap-3">
        <Field label="From hour">
          <Select data-testid="hour-start" value={String(startHour)} onChange={(e: Event) => setStartHour(Number((e.target as HTMLSelectElement).value))}>
            {hours.map((h) => (
              <option key={h} value={String(h)}>
                {String(h).padStart(2, '0')}:00
              </option>
            ))}
          </Select>
        </Field>
        <Field label="To hour">
          <Select data-testid="hour-end" value={String(endHour)} onChange={(e: Event) => setEndHour(Number((e.target as HTMLSelectElement).value))}>
            {hours.map((h) => (
              <option key={h} value={String(h)}>
                {String(h).padStart(2, '0')}:00
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <Field label="Days (optional — none = every day)">
        <div data-testid="hour-days" class="flex flex-wrap gap-1.5">
          {DAY_LABELS.map((label, d) => (
            <button
              key={d}
              type="button"
              data-testid={`hour-day-${d}`}
              aria-pressed={days.includes(d)}
              onClick={() => toggleDay(d)}
              class={`rounded-lg px-3 py-1.5 text-sm font-medium ring-1 ring-inset transition-colors ${
                days.includes(d) ? 'bg-brand-50 text-brand-700 ring-brand-200' : 'bg-white text-stone-600 ring-stone-200 hover:bg-stone-50'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </Field>
      <div class="flex justify-end">
        <Button data-testid="node-save" onClick={save}>
          Save window
        </Button>
      </div>
    </div>
  );
}

// ── IF / condition ──────────────────────────────────────────────────────────────

function ConditionEditor(props: NodeEditorProps) {
  const initialAst = (props.node.node as { ast?: AstNode }).ast ?? null;
  const initialLabel = String((props.node.node as { label?: unknown }).label ?? '');
  const [name, setName] = useState(initialLabel);
  const [group, setGroup] = useState<RuleGroup>(() => groupFromAst(initialAst));
  const empty = conditionGroupIsEmpty(group);

  const save = async (): Promise<void> => {
    const node = writeConditionConfig(group, name);
    if (!node) {
      // The editor BLOCKS save on an empty rule group (no native dialog — inline).
      return;
    }
    await props.onSaveNode(node);
    props.onDone();
  };

  return (
    <div class="space-y-4">
      <p class="text-sm text-stone-500">Split the journey: profiles matching these rules take the <b>Yes</b> branch, everyone else takes <b>No</b>. Same rule builder as segments.</p>
      <Field label="Name (optional)" hint="A short label shown on the branch card, e.g. “VIP?”.">
        <Input
          data-testid="condition-name"
          value={name}
          placeholder="If / branch"
          onInput={(e: Event) => setName((e.target as HTMLInputElement).value)}
        />
      </Field>
      <RuleBuilder group={group} onChange={setGroup} allowEmptyRootRules />
      {empty ? (
        <p data-testid="condition-incomplete" class="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-700 ring-1 ring-inset ring-amber-200">
          Add at least one rule before saving this branch.
        </p>
      ) : null}
      <div class="flex justify-end">
        <Button data-testid="node-save" disabled={empty} onClick={save}>
          Save condition
        </Button>
      </div>
    </div>
  );
}

// ── SEND ──────────────────────────────────────────────────────────────────────────

interface Template {
  id: string;
  name: string;
  kind?: string;
}

function SendEditor(props: NodeEditorProps) {
  const attachedId = sendNodeTemplateId(props.node.node);
  const [medium, setMedium] = useState<SendMedium>(() => sendNodeMedium(props.node.node));
  const [templates, setTemplates] = useState<Template[]>([]);
  const [pick, setPick] = useState('');
  const [envelope, setEnvelope] = useState<{ subject: string; sender_id: string | null; to_address: string } | null>(null);
  const [textBody, setTextBody] = useState<string>(() => readSendConfig(props.node.node).textBody);
  // Reusable text templates (SMS/WhatsApp). Picking one COPIES its body into the
  // body field (copy-on-select — the user can still edit). No live reference.
  const [textTemplates, setTextTemplates] = useState<{ id: string; name: string; body: string }[]>([]);

  useEffect(() => {
    void api
      .get<{ templates: { id: string; name: string; body: string }[] }>('/text-templates')
      .then((r) => setTextTemplates(r.templates))
      .catch(() => undefined);
  }, []);

  // The medium selector — sits above the per-channel body. Changing it does not
  // persist on its own; Save (text) or the attach/design flow (email) persists.
  const mediumSelect = (
    <Field label="Channel">
      <Select
        data-testid="send-medium"
        value={medium}
        onChange={(e: Event) => setMedium((e.target as HTMLSelectElement).value as SendMedium)}
      >
        <option value="email">Email</option>
        <option value="sms">SMS</option>
        <option value="whatsapp">WhatsApp</option>
      </Select>
    </Field>
  );

  // A TEXT send (sms/whatsapp): a plain merge-tag body, saved into the node config.
  if (medium === 'sms' || medium === 'whatsapp') {
    const saveText = async (): Promise<void> => {
      if (!textBody.trim()) {
        showToast('Add a message body before saving.', { tone: 'error' });
        return;
      }
      await props.onSaveNode(writeSendConfig({ medium, textBody }));
      props.onDone();
    };
    return (
      <div class="space-y-4">
        {mediumSelect}
        {textTemplates.length ? (
          <Field label="Use a text template (optional)">
            <Select
              data-testid="text-template-pick"
              value=""
              onChange={(e: Event) => {
                const tid = (e.target as HTMLSelectElement).value;
                const tpl = textTemplates.find((t) => t.id === tid);
                if (tpl) setTextBody(tpl.body);
                (e.target as HTMLSelectElement).value = '';
              }}
            >
              <option value="">— none —</option>
              {textTemplates.map((t) => (
                <option value={t.id} key={t.id}>
                  {t.name}
                </option>
              ))}
            </Select>
          </Field>
        ) : null}
        <Field label="Message body" hint="Plain text. Merge tags like {{customer.first_name}} render per recipient.">
          <Textarea
            data-testid="send-text-body"
            rows={5}
            placeholder={`Hi {{customer.first_name}}, …`}
            value={textBody}
            onInput={(e: Event) => setTextBody((e.target as HTMLTextAreaElement).value)}
          />
        </Field>
        <p class="text-xs text-stone-400">
          Sends to the recipient&apos;s phone ({'{{customer.phone}}'}) via the {medium === 'sms' ? 'SMS' : 'WhatsApp'} provider.
        </p>
        <Button data-testid="send-save-text" onClick={saveText}>
          Save
        </Button>
      </div>
    );
  }

  // Library templates for the picker (only kind!='copy' ones are reusable designs).
  useEffect(() => {
    void api
      .get<{ templates: Template[] }>('/templates')
      .then((r) => setTemplates(r.templates.filter((t) => t.kind !== 'copy')))
      .catch(() => undefined);
  }, []);

  // Load the attached copy's envelope so the instance view can show From/To/Subject.
  useEffect(() => {
    if (!attachedId) {
      setEnvelope(null);
      return;
    }
    void api
      .get<{ template: { subject: string | null; sender_id: string | null; to_address: string | null } }>(`/templates/${attachedId}`)
      .then((r) => setEnvelope({ subject: r.template.subject ?? '', sender_id: r.template.sender_id ?? null, to_address: r.template.to_address ?? '' }))
      .catch(() => setEnvelope(null));
  }, [attachedId]);

  // Attach a LIBRARY template: the server clones it into a kind='copy' and repoints
  // the send node (the same instance flow as broadcasts) — NOT the old placeholder.
  const attachTemplate = async (): Promise<void> => {
    if (!props.campaignId || !pick) {
      showToast('Pick a template to start from.', { tone: 'error' });
      return;
    }
    await api.post(`/campaigns/${props.campaignId}/send-nodes/${props.node.id}/attach-template`, { body: { template_id: pick } });
    // Pull the server's repointed template_id back into the model BEFORE closing,
    // so reopening this node shows the instance (and a re-persist can't wipe it).
    await props.onReloadCampaign();
    props.onDone();
  };

  // Design the email for this send node. Reuses the broadcast clone/return flow:
  // editorReturn=/campaigns/:id so the editor's Back reads "← Back to campaign".
  const designEmail = (): void => {
    if (!props.campaignId) return;
    if (attachedId) {
      setEditorReturn(`/campaigns/${props.campaignId}`);
      navigate(`/editor/${attachedId}`);
    } else {
      setEditorReturn(`/campaigns/${props.campaignId}`, { createAs: 'copy' });
      navigate('/editor');
    }
  };

  const senderName = (id: string | null): string => (id ? 'a named sender' : '—');

  if (attachedId) {
    return (
      <div class="space-y-4">
        {mediumSelect}
        <div data-testid="send-email-instance" class="rounded-xl border border-sky-200 bg-sky-50/50 p-4">
          <p class="text-sm font-semibold text-sky-800">This step's email</p>
          <dl class="mt-2 space-y-1 text-sm text-stone-600">
            <div><span class="text-stone-400">From:</span> {senderName(envelope?.sender_id ?? null)}</div>
            <div><span class="text-stone-400">To:</span> {envelope?.to_address || '—'}</div>
            <div><span class="text-stone-400">Subject:</span> {envelope?.subject || '—'}</div>
          </dl>
        </div>
        <div class="flex items-center gap-2">
          <Button data-testid="send-design-email" onClick={designEmail}>
            Design email
          </Button>
          <Button data-testid="send-start-over" variant="secondary" onClick={() => props.onSaveNode({ type: 'action', kind: 'send' }).then(props.onDone)}>
            Start over
          </Button>
        </div>
        <p class="text-xs text-stone-400">From, To and Subject must all be set before you can publish.</p>
      </div>
    );
  }

  return (
    <div class="space-y-4">
      {mediumSelect}
      <p class="text-sm text-stone-500">This step sends an email through the dispatcher. Start from a library template (it's cloned into this step's own editable copy) or design a blank one.</p>
      <Field label="Start from a template">
        <div class="flex items-center gap-2">
          <Select data-testid="send-template-pick" value={pick} onChange={(e: Event) => setPick((e.target as HTMLSelectElement).value)}>
            <option value="">Choose a template…</option>
            {templates.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </Select>
          <Button data-testid="send-attach-template" disabled={!pick} onClick={attachTemplate}>
            Use template
          </Button>
        </div>
      </Field>
      <div class="flex items-center gap-2 text-sm text-stone-400">
        <span class="h-px flex-1 bg-stone-200" /> or <span class="h-px flex-1 bg-stone-200" />
      </div>
      <Button data-testid="send-blank-design" variant="secondary" onClick={designEmail}>
        Start from a blank design
      </Button>
    </div>
  );
}

// ── UPDATE-PROFILE (set_attribute) ───────────────────────────────────────────────

/** Common merge tokens offered by the per-row placeholder inserter (expression + js). */
const PLACEHOLDER_TOKENS: { label: string; token: string }[] = [
  { label: 'customer.email', token: '{{customer.email}}' },
  { label: 'customer.external_id', token: '{{customer.external_id}}' },
  { label: 'customer.first_name', token: '{{customer.first_name}}' },
  { label: 'customer.last_name', token: '{{customer.last_name}}' },
  { label: 'customer.tier', token: '{{customer.tier}}' },
  { label: 'event.type', token: '{{event.type}}' },
  { label: 'event.amount', token: '{{event.amount}}' },
  { label: 'event.sku', token: '{{event.sku}}' },
];

function UpdateProfileEditor(props: NodeEditorProps) {
  const init = readSetAttributeValue(props.node.node);
  const [rows, setRows] = useState<AssignmentRow[]>([...init.rows]);

  const form: SetAttributeForm = { rows };
  const hasKey = setAttributeFormHasKey(form);

  const setRow = (i: number, patch: Partial<AssignmentRow>): void =>
    setRows((rs) => rs.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  const addRow = (): void => setRows((rs) => [...rs, emptyAssignmentRow()]);
  const removeRow = (i: number): void => setRows((rs) => (rs.length <= 1 ? rs : rs.filter((_, idx) => idx !== i)));
  // Insert a token at the end of the row's active value field (expression | js).
  const insertToken = (i: number, token: string): void => {
    setRows((rs) =>
      rs.map((r, idx) => {
        if (idx !== i || !token) return r;
        if (r.mode === 'expression') return { ...r, expression: `${r.expression}${token}` };
        if (r.mode === 'js') return { ...r, js: `${r.js}${token}` };
        return r;
      }),
    );
  };

  const save = async (): Promise<void> => {
    if (!hasKey) return; // blocked inline (no native dialog)
    await props.onSaveNode(writeSetAttributeConfig(form));
    props.onDone();
  };

  return (
    <div class="space-y-4">
      <p class="text-sm text-stone-500">Set one or more profile attributes. Each value can be a fixed value, an expression with {'{{customer.*}}'} / {'{{event.*}}'} tokens, or a small sandboxed JavaScript snippet.</p>
      <div data-testid="assignment-rows" class="space-y-3">
        {rows.map((r, i) => (
          <div key={i} data-testid="assignment-row" class="rounded-xl border border-stone-200 p-3 space-y-2">
            <div class="flex items-center gap-2">
              <Input
                data-testid="assignment-key"
                class="flex-1"
                placeholder="attribute key (e.g. stage)"
                value={r.key}
                onInput={(e: Event) => setRow(i, { key: (e.target as HTMLInputElement).value })}
              />
              <Select
                data-testid="assignment-value-mode"
                class="w-44"
                value={r.mode}
                onChange={(e: Event) => setRow(i, { mode: (e.target as HTMLSelectElement).value as ValueMode })}
              >
                <option value="literal">A fixed value</option>
                <option value="expression">An expression / token</option>
                <option value="js">A JS function</option>
              </Select>
              <Button
                data-testid="assignment-remove"
                variant="ghost"
                size="sm"
                aria-label="Remove assignment"
                disabled={rows.length <= 1}
                onClick={() => removeRow(i)}
              >
                ✕
              </Button>
            </div>

            {r.mode === 'literal' ? (
              <Input
                data-testid="assignment-literal"
                placeholder="engaged"
                value={r.literal}
                onInput={(e: Event) => setRow(i, { literal: (e.target as HTMLInputElement).value })}
              />
            ) : r.mode === 'expression' ? (
              <>
                <Input
                  data-testid="assignment-expression"
                  class="font-mono text-xs"
                  placeholder="{{event.sku}}"
                  value={r.expression}
                  onInput={(e: Event) => setRow(i, { expression: (e.target as HTMLInputElement).value })}
                />
                <PlaceholderInsert rowIndex={i} onInsert={insertToken} />
              </>
            ) : (
              <>
                <Textarea
                  data-testid="assignment-js"
                  class="font-mono text-xs"
                  rows={3}
                  placeholder={'return customer.first_name.toUpperCase()'}
                  value={r.js}
                  onInput={(e: Event) => setRow(i, { js: (e.target as HTMLTextAreaElement).value })}
                />
                <PlaceholderInsert rowIndex={i} onInsert={insertToken} />
                <p class="text-xs text-stone-400">
                  <code>customer</code> and <code>event</code> are in scope; {'{{…}}'} placeholders expand (as quoted literals) before the snippet runs. Return the value to set.
                </p>
              </>
            )}
          </div>
        ))}
      </div>

      <Button data-testid="assignment-add" variant="ghost" size="sm" onClick={addRow}>
        + Add attribute
      </Button>

      {!hasKey ? (
        <p data-testid="update-incomplete" class="text-sm text-amber-600">Enter at least one attribute key before saving.</p>
      ) : null}
      <div class="flex justify-end">
        <Button data-testid="node-save" disabled={!hasKey} onClick={save}>
          Save update
        </Button>
      </div>
    </div>
  );
}

/** A tag-cloud of clickable token links for expression / js value fields — clicking
 *  one inserts its {{…}} token into the row's value (cleaner than a dropdown). */
function PlaceholderInsert(props: { rowIndex: number; onInsert: (i: number, token: string) => void }) {
  return (
    <div data-testid="placeholder-insert" class="flex flex-wrap items-center gap-1.5">
      <span class="text-[11px] font-medium uppercase tracking-wide text-stone-400">Insert</span>
      {PLACEHOLDER_TOKENS.map((t) => (
        <button
          key={t.token}
          type="button"
          data-testid="placeholder-token"
          data-token={t.token}
          title={t.token}
          onClick={() => props.onInsert(props.rowIndex, t.token)}
          class="rounded-md border border-stone-200 bg-stone-50 px-2 py-0.5 font-mono text-[11px] text-stone-600 transition-colors hover:border-brand-300 hover:bg-brand-50 hover:text-brand-700"
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

// ── WEBHOOK ─────────────────────────────────────────────────────────────────────

function WebhookEditor(props: NodeEditorProps) {
  const init = readWebhookConfig(props.node.node);
  const existingSecrets = webhookSecretHeaders(props.node.node);
  const [url, setUrl] = useState(init.url);
  const [method, setMethod] = useState<WebhookForm['method']>(init.method);
  const [headers, setHeaders] = useState<WebhookHeaderRow[]>([...init.headers]);
  const [bodyTemplate, setBodyTemplate] = useState(init.bodyTemplate);
  const [timeoutMs, setTimeoutMs] = useState(init.timeoutMs);
  const [maxRetries, setMaxRetries] = useState(init.maxRetries);
  const [secretHeader, setSecretHeader] = useState(init.secretHeader);
  const [secret, setSecret] = useState('');
  const [error, setError] = useState<string | null>(null);

  const setHeader = (i: number, patch: Partial<WebhookHeaderRow>) =>
    setHeaders((hs) => hs.map((h, idx) => (idx === i ? { ...h, ...patch } : h)));

  const save = async (): Promise<void> => {
    const form: WebhookForm = { url, method, headers, bodyTemplate, timeoutMs, maxRetries, secret, secretHeader, hasSecret: init.hasSecret };
    const { node, error: err } = writeWebhookConfig(form, existingSecrets);
    if (!node) {
      setError(err);
      return;
    }
    setError(null);
    await props.onSaveNode(node);
    props.onDone();
  };

  return (
    <div class="space-y-4">
      <div class="flex items-end gap-2">
        <Field label="URL" class="flex-1" hint="Must be http(s).">
          <Input data-testid="webhook-url" placeholder="https://hooks.example.com/x" value={url} onInput={(e: Event) => setUrl((e.target as HTMLInputElement).value)} />
        </Field>
        <Field label="Method">
          <Select data-testid="webhook-method" value={method} onChange={(e: Event) => setMethod((e.target as HTMLSelectElement).value as WebhookForm['method'])}>
            {['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </Select>
        </Field>
      </div>

      <Field label="Headers">
        <div data-testid="webhook-headers" class="space-y-2">
          {headers.map((h, i) => (
            <div key={i} class="flex items-center gap-2">
              <Input data-testid="webhook-header-name" class="flex-1" placeholder="Header" value={h.name} onInput={(e: Event) => setHeader(i, { name: (e.target as HTMLInputElement).value })} />
              <Input data-testid="webhook-header-value" class="flex-1" placeholder="value" value={h.value} onInput={(e: Event) => setHeader(i, { value: (e.target as HTMLInputElement).value })} />
              <Button data-testid="webhook-header-remove" variant="ghost" size="sm" aria-label="Remove header" onClick={() => setHeaders((hs) => hs.filter((_, idx) => idx !== i))}>
                ✕
              </Button>
            </div>
          ))}
          <Button data-testid="webhook-header-add" variant="ghost" size="sm" onClick={() => setHeaders((hs) => [...hs, { name: '', value: '' }])}>
            + Add header
          </Button>
        </div>
      </Field>

      <Field label="Secret / auth header" hint="Write-only — never shown again after saving.">
        <div class="flex items-center gap-2">
          <Input data-testid="webhook-secret-header" class="w-48" placeholder="Authorization" value={secretHeader} onInput={(e: Event) => setSecretHeader((e.target as HTMLInputElement).value)} />
          <Input data-testid="webhook-secret" class="flex-1" type="password" placeholder={init.hasSecret ? '•••••• (saved)' : 'Bearer …'} value={secret} onInput={(e: Event) => setSecret((e.target as HTMLInputElement).value)} />
        </div>
      </Field>

      <Field label="Body template (optional)">
        <Textarea data-testid="webhook-body" class="font-mono text-xs" value={bodyTemplate} onInput={(e: Event) => setBodyTemplate((e.target as HTMLTextAreaElement).value)} placeholder='{"email":"{{customer.email}}"}' />
      </Field>

      <div class="flex items-end gap-2">
        <Field label="Timeout (ms)">
          <Input data-testid="webhook-timeout" type="number" min={1} class="w-32" value={timeoutMs} onInput={(e: Event) => setTimeoutMs((e.target as HTMLInputElement).value)} />
        </Field>
        <Field label="Max retries">
          <Input data-testid="webhook-retries" type="number" min={0} class="w-32" value={maxRetries} onInput={(e: Event) => setMaxRetries((e.target as HTMLInputElement).value)} />
        </Field>
      </div>

      {error ? (
        <p data-testid="webhook-error" class="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700 ring-1 ring-inset ring-rose-200">
          {error}
        </p>
      ) : null}
      <div class="flex justify-end">
        <Button data-testid="node-save" onClick={save}>
          Save webhook
        </Button>
      </div>
    </div>
  );
}

// ── EXIT (no config) ───────────────────────────────────────────────────────────

function ExitEditor() {
  return <p data-testid="exit-note" class="text-sm text-stone-500">This step ends the journey. There's nothing to configure.</p>;
}

// ── dispatcher ────────────────────────────────────────────────────────────────────

/** The drawer testid for a node type (node-editor-<displayType>). */
export function nodeEditorTestId(node: CanvasNode): string {
  return `node-editor-${displayType(node.node)}`;
}

/** Human title for the editor header. */
export function nodeEditorTitle(node: CanvasNode): string {
  const map: Record<string, string> = {
    trigger: 'Edit trigger',
    wait: 'Edit wait',
    wait_until: 'Edit wait-until',
    hour_of_day_window: 'Edit hour window',
    condition: 'Edit condition',
    send: 'Edit send email',
    set_attribute: 'Update profile',
    webhook: 'Edit webhook',
    exit: 'Exit step',
  };
  return map[displayType(node.node)] ?? 'Edit step';
}

/** Pick + render the editor for the selected node. */
export function NodeEditorBody(props: NodeEditorProps) {
  switch (displayType(props.node.node)) {
    case 'trigger':
      return <TriggerEditor {...props} />;
    case 'wait':
      return <WaitEditor {...props} />;
    case 'wait_until':
      return <WaitUntilEditor {...props} />;
    case 'hour_of_day_window':
      return <HourWindowEditor {...props} />;
    case 'condition':
      return <ConditionEditor {...props} />;
    case 'send':
      return <SendEditor {...props} />;
    case 'set_attribute':
      return <UpdateProfileEditor {...props} />;
    case 'webhook':
      return <WebhookEditor {...props} />;
    case 'exit':
    default:
      return <ExitEditor />;
  }
}
