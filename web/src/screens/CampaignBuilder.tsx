// Campaigns (§12, §9B phases 5–7). Like Broadcasts, this is a LIST page
// (CampaignsList at #/campaigns) + a SEPARATE edit page (CampaignDetail, the
// constrained downward CANVAS builder, at #/campaigns/new and #/campaigns/:id).
//
// CampaignsList: a table of campaigns (name, lifecycle status, enrollment counts)
// with a "New campaign" action and a per-row ActionMenu (Open · Pause/Resume ·
// Archive). Lifecycle actions are server-calling buttons (kit auto-locks on a
// returned promise) + askConfirm for archive (NEVER a native dialog) + a toast.
// There is NO "Design email" button here — email design lives ONLY inside a send
// node's editor (CampaignDetail → NodeEditor).
//
// CampaignDetail: the canvas builder (the bulk of the old combined screen, moved
// verbatim). It RENDERS a CampaignDefinition with auto-layout + rounded orthogonal
// connectors, inserts/deletes/edits steps via the (+) palette + per-node Drawer,
// SAVES via POST/PUT /campaigns (server re-validates) and PUBLISHES (Draft →
// Active) through the send-node envelope + verified-domain gate. Returning from a
// send node's "Design email" lands here (the editor's setEditorReturn targets
// /campaigns/:id). Server-calling buttons RETURN the promise; no native dialogs.
import { useEffect, useState } from 'preact/hooks';
import { api } from '../store/session.js';
import { navigate } from '../router.js';
import { Badge, Button, Card, Field, Input, PageHeader, EmptyState, toneFor, Drawer, ActionMenu } from '../ui/kit.js';
import type { ActionMenuItem } from '../ui/kit.js';
import { askConfirm } from '../ui/dialog.js';
import { showToast } from '../ui/toast.js';
import { CampaignCanvas, type Placement } from '../campaigns/CampaignCanvas.js';
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
import { insertOnEdge, deleteNode, moveSubtree, duplicateSubtree, MutationError } from '../campaigns/mutate.js';
import { NodeEditorBody, nodeEditorTestId, nodeEditorTitle } from '../campaigns/editors/NodeEditor.js';

/** Enrollment-status buckets surfaced per campaign on the list. */
interface EnrollmentCounts {
  active: number;
  completed: number;
  exited: number;
  failed: number;
}

interface CampaignListItem {
  id: string;
  name: string;
  status: string;
  counts: EnrollmentCounts;
}

interface SegmentLite {
  id: string;
  name: string;
}

/** Lifecycle statuses that hide a campaign from the default (non-archived) list. */
const ARCHIVED = 'archived';

// --- The LIST page -----------------------------------------------------------

