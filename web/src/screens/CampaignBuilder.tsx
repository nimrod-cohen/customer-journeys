// CampaignBuilder (§12, §9B phase 5–6): a constrained DOWNWARD CANVAS over the node
// DSL. It RENDERS a CampaignDefinition with auto-layout + rounded orthogonal
// connectors (no manual drag, no stored coordinates), lets you INSERT a step on
// any edge (the (+) control → an 8-type palette), DELETE a step (re-linking the
// graph), and now (phase 6) EDIT each step via a per-node Drawer editor. SAVES the
// assembled definition via POST/PUT /campaigns — the server re-validates with
// validateCampaignDefinition (a malformed graph is a TYPED 400). PUBLISH (Draft →
// Active) runs the send-node envelope + verified-domain gate; a 409 reason is
// rendered INLINE against the offending node card (no native dialog). Reload via
// GET /campaigns/:id round-trips. Server-calling buttons RETURN the promise (kit
// Button auto-locks); no native dialogs (askConfirm for delete, showToast/inline).
import { useEffect, useState } from 'preact/hooks';
import { api } from '../store/session.js';
import { navigate } from '../router.js';
import { clearEditorReturn, takeReturnedTo } from '../store/editorReturn.js';
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
import { applyNodeConfig } from '../campaigns/node-config.js';
import { insertOnEdge, deleteNode, MutationError } from '../campaigns/mutate.js';
import { NodeEditorBody, nodeEditorTestId, nodeEditorTitle } from '../campaigns/editors/NodeEditor.js';

interface Campaign {
  id: string;
  name: string;
  status: string;
}

interface SegmentLite {
  id: string;
  name: string;
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
  const [status, setStatus] = useState<string>('draft');
  const [timeZone, setTimeZone] = useState('UTC');
  const [triggerSegmentId, setTriggerSegmentId] = useState<string | null>(null);
  const [segments, setSegments] = useState<SegmentLite[]>([]);
  const [paletteEdge, setPaletteEdge] = useState<CanvasEdge | null>(null);
  const [openNode, setOpenNode] = useState<CanvasNode | null>(null);
  const [error, setError] = useState('');
  // Publish-gate feedback: a top-level reason + a per-node-id error for the card.
  const [publishReason, setPublishReason] = useState('');
  const [publishErrors, setPublishErrors] = useState<Record<string, string>>({});

  const reloadList = async () => {
    const c = await api.get<{ campaigns: Campaign[] }>('/campaigns');
    setCampaigns(c.campaigns);
  };

  useEffect(() => {
    void reloadList();
    void api.get<{ segments: SegmentLite[] }>('/segments').then((r) => setSegments(r.segments)).catch(() => undefined);
  }, []);

  // Returning from the email editor (a SEND node's "Design email"): re-open the
  // campaign we left so the SEND editor shows the freshly-attached/edited copy.
  useEffect(() => {
    const returnedTo = takeReturnedTo();
    if (returnedTo && returnedTo.startsWith('/campaigns/')) {
      const id = returnedTo.slice('/campaigns/'.length);
      if (id) void openById(id);
    }
  }, []);

  // Start a brand-new campaign (the minimal trigger → exit starter).
  const startNew = () => {
    setEditingId(null);
    setName('');
    setModel(starterModel());
    setStatus('draft');
    setTriggerSegmentId(null);
    clearPublish();
    setError('');
  };

  const clearPublish = () => {
    setPublishReason('');
    setPublishErrors({});
  };

  // Load an existing campaign — GET /campaigns/:id round-trips the DSL → canvas
  // (and the workspace timezone + trigger_segment_id for the editors).
  const openById = async (id: string) => {
    const res = await api.get<{
      campaign: { id: string; name: string; status: string; definition: CampaignDefinition; trigger_segment_id: string | null };
      timezone: string;
    }>(`/campaigns/${id}`);
    setEditingId(res.campaign.id);
    setName(res.campaign.name);
    setStatus(res.campaign.status);
    setModel(parseDefinition(res.campaign.definition));
    setTriggerSegmentId(res.campaign.trigger_segment_id ?? null);
    setTimeZone(res.timezone || 'UTC');
    clearPublish();
    setError('');
  };
  const open = (c: Campaign) => openById(c.id);

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

  // Persist the current model to the server (POST new / PUT existing), returning the
  // campaign id. The server validates the definition; an invalid graph throws (the
  // caller surfaces it). Used by Save AND before a node-config PUT/Publish so the
  // gate always sees the latest copy.
  const persist = async (overrideModel?: CanvasModel): Promise<string> => {
    const definition = buildDefinition(overrideModel ?? model);
    if (editingId) {
      await api.put(`/campaigns/${editingId}`, { body: { name: name || 'Untitled campaign', definition } });
      return editingId;
    }
    const r = await api.post<{ campaign: { id: string } }>('/campaigns', {
      body: { name: name || 'Untitled campaign', definition },
    });
    setEditingId(r.campaign.id);
    return r.campaign.id;
  };

