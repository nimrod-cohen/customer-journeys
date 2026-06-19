// CampaignBuilder (§12, §9B phase 5): a constrained DOWNWARD CANVAS over the node
// DSL. It RENDERS a CampaignDefinition with auto-layout + rounded orthogonal
// connectors (no manual drag, no stored coordinates), lets you INSERT a step on
// any edge (the (+) control → an 8-type palette) and DELETE a step (re-linking the
// graph), then SAVES the assembled definition via POST/PUT /campaigns — the server
// re-validates with validateCampaignDefinition. Reload via GET /campaigns/:id
// round-trips. Server-calling buttons RETURN the promise (kit Button auto-locks);
// no native dialogs (askConfirm for delete, showToast for errors).
import { useEffect, useState } from 'preact/hooks';
import { api } from '../store/session.js';
import { navigate } from '../router.js';
import { clearEditorReturn } from '../store/editorReturn.js';
import { Badge, Button, Card, Field, Input, PageHeader, EmptyState, toneFor, Drawer } from '../ui/kit.js';
import { askConfirm } from '../ui/dialog.js';
import { showToast } from '../ui/toast.js';
import { CampaignCanvas } from '../campaigns/CampaignCanvas.js';
import {
  parseDefinition,
  buildDefinition,
  starterModel,
  type CampaignDefinition,
  type CanvasModel,
  type CanvasEdge,
  type CanvasNode,
  type PaletteType,
} from '../campaigns/model.js';
import { insertOnEdge, deleteNode, MutationError } from '../campaigns/mutate.js';

interface Campaign {
  id: string;
  name: string;
  status: string;
}

/** The insert palette — all eight node types, each with a stable testid. */
const PALETTE: { type: PaletteType; label: string; testId: string; hint: string }[] = [
  { type: 'wait', label: 'Wait', testId: 'palette-wait', hint: 'Pause for a relative delay' },
  { type: 'wait_until', label: 'Wait until', testId: 'palette-wait-until', hint: 'Pause until a date' },
  { type: 'hour_of_day_window', label: 'Hour-of-day window', testId: 'palette-hour-window', hint: 'Only send within hours' },
  { type: 'condition', label: 'If / branch', testId: 'palette-if', hint: 'Split on a profile rule' },
  { type: 'send', label: 'Send email', testId: 'palette-send', hint: 'Send through the dispatcher' },
  { type: 'set_attribute', label: 'Update profile', testId: 'palette-update-profile', hint: 'Set a profile attribute' },
  { type: 'webhook', label: 'Webhook', testId: 'palette-webhook', hint: 'Call an external URL' },
  { type: 'exit', label: 'Exit', testId: 'palette-exit', hint: 'End the journey here' },
];