export function CampaignsList() {
  const [campaigns, setCampaigns] = useState<CampaignListItem[] | null>(null);

  const reload = async (): Promise<void> => {
    const c = await api.get<{ campaigns: CampaignListItem[] }>('/campaigns');
    setCampaigns(c.campaigns);
  };
  useEffect(() => {
    void reload();
  }, []);

  // Lifecycle transitions — each RETURNS its promise so the ActionMenu spins +
  // locks the item until the response (no double-submits). Archive is confirmed
  // via the styled dialog (never window.confirm). All reload the list after.
  const lifecycle = async (id: string, action: 'pause' | 'resume', label: string): Promise<void> => {
    try {
      await api.post(`/campaigns/${id}/${action}`, { body: {} });
      showToast(`Campaign ${label}.`, { tone: 'success' });
      await reload();
    } catch (e) {
      showToast((e as { error?: string })?.error ?? `Could not ${action} the campaign.`, { tone: 'error' });
    }
  };
  const archive = async (id: string, name: string): Promise<void> => {
    const ok = await askConfirm({
      title: 'Archive campaign?',
      message: `“${name}” will be archived and stop enrolling. You can still find it later.`,
      confirmLabel: 'Archive',
      danger: true,
    });
    if (!ok) return;
    try {
      await api.post(`/campaigns/${id}/archive`, { body: {} });
      showToast('Campaign archived.', { tone: 'success' });
      await reload();
    } catch (e) {
      showToast((e as { error?: string })?.error ?? 'Could not archive the campaign.', { tone: 'error' });
    }
  };

  const visible = (campaigns ?? []).filter((c) => c.status !== ARCHIVED);

  return (
    <section data-testid="campaigns-list-screen">
      <PageHeader
        title="Campaigns"
        subtitle="Design a multi-step journey: it flows downward, branches fan sideways."
        actions={
          <Button data-testid="campaign-new" onClick={() => navigate('/campaigns/new')}>
            New campaign
          </Button>
        }
      />

      {campaigns === null ? (
        <p class="text-sm text-stone-500">Loading…</p>
      ) : visible.length ? (
        <ul data-testid="campaign-list" class="space-y-2">
          {visible.map((c) => {
            const total = c.counts.active + c.counts.completed + c.counts.exited + c.counts.failed;
            return (
              <li
                data-testid="campaign-item"
                key={c.id}
                class="grid grid-cols-[minmax(0,1fr)_8rem_auto_auto] items-center gap-4 rounded-xl border border-stone-200 bg-white px-4 py-3 shadow-card"
              >
                {/* Name */}
                <a
                  data-testid="campaign-open"
                  class="min-w-0 cursor-pointer truncate font-semibold text-ink-900 hover:text-brand-700"
                  onClick={() => navigate(`/campaigns/${c.id}`)}
                >
                  {c.name}
                </a>

                {/* Status badge */}
                <span class="justify-self-start">
                  <Badge data-testid="campaign-status" tone={toneFor(c.status)}>
                    {c.status}
                  </Badge>
                </span>

                {/* Enrollment counts summary */}
                <span
                  data-testid="campaign-counts"
                  class="flex items-center gap-4 text-center text-sm tabular-nums"
                  title={`${total} enrolled`}
                >
                  <span class="flex flex-col" data-testid="campaign-count-active">
                    <span class="text-[11px] uppercase tracking-wide text-stone-400">Active</span>
                    <span class="font-semibold text-ink-900">{c.counts.active}</span>
                  </span>
                  <span class="flex flex-col" data-testid="campaign-count-completed">
                    <span class="text-[11px] uppercase tracking-wide text-stone-400">Completed</span>
                    <span class="font-semibold text-emerald-700">{c.counts.completed}</span>
                  </span>
                  <span class="flex flex-col" data-testid="campaign-count-exited">
                    <span class="text-[11px] uppercase tracking-wide text-stone-400">Exited</span>
                    <span class="text-stone-500">{c.counts.exited}</span>
                  </span>
                  <span class="flex flex-col" data-testid="campaign-count-failed">
                    <span class="text-[11px] uppercase tracking-wide text-stone-400">Failed</span>
                    <span class={c.counts.failed > 0 ? 'font-semibold text-rose-600' : 'text-stone-500'}>
                      {c.counts.failed}
                    </span>
                  </span>
                </span>

                {/* Row actions — one kebab (⋮) menu mirroring broadcasts. */}
                <ActionMenu
                  data-testid="campaign-actions"
                  items={[
                    {
                      label: 'Open',
                      onSelect: () => navigate(`/campaigns/${c.id}`),
                      'data-testid': 'campaign-edit',
                    } satisfies ActionMenuItem,
                    ...(c.status === 'active'
                      ? [
                          {
                            label: 'Pause',
                            onSelect: () => lifecycle(c.id, 'pause', 'paused'),
                            'data-testid': 'campaign-pause',
                          } satisfies ActionMenuItem,
                        ]
                      : []),
                    ...(c.status === 'paused'
                      ? [
                          {
                            label: 'Resume',
                            onSelect: () => lifecycle(c.id, 'resume', 'resumed'),
                            'data-testid': 'campaign-resume',
                          } satisfies ActionMenuItem,
                        ]
                      : []),
                    {
                      label: 'Archive',
                      onSelect: () => archive(c.id, c.name),
                      danger: true,
                      'data-testid': 'campaign-archive',
                    } satisfies ActionMenuItem,
                  ]}
                />
              </li>
            );
          })}
        </ul>
      ) : (
        <div data-testid="campaign-list">
          <EmptyState>No campaigns yet — create one with “New campaign”.</EmptyState>
        </div>
      )}
    </section>
  );
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

// --- The DETAIL page (the canvas builder) ------------------------------------

export function CampaignDetail({ id }: { id?: string }) {
  // `id` is the path param: undefined / 'new' = a brand-new campaign; a uuid = an
  // existing one to load. editingId is the SERVER id once persisted (it starts as
  // the path id for an existing campaign, or null for a new one).
  const existingId = id && id !== 'new' ? id : null;
  const [campaigns, setCampaigns] = useState<CampaignListItem[]>([]);
  const [name, setName] = useState('');
  const [model, setModel] = useState<CanvasModel>(() => starterModel());
  const [editingId, setEditingId] = useState<string | null>(existingId);
  const [status, setStatus] = useState<string>('draft');
  const [timeZone, setTimeZone] = useState('UTC');
  const [triggerSegmentId, setTriggerSegmentId] = useState<string | null>(null);
  const [segments, setSegments] = useState<SegmentLite[]>([]);
  const [paletteEdge, setPaletteEdge] = useState<CanvasEdge | null>(null);
  const [openNode, setOpenNode] = useState<CanvasNode | null>(null);
  // An in-progress Move / Duplicate placement (pick a destination + to splice at).
  const [placement, setPlacement] = useState<Placement | null>(null);
  const [error, setError] = useState('');
  // Publish-gate feedback: a top-level reason + a per-node-id error for the card.
  const [publishReason, setPublishReason] = useState('');
  const [publishErrors, setPublishErrors] = useState<Record<string, string>>({});

  // (The list of campaigns is loaded only so save/reload can keep it fresh for the
  // contextual flows; the LIST page owns the user-facing table.)
  const reloadList = async (): Promise<void> => {
    const c = await api.get<{ campaigns: CampaignListItem[] }>('/campaigns');
    setCampaigns(c.campaigns);
  };

  useEffect(() => {
    void reloadList();
    void api.get<{ segments: SegmentLite[] }>('/segments').then((r) => setSegments(r.segments)).catch(() => undefined);
    if (existingId) void openById(existingId);
  }, [existingId]);

  const clearPublish = (): void => {
    setPublishReason('');
    setPublishErrors({});
  };

  // Load an existing campaign — GET /campaigns/:id round-trips the DSL → canvas
  // (and the workspace timezone + trigger_segment_id for the editors).
  const openById = async (cid: string): Promise<void> => {
    const res = await api.get<{
      campaign: { id: string; name: string; status: string; definition: CampaignDefinition; trigger_segment_id: string | null };
      timezone: string;
    }>(`/campaigns/${cid}`);
    setEditingId(res.campaign.id);
    setName(res.campaign.name);
    setStatus(res.campaign.status);
    setModel(parseDefinition(res.campaign.definition));
    setTriggerSegmentId(res.campaign.trigger_segment_id ?? null);
    setTimeZone(res.timezone || 'UTC');
    clearPublish();
    setError('');
  };

  // Insert a node on the chosen edge (from the palette).
  const insert = (type: PaletteType): void => {
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
  const remove = async (node: CanvasNode): Promise<void> => {
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

  // Start a Move / Duplicate placement: the canvas then asks the user to pick a
  // destination (+). (No server call yet — the splice happens on pick.)
  const startPlacement = (op: 'move' | 'duplicate', node: CanvasNode): void => {
    setPlacement({ op, rootId: node.id });
  };
  const cancelPlacement = (): void => setPlacement(null);

  // The user picked a destination edge while placing: apply the move/duplicate,
  // persist (server re-validates), and clear placement. A MutationError (the LOCAL
  // guards) or a server rejection surfaces as a toast and keeps the prior model.
  const pickTarget = async (edge: CanvasEdge): Promise<void> => {
    if (!placement) return;
    const { op, rootId } = placement;
    let next: CanvasModel;
    try {
      next = op === 'move' ? moveSubtree(model, rootId, edge) : duplicateSubtree(model, rootId, edge);
    } catch (e) {
      const msg = e instanceof MutationError || e instanceof Error ? e.message : String(e);
      showToast(msg, { tone: 'error' });
      return; // stay in placement so the user can pick another spot
    }
    setModel(next);
    setPlacement(null);
    clearPublish();
    try {
      await persist(next);
      await reloadList();
      showToast(op === 'move' ? 'Branch moved.' : 'Branch duplicated.', { tone: 'success' });
    } catch (err) {
      // The server rejected the new graph (e.g. an orphaned sibling): revert + toast.
      const msg = (err as { error?: string })?.error ?? String(err);
      setModel(model);
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
  const save = async (): Promise<void> => {
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
      const cid = await persist(next);
      await openById(cid);
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
    const cid = editingId ?? (await persist());
    await api.put(`/campaigns/${cid}`, { body: { trigger_segment_id: segmentId } });
    setTriggerSegmentId(segmentId);
  };

  // PUBLISH (Draft → Active). Persist first so the gate sees the latest definition,
  // then POST /activate. A 409 carries {error, node?, missing?} → render inline
  // against the offending node; a 400 is a structural reason; 200 flips to active.
  const publish = async (): Promise<void> => {
    clearPublish();
    setError('');
    let cid: string;
    try {
      cid = await persist();
      await reloadList();
    } catch (err) {
      const msg = (err as { error?: string })?.error ?? String(err);
      setPublishReason(msg);
      return;
    }
    try {
      await api.post(`/campaigns/${cid}/activate`, { body: {} });
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
      <button data-testid="campaigns-back" class="btn-ghost mb-4 btn-sm" onClick={() => navigate('/campaigns')}>
        ← Back to campaigns
      </button>

      <PageHeader
        title={editingId ? 'Edit campaign' : 'New campaign'}
        subtitle="Design a multi-step journey: it flows downward, branches fan sideways."
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
          placement={placement}
          onStartPlacement={startPlacement}
          onPickTarget={(edge) => void pickTarget(edge)}
          onCancelPlacement={cancelPlacement}
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
      {/* campaigns is loaded for freshness only; reference it so lint stays clean. */}
      <span hidden>{campaigns.length}</span>
    </section>
  );
}