  // Save: persist the definition; surface an invalid graph inline + via toast.
  const save = async () => {
    setError('');
    try {
      await persist();
      await reloadList();
      showToast('Campaign saved', { tone: 'success' });
    } catch (err) {
      const msg = (err as { error?: string })?.error ?? String(err);
      setError(msg);
      showToast(msg, { tone: 'error' });
    }
  };

  // A node editor saved its config: patch the model immutably, persist, reopen so
  // the editor reflects the round-tripped state (esp. the SEND clone).
  const saveNode = async (nodeId: string, patch: CampaignDefinition['nodes'][string]): Promise<void> => {
    const next = applyNodeConfig(model, nodeId, patch);
    setModel(next);
    clearPublish();
    try {
      const id = await persist(next);
      await openById(id);
      await reloadList();
    } catch (err) {
      const msg = (err as { error?: string })?.error ?? String(err);
      showToast(msg, { tone: 'error' });
      throw err;
    }
  };

  // The SEND editor's attach-template / design-email act on the node SERVER-SIDE
  // (POST .../send-nodes/:nodeId/attach-template reads the node from the stored
  // definition). So a freshly-inserted node must be PERSISTED before its editor
  // opens — for an EXISTING campaign too, not just a brand-new one (otherwise the
  // in-memory-only node 404s on attach and the drawer never closes). Node ids are
  // stable across persist (no re-layout), so the passed node stays valid. A
  // malformed in-progress graph surfaces as a toast and we don't open.
  const openEditor = async (node: CanvasNode): Promise<void> => {
    clearPublish();
    try {
      await persist();
      await reloadList();
    } catch (err) {
      showToast((err as { error?: string })?.error ?? String(err), { tone: 'error' });
      return;
    }
    setOpenNode(node);
  };

  const saveTriggerSegment = async (segmentId: string | null): Promise<void> => {
    if (!editingId) await persist();
    const id = editingId ?? (await persist());
    await api.put(`/campaigns/${id}`, { body: { trigger_segment_id: segmentId } });
    setTriggerSegmentId(segmentId);
  };

  // PUBLISH (Draft → Active). Persist first so the gate sees the latest definition,
  // then POST /activate. A 409 carries {error, node?, missing?} → render inline
  // against the offending node; a 400 is a structural reason; 200 flips to active.
  const publish = async (): Promise<void> => {
    clearPublish();
    setError('');
    let id: string;
    try {
      id = await persist();
      await reloadList();
    } catch (err) {
      const msg = (err as { error?: string })?.error ?? String(err);
      setPublishReason(msg);
      return;
    }
    try {
      await api.post(`/campaigns/${id}/activate`, { body: {} });
      setStatus('active');
      await reloadList();
      showToast('Campaign published', { tone: 'success' });
    } catch (err) {
      const body = err as { error?: string; node?: string; missing?: string };
      const msg = body?.error ?? 'Could not publish this campaign.';
      setPublishReason(msg);
      if (body?.node) setPublishErrors({ [body.node]: msg });
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
        <div class="flex flex-wrap items-end justify-between gap-3">
          <Field label="Campaign name" class="max-w-sm flex-1">
            <Input
              data-testid="campaign-name"
              placeholder="Welcome series"
              value={name}
              onInput={(e: Event) => setName((e.target as HTMLInputElement).value)}
            />
          </Field>
          {editingId ? (
            <Badge data-testid="campaign-status" tone={toneFor(status)}>
              {status}
            </Badge>
          ) : null}
        </div>

        <span class="label mt-5">Workflow</span>
        <CampaignCanvas
          model={model}
          onInsert={(edge) => setPaletteEdge(edge)}
          onDelete={remove}
          onOpen={(node) => void openEditor(node)}
          publishErrors={publishErrors}
        />

        <div class="mt-4 flex flex-wrap items-center gap-3">
          <Button data-testid="save-campaign" onClick={save}>
            {editingId ? 'Save changes' : 'Save campaign'}
          </Button>
          {editingId ? (
            <Button data-testid="campaign-publish" variant="secondary" onClick={publish}>
              Publish
            </Button>
          ) : null}
          {editingId ? <span class="text-xs text-stone-400">Editing an existing campaign</span> : null}
        </div>
        {publishReason ? (
          <p
            data-testid="publish-reason"
            class="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800 ring-1 ring-inset ring-amber-200"
          >
            {publishReason}
          </p>
        ) : null}
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

      {/* The per-node config editor (a side drawer, one body per node type). */}
      <Drawer
        open={openNode !== null}
        onClose={() => setOpenNode(null)}
        title={openNode ? nodeEditorTitle(openNode) : 'Edit step'}
        subtitle="Configure this step. Changes save into the journey."
        testId={openNode ? nodeEditorTestId(openNode) : 'node-editor'}
      >
        {openNode ? (
          <NodeEditorBody
            campaignId={editingId}
            node={openNode}
            timeZone={timeZone}
            segments={segments}
            triggerSegmentId={triggerSegmentId}
            onSaveNode={(patch) => saveNode(openNode.id, patch)}
            onSaveTriggerSegment={saveTriggerSegment}
            onReloadCampaign={async () => {
              if (editingId) await openById(editingId);
            }}
            onDone={() => setOpenNode(null)}
          />
        ) : null}
      </Drawer>
    </section>
  );
}