export function CampaignBuilder() {
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [name, setName] = useState('');
  const [model, setModel] = useState<CanvasModel>(() => starterModel());
  const [editingId, setEditingId] = useState<string | null>(null);
  const [paletteEdge, setPaletteEdge] = useState<CanvasEdge | null>(null);
  const [error, setError] = useState('');

  const reloadList = async () => {
    const c = await api.get<{ campaigns: Campaign[] }>('/campaigns');
    setCampaigns(c.campaigns);
  };

  useEffect(() => {
    void reloadList();
  }, []);

  // Start a brand-new campaign (the minimal trigger → exit starter).
  const startNew = () => {
    setEditingId(null);
    setName('');
    setModel(starterModel());
    setError('');
  };

  // Open an existing campaign — GET /campaigns/:id round-trips the DSL → canvas.
  const open = async (c: Campaign) => {
    const res = await api.get<{ campaign: { name: string; definition: CampaignDefinition } }>(`/campaigns/${c.id}`);
    setEditingId(c.id);
    setName(res.campaign.name);
    setModel(parseDefinition(res.campaign.definition));
    setError('');
  };

  // Insert a node on the chosen edge (from the palette).
  const insert = (type: PaletteType) => {
    if (!paletteEdge) return;
    try {
      setModel((m) => insertOnEdge(m, paletteEdge, type));
      setError('');
    } catch (e) {
      showToast(e instanceof Error ? e.message : String(e), { tone: 'error' });
    }
    setPaletteEdge(null);
  };

  // Delete a node (confirmed via the styled dialog — never window.confirm).
  const remove = async (node: CanvasNode) => {
    const okToDelete = await askConfirm({
      title: 'Delete this step?',
      message: 'The journey re-links around it. This cannot be undone.',
      confirmLabel: 'Delete step',
      danger: true,
    });
    if (!okToDelete) return;
    try {
      setModel((m) => deleteNode(m, node.id));
      setError('');
    } catch (e) {
      const msg = e instanceof MutationError || e instanceof Error ? e.message : String(e);
      showToast(msg, { tone: 'error' });
    }
  };

  // Save: POST (new) or PUT (existing). The server validates the definition; an
  // invalid graph surfaces as a styled error + toast (never a native dialog).
  const save = async () => {
    setError('');
    try {
      const definition = buildDefinition(model);
      if (editingId) {
        await api.put(`/campaigns/${editingId}`, { body: { name: name || 'Untitled campaign', definition } });
      } else {
        const r = await api.post<{ campaign: { id: string } }>('/campaigns', {
          body: { name: name || 'Untitled campaign', definition },
        });
        setEditingId(r.campaign.id);
      }
      await reloadList();
      showToast('Campaign saved', { tone: 'success' });
    } catch (err) {
      const msg = (err as { error?: string })?.error ?? String(err);
      setError(msg);
      showToast(msg, { tone: 'error' });
    }
  };

  return (
    <section data-testid="campaign-builder">
      <PageHeader
        title="Campaigns"
        subtitle="Design a multi-step journey: it flows downward, branches fan sideways."
        actions={
          <>
            <Button
              data-testid="design-email"
              variant="secondary"
              onClick={() => {
                clearEditorReturn(); // standalone design → Back goes to the template library
                navigate('/editor');
              }}
            >
              Design email
            </Button>
            <Button data-testid="campaign-new" variant="secondary" onClick={startNew}>
              New campaign
            </Button>
          </>
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

        <span class="label mt-5">Workflow</span>
        <CampaignCanvas model={model} onInsert={(edge) => setPaletteEdge(edge)} onDelete={remove} />

        <div class="mt-4 flex items-center gap-3">
          <Button data-testid="save-campaign" onClick={save}>
            {editingId ? 'Save changes' : 'Save campaign'}
          </Button>
          {editingId ? <span class="text-xs text-stone-400">Editing an existing campaign</span> : null}
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
              <div class="flex items-center gap-3">
                <Badge tone={toneFor(c.status)}>{c.status}</Badge>
                <Button data-testid="campaign-open" variant="secondary" size="sm" onClick={() => open(c)}>
                  Open
                </Button>
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <div data-testid="campaign-list">
          <EmptyState>No campaigns yet.</EmptyState>
        </div>
      )}

      {/* The insert palette (a side drawer). Opens from a (+) edge control. */}
      <Drawer
        open={paletteEdge !== null}
        onClose={() => setPaletteEdge(null)}
        title="Insert a step"
        subtitle="Pick a node type to add on this edge."
        testId="campaign-palette"
      >
        <div class="grid grid-cols-1 gap-2">
          {PALETTE.map((p) => (
            <button
              key={p.type}
              type="button"
              data-testid={p.testId}
              onClick={() => insert(p.type)}
              class="flex flex-col items-start rounded-xl border border-stone-200 bg-white px-4 py-3 text-left transition-colors hover:border-brand-400 hover:bg-brand-50/40"
            >
              <span class="text-sm font-semibold text-ink-900">{p.label}</span>
              <span class="text-xs text-stone-400">{p.hint}</span>
            </button>
          ))}
        </div>
      </Drawer>
    </section>
  );
}
