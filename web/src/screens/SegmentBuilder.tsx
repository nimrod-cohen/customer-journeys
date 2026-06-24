// SegmentBuilder (§12): dynamic rule-AST builder + manual hand-pick/CSV, with a
// LIVE size preview. The AST is assembled by the pure ast-builder and previewed
// via POST /segments/preview (scoped to the active workspace server-side). Manual
// members are added by CSV emails via /segments/:id/import-csv. (Visual redesign;
// all data-testid attributes preserved.)
import { useEffect, useRef, useState } from 'preact/hooks';
import { api } from '../store/session.js';
import { navigate, setNavGuard } from '../router.js';
import { askConfirm } from '../ui/dialog.js';
import {
  buildAstFromGroup,
  groupFromAst,
  emptyRow,
  type AstNode,
  type RuleRow,
  type RuleGroup,
  type Combinator,
} from '../segments/ast-builder.js';
import { RuleBuilder } from '../segments/RuleBuilder.js';
import { Button, Card, Field, Input, PageHeader, Select, Textarea } from '../ui/kit.js';

/**
 * SegmentBuilder is the DESIGNATED create/edit screen. With no `id` it creates a
 * new segment (/segments/new); with an `id` it loads that segment and edits it
 * (/segments/:id). Saving routes back to the list, which re-fetches → reactive.
 * The rule-group editor itself is the shared RuleBuilder (also mounted by the
 * campaign IF/condition node editor) — ONE rule-AST UI, ONE emitted §8 AstNode.
 */
