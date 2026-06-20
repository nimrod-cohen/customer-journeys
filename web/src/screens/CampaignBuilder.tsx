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
import { createPortal } from 'preact/compat';
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
import { backfillAllowed, draftDiffersFrom, type PublishScope } from '../campaigns/versioning.js';
import { applyNodeConfig } from '../campaigns/node-config.js';
import {
  insertOnEdge,
  insertAfterBranch,
  deleteNode,
  moveSubtree,
  duplicateSubtree,
  MutationError,
} from '../campaigns/mutate.js';
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

/** One published version in the History tab. */
interface CampaignVersion {
  id: string;
  version: number;
  name: string;
  created_at: string;
  created_by: string | null;
  is_active: boolean;
}

/** Format a version's created_at for the History list (locale, fail-soft). */
function whenLabel(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  return new Date(t).toLocaleString();
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
  // When set, the palette is opened to insert a step AFTER this condition's branch
  // (the merge (+)); the chosen type splices in BEFORE the continuation.
  const [mergeConditionId, setMergeConditionId] = useState<string | null>(null);
  const [openNode, setOpenNode] = useState<CanvasNode | null>(null);
  // An in-progress Move / Duplicate placement (pick a destination + to splice at).
  const [placement, setPlacement] = useState<Placement | null>(null);
  const [error, setError] = useState('');
  // Publish-gate feedback: a top-level reason + a per-node-id error for the card.
  const [publishReason, setPublishReason] = useState('');
  const [publishErrors, setPublishErrors] = useState<Record<string, string>>({});
  // VERSIONING. The builder edits the DRAFT; live is the last published definition.
  // `live*` snapshot what was published (for the unsaved-draft diff); a fresh new
  // campaign has no live baseline (so any edit reads as an unsaved draft).
  const [tab, setTab] = useState<'builder' | 'history'>('builder');
  const [liveDefinition, setLiveDefinition] = useState<CampaignDefinition | null>(null);
  const [liveTriggerSegmentId, setLiveTriggerSegmentId] = useState<string | null>(null);
  const [versions, setVersions] = useState<CampaignVersion[] | null>(null);
  const [publishOpen, setPublishOpen] = useState(false);

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

  // Load an existing campaign — GET /campaigns/:id round-trips the DSL → canvas.
  // `definition` is the DRAFT to edit (draft ?? live); `liveDefinition` is the last
  // published one (the diff baseline for the unsaved-draft indicator). Also carries
  // the workspace timezone + trigger_segment_id (draft trigger) for the editors.
  const openById = async (cid: string): Promise<void> => {
    const res = await api.get<{
      campaign: {
        id: string;
        name: string;
        status: string;
        definition: CampaignDefinition;
        liveDefinition: CampaignDefinition;
        hasDraft: boolean;
        trigger_segment_id: string | null;
      };
      timezone: string;
    }>(`/campaigns/${cid}`);
    setEditingId(res.campaign.id);
    setName(res.campaign.name);
    setStatus(res.campaign.status);
    setModel(parseDefinition(res.campaign.definition));
    setTriggerSegmentId(res.campaign.trigger_segment_id ?? null);
    setLiveDefinition(res.campaign.liveDefinition);
    // The server resolves trigger_segment_id to the DRAFT trigger when a draft
    // exists; the LIVE trigger equals it only when there's no unsaved draft. We use
    // the live trigger as the diff baseline — when no draft, draft == live.
    setLiveTriggerSegmentId(res.campaign.hasDraft ? null : (res.campaign.trigger_segment_id ?? null));
    setTimeZone(res.timezone || 'UTC');
    clearPublish();
    setError('');
  };

  // Refresh ONLY the version history (History tab). Workspace-scoped server-side.
  const reloadVersions = async (cid: string): Promise<void> => {
    const r = await api.get<{ versions: CampaignVersion[] }>(`/campaigns/${cid}/versions`);
    setVersions(r.versions);
  };

  // Insert a node — either on the chosen edge, or AFTER a condition's branch (the
  // merge (+)). Both flows go through the same palette + toast-on-refusal handling.
  const insert = (type: PaletteType): void => {
    if (mergeConditionId) {
      const condId = mergeConditionId;
      try {
        setModel((m) => insertAfterBranch(m, condId, type));
        setError('');
      } catch (e) {
        showToast(e instanceof Error ? e.message : String(e), { tone: 'error' });
      }
      setMergeConditionId(null);
      return;
    }
    if (!paletteEdge) return;
    try {
      setModel((m) => insertOnEdge(m, paletteEdge, type));
      setError('');
    } catch (e) {
      showToast(e instanceof Error ? e.message : String(e), { tone: 'error' });
    }
    setPaletteEdge(null);
  };

  // Open the palette to insert AFTER a condition's branch (the merge (+)).
  const startMergeInsert = (conditionId: string): void => {
    setPaletteEdge(null);
    setMergeConditionId(conditionId);
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

  // Persist the current model — to the DRAFT, never the live definition (live is
  // untouched until Publish). A BRAND-NEW campaign has no row yet, so the first
  // persist CREATES it via POST /campaigns (a fresh campaign's live == draft, so
  // there is no draft to split). Once a row exists, EVERY edit (node save / insert /
  // delete / move / duplicate / trigger-segment) writes the DRAFT via
  // PUT /campaigns/:id/draft — including its draft trigger segment. The server
  // validates the graph; an invalid graph throws (the caller surfaces it). Returns
  // the campaign id.
  const persist = async (overrideModel?: CanvasModel, overrideTriggerSeg?: string | null): Promise<string> => {
    const definition = buildDefinition(overrideModel ?? model);
    const triggerSeg = overrideTriggerSeg !== undefined ? overrideTriggerSeg : triggerSegmentId;
    if (editingId) {
      await api.put(`/campaigns/${editingId}/draft`, {
        body: { definition, ...(triggerSeg !== null ? { trigger_segment_id: triggerSeg } : {}) },
      });
      return editingId;
    }
    // First persist of a NEW campaign: create the row (definition is its initial
    // live + draft). Subsequent edits go to the draft via the branch above.
    const r = await api.post<{ campaign: { id: string } }>('/campaigns', {
      body: {
        name: name || 'Untitled campaign',
        definition,
        ...(triggerSeg !== null ? { trigger_segment_id: triggerSeg } : {}),
      },
    });
    setEditingId(r.campaign.id);
    // A freshly-created campaign's live == its definition (no unsaved draft yet).
    setLiveDefinition(definition);
    setLiveTriggerSegmentId(triggerSeg ?? null);
    return r.campaign.id;
  };

  // Save: persist the definition to the DRAFT; surface an invalid graph inline +
  // via toast. (Publishing is a separate, explicit action.)
  const save = async (): Promise<void> => {
    setError('');
    try {
      await persist();
      await reloadList();
      showToast('Draft saved', { tone: 'success' });
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

  // The trigger segment is part of the DRAFT — persist it (with the current model)
  // through the draft writer so live is untouched until publish.
  const saveTriggerSegment = async (segmentId: string | null): Promise<void> => {
    setTriggerSegmentId(segmentId);
    await persist(undefined, segmentId);
  };

  // PUBLISH the draft as a new VERSION (Draft → Live). Persist the draft first so
  // the gate sees the latest copy, then POST /publish {name, scope}. The gate runs
  // BEFORE any mutation: a 400 is a structural reason; a 409 carries {error, node?,
  // missing?} → render inline against the offending node. On success the draft is
  // promoted to live + cleared, status flips to active, and we reload.
  const publish = async (versionName: string, scope: PublishScope): Promise<void> => {
    clearPublish();
    setError('');
    let cid: string;
    try {
      cid = await persist();
    } catch (err) {
      const msg = (err as { error?: string })?.error ?? String(err);
      setPublishReason(msg);
      return;
    }
    try {
      const res = await api.post<{ version: number; name: string; enrolled: number }>(
        `/campaigns/${cid}/publish`,
        { body: { name: versionName, scope } },
      );
      setPublishOpen(false);
      // Reload the campaign so the draft is cleared (hasDraft → false) and live ==
      // the just-published definition; refresh the list + (if open) history.
      await openById(cid);
      await reloadList();
      if (tab === 'history') await reloadVersions(cid);
      const msg =
        scope === 'backfill' && res.enrolled > 0
          ? `Published v${res.version} · enrolled ${res.enrolled} existing profile${res.enrolled === 1 ? '' : 's'}`
          : `Published v${res.version}`;
      showToast(msg, { tone: 'success' });
    } catch (err) {
      const body = err as { error?: string; node?: string; missing?: string };
      const msg = body?.error ?? 'Could not publish this campaign.';
      setPublishReason(msg);
      if (body?.node) setPublishErrors({ [body.node]: msg });
    }
  };

  // Lifecycle (pause/resume) from the EDIT header — mirrors the list-row actions.
  // RETURNS its promise so the kit Button spins + locks until the response.
  const lifecycle = async (action: 'pause' | 'resume'): Promise<void> => {
    if (!editingId) return;
    try {
      await api.post(`/campaigns/${editingId}/${action}`, { body: {} });
      setStatus(action === 'pause' ? 'paused' : 'active');
      await reloadList();
      showToast(action === 'pause' ? 'Campaign paused.' : 'Campaign resumed.', { tone: 'success' });
    } catch (err) {
      showToast((err as { error?: string })?.error ?? `Could not ${action} the campaign.`, { tone: 'error' });
    }
  };

  // Revert a prior version INTO the draft (live untouched). Confirmed via the styled
  // dialog (never window.confirm). On success load the returned draft into the
  // builder model + switch back to the Builder tab.
  const revert = async (v: CampaignVersion): Promise<void> => {
    if (!editingId) return;
    const ok = await askConfirm({
      title: `Revert to v${v.version}?`,
      message: `“${v.name}” will be loaded into the draft. Your live campaign keeps running until you Save to publish.`,
      confirmLabel: 'Load into draft',
    });
    if (!ok) return;
    try {
      const res = await api.post<{ definition: CampaignDefinition; trigger_segment_id: string | null }>(
        `/campaigns/${editingId}/revert`,
        { body: { version_id: v.id } },
      );
      setModel(parseDefinition(res.definition));
      setTriggerSegmentId(res.trigger_segment_id ?? null);
      clearPublish();
      setError('');
      setTab('builder');
      showToast(`Loaded v${v.version} into the draft — Save to publish.`, { tone: 'success' });
    } catch (err) {
      showToast((err as { error?: string })?.error ?? 'Could not revert to that version.', { tone: 'error' });
    }
  };

  // Open the History tab — lazily fetch the version list.
  const openHistory = (): void => {
    setTab('history');
    if (editingId) void reloadVersions(editingId);
  };

  // Open the Save-version modal (clears any stale publish reason first).
  const openPublish = (): void => {
    clearPublish();
    setPublishOpen(true);
  };

  // The unsaved-draft indicator: a fresh new campaign (no live baseline) reads dirty
  // once it has been created; otherwise compare the local model to the published one.
  const isDirty = draftDiffersFrom(buildDefinition(model), liveDefinition, triggerSegmentId, liveTriggerSegmentId);
  const canBackfill = backfillAllowed(buildDefinition(model), triggerSegmentId);

  return (
    <section data-testid="campaign-builder">
      <button data-testid="campaigns-back" class="btn-ghost mb-4 btn-sm" onClick={() => navigate('/campaigns')}>
        ← Back to campaigns
      </button>

      <PageHeader
        title={editingId ? 'Edit campaign' : 'New campaign'}
        subtitle="Design a multi-step journey: it flows downward, branches fan sideways."
        actions={
          editingId ? (
            <div class="flex items-center gap-2">
              {status === 'active' ? (
                <Button data-testid="campaign-pause" variant="secondary" size="sm" onClick={() => lifecycle('pause')}>
                  Pause
                </Button>
              ) : null}
              {status === 'paused' ? (
                <Button data-testid="campaign-resume" variant="secondary" size="sm" onClick={() => lifecycle('resume')}>
                  Resume
                </Button>
              ) : null}
            </div>
          ) : undefined
        }
      />

      {/* Builder / History tabs — the canvas is the default. */}
      {editingId ? (
        <div role="tablist" class="mb-4 flex gap-1 border-b border-stone-200">
          {(
            [
              { key: 'builder', label: 'Builder', testId: 'campaign-tab-builder', onSelect: () => setTab('builder') },
              { key: 'history', label: 'History', testId: 'campaign-tab-history', onSelect: openHistory },
            ] as const
          ).map((t) => (
            <button
              key={t.key}
              type="button"
              role="tab"
              data-testid={t.testId}
              aria-selected={tab === t.key}
              onClick={t.onSelect}
              class={`-mb-px border-b-2 px-4 py-2 text-sm font-medium ${
                tab === t.key
                  ? 'border-brand-600 text-brand-700'
                  : 'border-transparent text-stone-500 hover:text-stone-700'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
      ) : null}

      {tab === 'builder' ? (
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
            <div class="flex items-center gap-2">
              {isDirty ? (
                <Badge data-testid="draft-indicator" tone="warn">
                  Unsaved draft — not yet published
                </Badge>
              ) : null}
              {editingId ? (
                <Badge data-testid="campaign-status" tone={toneFor(status)}>
                  {status}
                </Badge>
              ) : null}
            </div>
          </div>

          <span class="label mt-5">Workflow</span>
          <CampaignCanvas
            model={model}
            onInsert={(edge) => setPaletteEdge(edge)}
            onInsertAfterBranch={startMergeInsert}
            onDelete={remove}
            onOpen={(node) => void openEditor(node)}
            publishErrors={publishErrors}
            placement={placement}
            onStartPlacement={startPlacement}
            onPickTarget={(edge) => void pickTarget(edge)}
            onCancelPlacement={cancelPlacement}
          />

          <div class="mt-4 flex flex-wrap items-center gap-3">
            <Button data-testid="save-campaign" variant="secondary" onClick={save}>
              Save draft
            </Button>
            <Button data-testid="publish-version" onClick={openPublish}>
              Save &amp; publish
            </Button>
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
      ) : (
        <CampaignHistory versions={versions} onRevert={revert} />
      )}

      {/* The insert palette (a side drawer). Opens from a (+) edge control. */}
      <Drawer
        open={paletteEdge !== null || mergeConditionId !== null}
        onClose={() => {
          setPaletteEdge(null);
          setMergeConditionId(null);
        }}
        title={mergeConditionId ? 'Insert a step after the branch' : 'Insert a step'}
        subtitle={
          mergeConditionId
            ? 'Both arms will flow through this step before continuing.'
            : 'Pick a node type to add on this edge.'
        }
        testId="campaign-palette"
      >
        <div class="grid grid-cols-1 gap-2">
          {PALETTE.map((p) => {
            // After-the-branch merge inserts a single LINEAR step (it becomes the
            // new merge point) — a nested If or a terminal Exit can't be a merge step.
            const disabled = mergeConditionId !== null && (p.type === 'condition' || p.type === 'exit');
            return (
              <button
                key={p.type}
                type="button"
                data-testid={p.testId}
                disabled={disabled}
                onClick={() => insert(p.type)}
                class="flex flex-col items-start rounded-xl border border-stone-200 bg-white px-4 py-3 text-left transition-colors hover:border-brand-400 hover:bg-brand-50/40 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-stone-200 disabled:hover:bg-white"
              >
                <span class="text-sm font-semibold text-ink-900">{p.label}</span>
                <span class="text-xs text-stone-400">{p.hint}</span>
              </button>
            );
          })}
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
      {/* Save-version modal: a required name + forward/backfill scope. */}
      {publishOpen ? (
        <PublishVersionModal
          defaultName={name || 'Untitled campaign'}
          canBackfill={canBackfill}
          reason={publishReason}
          onPublish={publish}
          onClose={() => setPublishOpen(false)}
        />
      ) : null}

      {/* campaigns is loaded for freshness only; reference it so lint stays clean. */}
      <span hidden>{campaigns.length}</span>
    </section>
  );
}

// --- The Save-version modal (styled, NOT a native dialog) --------------------

function PublishVersionModal({
  defaultName,
  canBackfill,
  reason,
  onPublish,
  onClose,
}: {
  defaultName: string;
  canBackfill: boolean;
  reason: string;
  onPublish: (name: string, scope: PublishScope) => Promise<void>;
  onClose: () => void;
}): ReturnType<typeof createPortal> {
  const [versionName, setVersionName] = useState(defaultName);
  // Backfill is only offered for a segment_entry trigger with a segment; otherwise
  // forward-only. Default forward.
  const [scope, setScope] = useState<PublishScope>('forward');

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const trimmed = versionName.trim();
  const confirm = (): Promise<void> => onPublish(trimmed, canBackfill ? scope : 'forward');

  return createPortal(
    <div
      class="fixed inset-0 z-[200] flex items-center justify-center bg-black/45 p-6"
      onClick={onClose}
    >
      <div
        data-testid="publish-modal"
        class="w-full max-w-md rounded-2xl bg-white p-5 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 class="text-base font-bold text-ink-950">Save &amp; publish a version</h3>
        <p class="mt-1 text-sm text-stone-500">
          Name this version, then publish it. The live campaign updates immediately.
        </p>

        <Field label="Version name" class="mt-4">
          <Input
            data-testid="version-name"
            placeholder="e.g. Spring refresh"
            value={versionName}
            onInput={(e: Event) => setVersionName((e.target as HTMLInputElement).value)}
          />
        </Field>

        <div class="mt-4" data-testid="publish-scope">
          <span class="label">Who to enroll</span>
          {canBackfill ? (
            <div class="mt-1 space-y-2">
              <label class="flex items-start gap-2 text-sm">
                <input
                  type="radio"
                  name="publish-scope"
                  data-testid="publish-scope-forward"
                  checked={scope === 'forward'}
                  onChange={() => setScope('forward')}
                  class="mt-0.5"
                />
                <span>
                  <span class="font-medium text-ink-900">New entrants only</span>
                  <span class="block text-xs text-stone-500">Enroll people as they enter the segment from now on.</span>
                </span>
              </label>
              <label class="flex items-start gap-2 text-sm">
                <input
                  type="radio"
                  name="publish-scope"
                  data-testid="publish-scope-backfill"
                  checked={scope === 'backfill'}
                  onChange={() => setScope('backfill')}
                  class="mt-0.5"
                />
                <span>
                  <span class="font-medium text-ink-900">Backfill existing members</span>
                  <span class="block text-xs text-stone-500">Also enroll everyone currently in the segment.</span>
                </span>
              </label>
            </div>
          ) : (
            <p data-testid="publish-scope-hint" class="mt-1 text-xs text-stone-500">
              New entrants only. Backfill is available when the trigger is a segment with a segment selected.
            </p>
          )}
        </div>

        {reason ? (
          <p
            data-testid="publish-modal-reason"
            class="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800 ring-1 ring-inset ring-amber-200"
          >
            {reason}
          </p>
        ) : null}

        <div class="mt-5 flex justify-end gap-2">
          <button
            type="button"
            data-testid="publish-cancel"
            class="rounded-lg border border-stone-300 px-4 py-2 text-sm font-medium text-stone-600 hover:bg-stone-50"
            onClick={onClose}
          >
            Cancel
          </button>
          <Button data-testid="publish-confirm" disabled={!trimmed} onClick={confirm}>
            Publish
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

// --- The History tab (published versions, newest-first) ----------------------

function CampaignHistory({
  versions,
  onRevert,
}: {
  versions: CampaignVersion[] | null;
  onRevert: (v: CampaignVersion) => Promise<void>;
}): ReturnType<typeof Card> {
  return (
    <Card class="p-5" data-testid="campaign-history">
      <h3 class="text-sm font-semibold text-ink-900">Published versions</h3>
      <p class="mt-1 text-sm text-stone-500">
        Each publish is saved here. Revert loads a version into the draft — your live campaign keeps running until you Save to
        publish.
      </p>
      {versions === null ? (
        <p class="mt-4 text-sm text-stone-500">Loading…</p>
      ) : versions.length === 0 ? (
        <div class="mt-4">
          <EmptyState>No published versions yet — Save &amp; publish to create one.</EmptyState>
        </div>
      ) : (
        <ul class="mt-4 space-y-2">
          {versions.map((v) => (
            <li
              key={v.id}
              data-testid="version-row"
              class="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-4 rounded-xl border border-stone-200 bg-white px-4 py-3"
            >
              <span class="font-semibold tabular-nums text-ink-900">v{v.version}</span>
              <span class="min-w-0">
                <span class="block truncate font-medium text-ink-900">{v.name}</span>
                <span class="block text-xs text-stone-400">{whenLabel(v.created_at)}</span>
              </span>
              <span class="flex items-center gap-2">
                {v.is_active ? (
                  <Badge data-testid="version-active" tone="success">
                    Active
                  </Badge>
                ) : null}
                <Button data-testid="version-revert" variant="secondary" size="sm" onClick={() => onRevert(v)}>
                  Revert
                </Button>
              </span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
