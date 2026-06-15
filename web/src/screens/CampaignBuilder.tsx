// CampaignBuilder (§12, §9B): a lean visual workflow builder over the node DSL
// (trigger/wait/condition/action/exit). Assembles the definition via the pure
// builder and saves it (the server validates with validateCampaignDefinition).
// (Visual redesign; all data-testid attributes preserved.)
import { useEffect, useState } from 'preact/hooks';
import { api } from '../store/session.js';
import { navigate } from '../router.js';
import { buildDefinition, starterNodes, type BuilderNode } from '../campaigns/builder.js';
import { Badge, Button, Card, Field, Input, PageHeader, Select, EmptyState, toneFor } from '../ui/kit.js';

interface Template {
  id: string;
  name: string;
}
interface Sender {
  id: string;
  name: string;
  email: string;
}
interface Campaign {
  id: string;
  name: string;
  status: string;
}

const NODE_STYLE: Record<string, string> = {
  trigger: 'bg-brand-50 text-brand-700 ring-brand-200',
  wait: 'bg-amber-50 text-amber-700 ring-amber-200',
  condition: 'bg-violet-50 text-violet-700 ring-violet-200',
  action: 'bg-sky-50 text-sky-700 ring-sky-200',
  exit: 'bg-stone-100 text-stone-600 ring-stone-200',
};

export function CampaignBuilder() {
  const [templates, setTemplates] = useState<Template[]>([]);
  const [senders, setSenders] = useState<Sender[]>([]);
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [name, setName] = useState('');
  const [nodes, setNodes] = useState<BuilderNode[]>([]);
  // The send step's envelope (applies to the journey's send action). To is always
  // the enrolled profile's {{customer.email}}; From '' → no-reply fallback.
  const [subject, setSubject] = useState('');
  const [senderId, setSenderId] = useState('');
  const [error, setError] = useState('');

  const reload = async () => {
    const [t, c, sn] = await Promise.all([
      api.get<{ templates: Template[] }>('/templates'),
      api.get<{ campaigns: Campaign[] }>('/campaigns'),
      // Senders are optional (the From dropdown) — never let them blank the builder.
      api.get<{ senders: Sender[] }>('/domain-senders').catch(() => ({ senders: [] })),
    ]);
    setTemplates(t.templates);
    setCampaigns(c.campaigns);
    setSenders(sn.senders);
    if (t.templates[0]) setNodes(starterNodes(t.templates[0].id));
  };

  useEffect(() => {
    void reload();
  }, []);

  const addWait = () => {
    const tpl = templates[0]?.id ?? '';
    setNodes([
      { id: 'trigger', type: 'trigger', kind: 'segment_entry', next: 'wait1' },
      { id: 'wait1', type: 'wait', delaySeconds: 172800, next: 'send' },
      { id: 'send', type: 'action', kind: 'send', templateId: tpl, next: 'done' },
      { id: 'done', type: 'exit' },
    ]);
  };

  const save = async () => {
    setError('');
    try {
      // Stamp the send step's envelope (subject/sender) onto the send action nodes.
      const withEnvelope = nodes.map((n) =>
        n.type === 'action' && n.kind === 'send'
          ? { ...n, ...(subject ? { subject } : {}), ...(senderId ? { senderId } : {}) }
          : n,
      );
      const def = buildDefinition(withEnvelope);
      await api.post('/campaigns', { body: { name: name || 'Untitled campaign', definition: def } });
      await reload();
    } catch (err) {
      setError((err as { error?: string })?.error ?? String(err));
    }
  };

  return (
    <section data-testid="campaign-builder">
      <PageHeader
        title="Campaigns"
        subtitle="Design a multi-step journey: trigger → wait → branch → action."
        actions={
          <Button data-testid="design-email" variant="secondary" onClick={() => navigate('/editor')}>
            Design email
          </Button>
        }
      />

      <Card class="p-5">
        <Field label="Campaign name" class="max-w-sm">
          <Input
            data-testid="campaign-name"
            placeholder="Welcome series"
            value={name}
            onInput={(e: Event) => setName((e.target as HTMLInputElement).value)}
          />
        </Field>

        {/* Send step envelope — From / To / Subject for the journey's email. */}
        <div class="mt-4 grid gap-3 sm:grid-cols-2">
          <Field label="From">
            <Select
              data-testid="campaign-sender"
              value={senderId}
              onChange={(e: Event) => setSenderId((e.target as HTMLSelectElement).value)}
            >
              <option value="">Default (no-reply@your domain)</option>
              {senders.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name} &lt;{s.email}&gt;
                </option>
              ))}
            </Select>
          </Field>
          <Field label="To">
            <Input data-testid="campaign-to" value="{{customer.email}}" disabled readOnly />
          </Field>
          <Field label="Subject" class="sm:col-span-2">
            <Input
              data-testid="campaign-subject"
              placeholder="Welcome aboard"
              value={subject}
              onInput={(e: Event) => setSubject((e.target as HTMLInputElement).value)}
            />
          </Field>
        </div>

        <span class="label mt-5">Workflow</span>
        <div
          data-testid="campaign-canvas"
          class="flex flex-wrap items-center gap-2 rounded-xl border border-dashed border-stone-300 bg-stone-50/60 p-4"
        >
          {nodes.length === 0 ? (
            <span class="text-sm text-stone-400">No steps yet — add a wait step to start.</span>
          ) : (
            nodes.map((n, idx) => (
              <span key={n.id} class="flex items-center gap-2">
                <span
                  data-testid={`node-${n.type}`}
                  class={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold capitalize ring-1 ring-inset ${
                    NODE_STYLE[n.type] ?? NODE_STYLE.exit
                  }`}
                >
                  {n.type}
                </span>
                {idx < nodes.length - 1 ? <span class="text-stone-300">→</span> : null}
              </span>
            ))
          )}
        </div>

        <div class="mt-4 flex items-center gap-3">
          <Button data-testid="add-wait-node" variant="secondary" onClick={addWait}>
            Add wait step
          </Button>
          <Button data-testid="save-campaign" onClick={save} disabled={nodes.length === 0}>
            Save campaign
          </Button>
        </div>
        {error ? (
          <p
            data-testid="campaign-error"
            class="mt-3 rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700 ring-1 ring-inset ring-rose-200"
          >
            {error}
          </p>
        ) : null}
      </Card>

      <h2 class="mb-3 mt-7 text-base font-bold text-ink-900">Campaigns</h2>
      {campaigns.length ? (
        <ul data-testid="campaign-list" class="space-y-2">
          {campaigns.map((c) => (
            <li
              data-testid="campaign-item"
              key={c.id}
              class="flex items-center justify-between rounded-xl border border-stone-200 bg-white px-4 py-3 text-sm shadow-card"
            >
              <span class="font-medium text-ink-900">{c.name}</span>
              <Badge tone={toneFor(c.status)}>{c.status}</Badge>
            </li>
          ))}
        </ul>
      ) : (
        <div data-testid="campaign-list">
          <EmptyState>No campaigns yet.</EmptyState>
        </div>
      )}
    </section>
  );
}