export function SegmentBuilder({ id }: { id?: string }) {
  const editing = Boolean(id);
  // The root group: its own combinator + rules, plus optional sub-groups (2-level
  // hierarchy). Root rules and sub-groups are combined by `combinator`.
  const [rows, setRows] = useState<RuleRow[]>([emptyRow()]);
  const [combinator, setCombinator] = useState<Combinator>('and');
  const [groups, setGroups] = useState<RuleGroup[]>([]);
  const [size, setSize] = useState<number | null>(null);
  // Live members preview (dynamic segments): one page of 50 at `offset`.
  const [members, setMembers] = useState<Array<{ id: string; email: string | null }>>([]);
  const [offset, setOffset] = useState(0);
  // The members panel reflects the SAVED segment — it refreshes on entry and on
  // save, NOT on every edit. `memVersion` bumps to trigger a (re)load; `dirty`
  // marks unsaved rule edits so we can flag the list as stale.
  const [memVersion, setMemVersion] = useState(0);
  const [dirty, setDirty] = useState(false);
  // A compile/preview error from the server (e.g. an unrecognized rule field) —
  // surfaced in the members panel instead of silently showing 0 members.
  const [previewError, setPreviewError] = useState('');
  const PAGE = 50;
  const [name, setName] = useState('');
  // A segment is EITHER dynamic (rule-based) OR manual (uploaded list) — never
  // both. Chosen on create; fixed thereafter.
  const [segmentKind, setSegmentKind] = useState<'dynamic_realtime' | 'manual'>('dynamic_realtime');
  const [savedId, setSavedId] = useState<string | null>(id ?? null);
  const [saving, setSaving] = useState(false);
  const [csv, setCsv] = useState('');

  // Edit mode: load the existing segment, set its type, and hydrate the editor.
  useEffect(() => {
    if (!id) return;
    void api
      .get<{ segment: { name: string; kind: string; definition: AstNode | null } }>(`/segments/${id}`)
      .then((res) => {
        setName(res.segment.name);
        setSegmentKind(res.segment.kind === 'manual' ? 'manual' : 'dynamic_realtime');
        const g = groupFromAst(res.segment.definition);
        setRows(g.rows);
        setCombinator(g.combinator);
        setGroups(g.groups);
        setMemVersion((v) => v + 1); // load the saved segment's members on entry
      })
      .catch(() => navigate('/segments'));
  }, [id]);

  // The whole audience as one root group (root rules + sub-groups).
  const rootGroup = (): RuleGroup => ({ combinator, rows, groups });

  // Load one page (50) of the matching members + the total count.
  // Load one page (50) of members + the total count. Dynamic → live rule preview;
  // manual → the segment's CURRENT materialized members (once it exists).
  const loadMembers = async (off: number) => {
    setPreviewError('');
    try {
      if (segmentKind === 'manual') {
        if (!savedId) {
          setSize(0);
          setMembers([]);
          setOffset(0);
          setDirty(false);
          return;
        }
        const res = await api.get<{ size: number; members: Array<{ id: string; email: string | null }> }>(
          `/segments/${savedId}/members?offset=${off}`,
        );
        setSize(res.size);
        setMembers(res.members);
        setOffset(off);
        setDirty(false);
        return;
      }
      const ast = buildAstFromGroup({ combinator, rows, groups });
      // No rules → an inactive DRAFT. Don't preview (a null AST would match everyone).
      if (ast === null) {
        setSize(0);
        setMembers([]);
        setOffset(0);
        setDirty(false);
        return;
      }
      const res = await api.post<{ size: number; members: Array<{ id: string; email: string | null }> }>(
        '/segments/preview',
        { body: { definition: ast, offset: off } },
      );
      setSize(res.size);
      setMembers(res.members);
      setOffset(off);
      setDirty(false);
    } catch (e) {
      // A compile error (e.g. an unrecognized field) — surface it rather than
      // silently showing an empty list.
      setPreviewError((e as { error?: string })?.error ?? 'Could not evaluate this segment’s rules.');
      setSize(null);
      setMembers([]);
      setDirty(false);
    }
  };

  // Refresh the members panel ONLY on entry (after hydrate) and after a save —
  // never on every keystroke. `memVersion` is bumped in those two places.
  useEffect(() => {
    if (memVersion === 0) return; // nothing to show until the segment exists / is saved
    void loadMembers(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [memVersion]);

  // Editing the rules/name marks the editor dirty (members list stale until the
  // next save, and gates leaving the screen). Skip the initial mount run so an
  // untouched segment — or the post-hydrate state restore in edit mode — isn't
  // falsely flagged; only genuine edits set it.
  const seededDirty = useRef(false);
  useEffect(() => {
    if (!seededDirty.current) {
      seededDirty.current = true;
      return;
    }
    setDirty(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, combinator, groups, csv, name]);

  // Block leaving the screen with unsaved changes. `dirtyRef` mirrors `dirty` so
  // the guard/beforeunload closures aren't stale. The nav guard (in-app links,
  // back button, browser back/forward) asks for confirmation; beforeunload covers
  // refresh/tab-close (native browser prompt — can't be styled).
  const dirtyRef = useRef(false);
  useEffect(() => {
    dirtyRef.current = dirty;
  }, [dirty]);

  useEffect(() => {
    setNavGuard(async () =>
      dirtyRef.current
        ? askConfirm({
            title: 'Discard changes?',
            message: 'You have unsaved changes to this segment. Leave without saving?',
            danger: true,
            confirmLabel: 'Discard',
          })
        : true,
    );
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (dirtyRef.current) {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    globalThis.addEventListener?.('beforeunload', onBeforeUnload);
    return () => {
      setNavGuard(null);
      globalThis.removeEventListener?.('beforeunload', onBeforeUnload);
    };
  }, []);

  const save = async () => {
    setSaving(true);
    try {
      // A successful save clears the unsaved-changes flag synchronously — the
      // members panel reloads (loadMembers) asynchronously, but the leave-guard
      // must release the moment the save lands, not after the preview fetch.
      const segName = name || 'Untitled segment';
      if (segmentKind === 'manual') {
        // Manual: create (or update) the segment, then import the pasted emails.
        const emails = csv
          .split(/[\n,]/)
          .map((s) => s.trim())
          .filter(Boolean);
        let sid = savedId;
        if (sid) {
          await api.put(`/segments/${sid}`, { body: { name: segName } });
        } else {
          const res = await api.post<{ segment: { id: string } }>('/segments', {
            body: { name: segName, kind: 'manual', definition: null },
          });
          sid = res.segment.id;
          setSavedId(sid);
        }
        if (sid && emails.length) {
          await api.post(`/segments/${sid}/import-csv`, { body: { emails } });
          setCsv(''); // imported — clear the box (members panel now reflects them)
        }
        setDirty(false);
        setMemVersion((v) => v + 1); // refresh the members panel in place
        return;
      }
      // Dynamic: compile the rule group into the §8 AST.
      const ast = buildAstFromGroup(rootGroup());
      if (savedId) {
        await api.put(`/segments/${savedId}`, { body: { name: segName, definition: ast } });
      } else {
        const res = await api.post<{ segment: { id: string } }>('/segments', {
          body: { name: segName, kind: 'dynamic_realtime', definition: ast },
        });
        setSavedId(res.segment.id);
      }
      setDirty(false);
      setMemVersion((v) => v + 1); // refresh the members panel in place
    } finally {
      setSaving(false);
    }
  };

  // A dynamic segment with no rules is an inactive draft (matches no one until a
  // rule is added).
  const isDraft = segmentKind === 'dynamic_realtime' && buildAstFromGroup({ combinator, rows, groups }) === null;

  return (
    <section data-testid="segment-builder">
      <PageHeader
        title={editing ? 'Edit segment' : 'New segment'}
        subtitle="Build a dynamic rule-based audience or curate a manual list."
        back={
          <button
            data-testid="segments-back"
            class="btn-ghost btn-sm whitespace-nowrap"
            onClick={() => navigate('/segments')}
          >
            ← Back to segments
          </button>
        }
      />

      <div class="flex flex-col gap-6 lg:flex-row lg:items-start">
        {/* LEFT: the builder */}
        <div class="min-w-0 flex-1">
          <Card class="p-5">
            <div class="flex flex-wrap items-end gap-3">
              <Field label="Segment name" class="min-w-[16rem] flex-1">
                <Input
                  data-testid="segment-name"
                  placeholder="e.g. High-value (30d)"
                  value={name}
                  onInput={(e: Event) => setName((e.target as HTMLInputElement).value)}
                />
              </Field>
              <Field label="Type">
                {editing ? (
                  <span data-testid="segment-type" class="inline-block py-2 text-sm font-medium capitalize text-stone-700">
                    {segmentKind === 'manual' ? 'Manual (uploaded list)' : 'Dynamic (rule-based)'}
                  </span>
                ) : (
                  <Select
                    data-testid="segment-type"
                    value={segmentKind}
                    onChange={(e: Event) =>
                      setSegmentKind((e.target as HTMLSelectElement).value as 'dynamic_realtime' | 'manual')
                    }
                  >
                    <option value="dynamic_realtime">Dynamic (rule-based)</option>
                    <option value="manual">Manual (uploaded list)</option>
                  </Select>
                )}
              </Field>
            </div>

            {segmentKind === 'dynamic_realtime' ? (
            <div class="mt-5 space-y-3">
              <span class="label">Rules</span>
              <RuleBuilder
                group={rootGroup()}
                onChange={(g) => {
                  setCombinator(g.combinator);
                  setRows(g.rows);
                  setGroups(g.groups);
                }}
              />
            </div>
            ) : (
              /* Manual: a hand-curated list uploaded as CSV. */
              <div class="mt-5 space-y-3">
                <span class="label">Add members (CSV)</span>
                <p class="text-sm text-stone-500">
                  Paste comma- or newline-separated emails. Matching profiles in this workspace
                  become members; saving creates the segment and imports them.
                </p>
                <Textarea
                  data-testid="csv-input"
                  value={csv}
                  onInput={(e: Event) => setCsv((e.target as HTMLTextAreaElement).value)}
                  placeholder="alice@acme.com, bob@acme.com"
                  class="font-mono text-xs"
                />
              </div>
            )}

            <div class="mt-5 flex items-center gap-3 border-t border-stone-100 pt-4">
              <Button data-testid="save-segment" onClick={save} disabled={saving}>
                {saving
                  ? 'Saving…'
                  : editing
                    ? isDraft
                      ? 'Save draft'
                      : 'Save changes'
                    : isDraft
                      ? 'Save draft'
                      : segmentKind === 'manual'
                        ? 'Create segment'
                        : 'Save segment'}
              </Button>
            </div>
          </Card>
        </div>

        {/* RIGHT: live members (both types) */}
        <div class="w-full lg:w-80 lg:shrink-0">
          <Card data-testid="members-panel" class="p-5 lg:sticky lg:top-4">
            <div class="flex items-center justify-between">
              <span class="label">Members</span>
              <span data-testid="segment-size" class="text-sm font-medium text-stone-600">
                {isDraft
                  ? 'Draft'
                  : size === null
                    ? '—'
                    : segmentKind === 'manual'
                      ? `${size} member${size === 1 ? '' : 's'}`
                      : `${size} matching`}
              </span>
            </div>
            {previewError ? (
              <p
                data-testid="segment-preview-error"
                class="mt-2 rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700 ring-1 ring-inset ring-rose-200"
              >
                {previewError}
              </p>
            ) : isDraft ? (
              <p data-testid="segment-draft-note" class="mt-2 text-sm text-amber-600">
                No rules yet — this segment is an inactive <b>draft</b> and matches no one until you add a rule.
              </p>
            ) : size === null ? (
              <p class="mt-2 text-sm text-stone-400">The member list refreshes when you save.</p>
            ) : (
              <>
                {dirty ? (
                  <p data-testid="members-stale" class="mt-2 text-xs text-amber-600">
                    Unsaved edits — save to refresh this list.
                  </p>
                ) : null}
                {members.length === 0 ? (
                  <p class="mt-2 text-sm text-stone-400">
                    {segmentKind === 'manual' ? 'No members yet — paste emails and save.' : 'No matching profiles.'}
                  </p>
                ) : (
                  <>
                    <ul class="mt-3 divide-y divide-stone-100 overflow-hidden rounded-lg border border-stone-200">
                      {members.map((m) => (
                        <li
                          data-testid="member-preview-row"
                          key={m.id}
                          class="truncate px-3 py-1.5 text-sm text-ink-800"
                          title={m.email ?? m.id}
                        >
                          {m.email ?? m.id}
                        </li>
                      ))}
                    </ul>
                    {size > PAGE ? (
                      <div class="mt-2 flex items-center justify-between gap-2 text-sm text-stone-500">
                        <Button
                          data-testid="members-prev"
                          variant="ghost"
                          size="sm"
                          disabled={offset === 0}
                          onClick={() => loadMembers(Math.max(0, offset - PAGE))}
                        >
                          ← Prev
                        </Button>
                        <span data-testid="members-range" class="text-xs">
                          {offset + 1}–{Math.min(offset + PAGE, size)} of {size}
                        </span>
                        <Button
                          data-testid="members-next"
                          variant="ghost"
                          size="sm"
                          disabled={offset + PAGE >= size}
                          onClick={() => loadMembers(offset + PAGE)}
                        >
                          Next →
                        </Button>
                      </div>
                    ) : null}
                  </>
                )}
              </>
            )}
          </Card>
        </div>
      </div>
    </section>
  );
}
