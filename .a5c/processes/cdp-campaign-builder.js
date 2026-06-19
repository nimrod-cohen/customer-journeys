/**
 * @process cdp/campaign-builder
 * @description Build the proper visual CAMPAIGN BUILDER (§9B) on top of the
 *   existing mature campaign-runner. A campaign starts with a TRIGGER definition
 *   (segment-entry / event / manual) and flows DOWN through wait, wait-until,
 *   hour-of-day window, if/branch, send-email and call-webhook steps to an exit.
 *   The builder is a CONSTRAINED DOWNWARD CANVAS: auto-laid-out tree, rounded
 *   orthogonal connectors, branches fan to the sides, NO loops / back-edges /
 *   orphans — a rendering of the existing DSL graph (no new graph model). Two new
 *   backend node capabilities: hour_of_day_window (parks until the next allowed
 *   hour in the WORKSPACE timezone) and a webhook action (outbound HTTP w/ domain
 *   allowlist + timeout + bounded retries). Workspace timezone governs all time
 *   math. Test-first (§16A), per-phase adversarial quality gate. LOCAL-only:
 *   AWS/SES mocked + LocalStack; REAL Postgres on localhost:5433 for integration
 *   (never mocked); Playwright (real browser) for UI phases. Ends with a full
 *   end-to-end journey acceptance pass.
 *
 * @inputs { targetQuality?: number, maxIterations?: number }
 * @outputs { success: boolean, phases: array, integration: object }
 */

import { defineTask } from '@a5c-ai/babysitter-sdk';

// The LIVING source of truth is CLAUDE.md (it overrides the spec where they
// disagree); CDP-BUILD-SPEC.md §9B/§8/§9 is the original design reference.
const DOCS = 'CLAUDE.md (living source of truth — overrides the spec on conflict) + CDP-BUILD-SPEC.md §9B (campaign workflow engine), §8 (rule-AST→SQL compiler, reused for branch conditions), §9 (outbox→Dispatcher pipeline)';
const AGENT = 'general-purpose';

const INVARIANTS = [
  'Tenant isolation: every tenant-scoped row carries workspace_id NOT NULL and every query filters by workspace_id. The campaign-runner + enrollment + handlers connect with the Supabase SERVICE ROLE which BYPASSES RLS — they MUST scope by workspace_id IN CODE (RLS is not their safety net). workspace_id is loaded FROM the enrollment/campaign row, never assumed.',
  'workspace_id is NEVER client-supplied — it comes from the authorizer-injected claim (admin API) or a trusted server-set field (the enrollment row). Never trust a workspace_id in a request body. Reject a cross-workspace template_id / segment_id / sender_id (inv.2) — like validateSenderId does today.',
  'All campaign action SENDS go through the SAME outbox → Dispatcher pipeline as broadcasts (§9): suppression → frequency-cap → quiet-hours, gated on a VERIFIED sending domain. A send node carries an email INSTANCE whose envelope (real named From sender + To + Subject) is ALL mandatory — NO no-reply fallback (mirror sendBroadcast gating). The Dispatcher renders merge tags in the SUBJECT, To AND body.',
  'Runner idempotency + concurrency (unchanged guarantee): one tick advances a due enrollment exactly once (SELECT … FOR UPDATE row lock in one tx, re-check active inside the lock; legacy CAS path for unit tests). Outbox dedupe_key per (campaign_id, profile_id, node_id) prevents double-sends on retry. MAX_STEPS_PER_TICK guards pathological graphs. New node execution must preserve all of this.',
  'Webhook action safety: outbound HTTP ONLY to an explicit per-workspace domain ALLOWLIST; enforce a timeout + BOUNDED retries; block SSRF (no internal/link-local/loopback/169.254 metadata targets); secrets (e.g. auth headers) use the @cdp/db secret-crypto envelope pattern, never returned in plaintext over the API; a webhook failure is ISOLATED (recorded; never crashes the tick or double-advances). LOCAL: the HTTP call is mocked/injected — never hit a real external host in tests.',
  'Workspace timezone governs ALL campaign time math (waits, wait-until, hour-of-day window) — DST-correct (reuse the zoned↔UTC approach from the broadcast scheduler: zonedInputToUtcIso/tzOffsetMs). One configurable timezone per workspace; never per-broadcast guesswork.',
  'The DSL ({startNode, nodes}) is the SINGLE graph model; validateCampaignDefinition is the structural gate (exactly ONE trigger, every edge resolves, a reachable exit, and — extended — NO cycles / NO orphan nodes / down-only). The builder is an AUTO-LAYOUT RENDER of that graph: compute (x,y) from the tree, draw rounded orthogonal connectors, branches fan sideways. NO separate graph model, NO stored coordinates, NO loops/back-edges.',
  'REUSE, do not reinvent (code-quality bar): the broadcast email-INSTANCE/clone flow (kind=copy, source_template_id, cloneTemplate, the From/To/Subject envelope + editor return flow) for send nodes; the segment rule builder + AstNode for the if/condition node; the kit ActionMenu / Drawer / Button (auto-locks on promise-returning onClick) / Field / Select; the Dispatcher core; scopedQuery; runInWorkspaceTx; evaluateRealtimeSegmentsForProfile. Match the surrounding code style, comment density and naming.',
  'UI standing rules: NEVER use native confirm/alert/prompt — use ui/dialog.tsx (askConfirm) or purpose-built modals. EVERY server-calling button shows a spinner + locks until the response (kit Button auto-locks when onClick RETURNS the promise — wire it that way). The email editor autosaves (no manual save). PRESERVE every existing data-testid; add stable testids for new UI. Floating toasts (ui/toast.tsx showToast) for transient feedback.',
  'Test-first (§16A/§18): write the failing acceptance tests FIRST, then implement to green. Do NOT mock Postgres in the integration tier — use the REAL local DB. Mock SES/AWS (aws-sdk-client-mock / LocalStack); the webhook HTTP client is injected/mocked. Playwright (real browser) for UI phases with seeded data + stable selectors. turbo test task is cache:false — keep it. Unique workspace UUIDs + file-local namespaces (events.event_id / ses_message_id are GLOBAL keys).',
  'Process hygiene: BUMP the root package.json version per change (patch=tiny, minor=feature, major only when told). UPDATE CLAUDE.md when behavior/architecture changes. Apply new SQL migrations to BOTH the dev DB (cdp) AND the e2e DB (cdp_e2e) via a node pg script (psql is unavailable). RESTART the dev API (pnpm --filter @cdp/service-local-api dev:api — a long-lived tsx process, NOT watch) after backend edits, and REBUILD a changed package (tsc -b) the local-api imports from dist. Scope discipline: build EXACTLY the agreed design — no extra features.',
];

const ENV = [
  'Monorepo: pnpm workspaces + Turborepo + Vitest + strict TS. Run from repo root. Node 20+.',
  'Real Postgres (dev): DATABASE_URL=postgres://postgres:postgres@localhost:5433/cdp (migrations applied). Single test file: pnpm --filter <pkg> exec vitest run path. Whole suite: DATABASE_URL=… pnpm test. Typecheck: pnpm typecheck. Lint: pnpm lint.',
  'Browser e2e: pnpm --filter @cdp/web test:e2e — its OWN DB cdp_e2e on its OWN ports (local-api :8788, web :5174), runs with LOCAL_SES_FORCE_MOCK=1 LOCAL_SES_DKIM_STATUS=SUCCESS; re-seeds web/e2e/seed.ts each run. The dev stack (cdp, :8787/:5173) coexists. Playwright config has retries:1.',
  'Dev API for manual checks: pnpm --filter @cdp/service-local-api dev:api (background, restart after backend edits). Health: GET http://localhost:8787/health.',
  'Key reuse points: services/campaign-runner (dsl.ts, core.ts, run.ts, enroll.ts), services/local-api (handlers.ts, routes.ts, app.ts, server.ts), services/dispatcher (core.ts, dispatch.ts), packages/segments (AST + compiler + rule builder), packages/email, web/src/screens (BroadcastComposer email-instance flow, TemplateEditor, SegmentBuilder), web/src/ui/kit.tsx (ActionMenu, Drawer, Button, Field, Select), web/e2e/seed.ts.',
];

const PHASES = [
  {
    id: 'phase1-model-tz', frontend: false,
    title: 'Workspace timezone + DSL extensions (hour-window, webhook)',
    refs: '§9B + CLAUDE.md (campaigns DSL, workspace settings, broadcast scheduler tz math)',
    scope: [
      'Add a WORKSPACE TIMEZONE setting: persist on workspaces.settings.timezone (or a column) with a sane default (UTC); read/write via the existing workspace settings API (PUT /workspace/settings) + a small picker in WorkspaceSettings.tsx (full IANA list via Intl.supportedValuesOf, like the broadcast schedule tz). This is the clock for all campaign time math.',
      'Extend the campaign DSL (services/campaign-runner/src/dsl.ts) with TWO new node kinds, PURE + structurally validated: (a) an hour_of_day_window node — config: allowed hour range (startHour..endHour, 0–23) + optional allowed days-of-week; advances when already inside the window, else parks until the next window opening (computed later in the runner). (b) a webhook ACTION kind on the action node — config: url, method, headers (incl. an optional secret-backed auth header), bodyTemplate (merge-aware), timeoutMs, maxRetries; next edge after the call.',
      'Extend validateCampaignDefinition for the new nodes (required fields + edges) AND tighten it to the builder invariants: reject CYCLES (back-edges) and ORPHAN nodes (every node reachable from startNode), in addition to the existing one-trigger / reachable-exit checks. Keep it pure + exhaustively unit-tested.',
    ],
    criteria: [
      'Workspace timezone is persisted + read back via the settings API (workspace-scoped, owner-gated like other settings); an invalid IANA zone is rejected.',
      'validateCampaignDefinition accepts a well-formed graph using the new hour_of_day_window + webhook nodes, and REJECTS: a missing/invalid window range, a webhook missing url/method, a cycle/back-edge, an orphan node, more than one trigger, an unreachable exit. All covered by passing unit tests.',
      'The DSL types are exported + documented; no runner/execution change yet (that is phase 2). Typecheck + lint clean; no regression in existing campaign-runner unit tests.',
    ],
  },
  {
    id: 'phase2-runner-nodes', frontend: false,
    title: 'Runner: execute hour-of-day window + webhook (tz-aware)',
    refs: '§9B (per-enrollment state machine, next_run_at) + the new DSL nodes + the dispatcher webhook-free precedent',
    scope: [
      'Make wait / wait-until / hour_of_day_window tz-aware using the WORKSPACE timezone: compute the next due instant DST-correctly (reuse/extract the zoned↔UTC helper from the broadcast scheduler into a shared spot). hour_of_day_window: if now (in ws tz) is inside the allowed window/day → advance immediately; else PARK with next_run_at = the next window opening (ws tz → UTC).',
      'Execute the webhook action in the runner tick: call the injected HTTP client to the configured url/method/headers/body (merge-rendered) with the timeout; on a non-2xx or error, retry up to maxRetries (bounded), then either continue (record failure) or park-as-failed per a documented policy; record the outcome (status, attempt count) on the enrollment state / an activity_log row. ENFORCE the domain allowlist + SSRF guard BEFORE calling. The HTTP client is injected (mocked in tests) — never hit a real host.',
      'Preserve the single-winner concurrency guarantee (FOR UPDATE / CAS), the per-(campaign,profile,node) outbox dedupe for sends, and MAX_STEPS_PER_TICK. The webhook call must not break the one-tx tick model (decide + document: call inside vs after the tx; keep idempotency on retry).',
    ],
    criteria: [
      'An enrollment parked on an hour_of_day_window resumes at the correct next-window instant in the WORKSPACE timezone (DST-correct); inside the window it advances immediately. Verified by unit + real-Postgres integration tests with an injected clock.',
      'A webhook action calls the injected HTTP client with the right url/method/headers/rendered-body, honors timeout + bounded retries, records the outcome, and ISOLATES failure (no tick crash, no double-advance). A disallowed/SSRF target is refused WITHOUT a call. No real external host is hit.',
      'Idempotency/concurrency preserved: a retried/concurrent tick does not double-advance, double-send, or double-fire the webhook (dedupe/guard verified). Integration tier uses REAL Postgres; AWS mocked.',
    ],
  },
  {
    id: 'phase3-triggers-enrollment', frontend: false,
    title: 'Triggers & enrollment: segment-entry + event + manual',
    refs: '§9B (enrollment), CLAUDE.md (segment_change_log → enrollFromSegmentChange; ingest/processor), the re-enrollment policy',
    scope: [
      'Persist + validate the TRIGGER definition for all three kinds: segment_entry (campaigns.trigger_segment_id, already wired via enrollFromSegmentChange), event (event type + optional payload filter — store in the trigger node/definition), manual (no auto-source).',
      'EVENT-trigger enrollment: wire processor-time enrollment — when an event of the configured type (matching the optional filter) is ingested for a profile, enroll into the matching active campaigns (insert campaign_enrollments at the start node, UNIQUE(campaign_id, profile_id), ON CONFLICT DO NOTHING, workspace-scoped). Idempotent (a replayed event enrolls at most once).',
      'MANUAL/API enrollment: a workspace-scoped endpoint (e.g. POST /campaigns/:id/enroll) to enroll a single profile or a segment snapshot; capability-gated (manage_content); rejects cross-workspace ids (inv.2). Define + enforce the re-enrollment policy (once vs re-enter) consistently across all three kinds.',
    ],
    criteria: [
      'Segment-entry enrollment still works (no regression). Event ingestion of the configured type enrolls the profile into the active campaign exactly once (idempotent on replay); a non-matching event/filter does NOT enroll.',
      'The manual/API enroll endpoint enrolls a profile (and a segment snapshot) at the start node, is capability-gated + workspace-scoped, and refuses a cross-workspace campaign/profile/segment id (404/inv.2).',
      'The re-enrollment policy is documented + enforced for all three trigger kinds. All verified against REAL Postgres; everything workspace-scoped.',
    ],
  },
  {
    id: 'phase4-action-nodes', frontend: false,
    title: 'Action nodes: send-email instance + update-profile (event-sourced)',
    refs: 'CLAUDE.md (broadcast email-INSTANCE/clone model, sendBroadcast gating, dispatcher campaign path, customer.* merge) + §9B action(send|set_attribute)',
    scope: [
      'Give each SEND node its OWN editable email instance, reusing the broadcast flow: attaching a template CLONES it (kind=copy, source_template_id) into the node\'s working copy; the envelope (real named From sender + To token + Subject) lives on that copy and is edited in the email editor (autosaved). The send node references the copy template_id.',
      'PUBLISH-time gating: a campaign cannot be activated if any send node lacks a sendable email (From sender + To + Subject all set) — mirror sendBroadcast\'s ordered 409s + the verified-domain gate. Surface which node/what is missing.',
      'Verify the Dispatcher campaign path end-to-end: campaign outbox row → Dispatcher resolves sender_id → renders subject/To/body merge tags (the v0.27.2 subject fix) → messages_log with campaign_id. No change to the send pipeline beyond what the instance model needs.',
      'UPDATE-PROFILE action (the set_attribute action kind already exists + the runner already applies a STATIC value via buildSetAttribute): extend it so the value can be a LITERAL **or** an EXPRESSION sourced from the trigger event or the profile — e.g. customer.* and a new event.* namespace ({{event.<payload path>}}). To enable event.*, PERSIST the trigger event payload onto campaign_enrollments.state at enrollment time (event-trigger enrollment from phase 3) so a later update-profile step can read it; resolve the expression at execution against the profile + enrollment.state.event (reuse the @cdp/shared customer.* resolver; add an analogous event.* resolver). A missing/again-undefined path resolves safely (no crash; documented — skip or empty).',
      'Extend validateCampaignDefinition for the set_attribute value spec (literal vs expression) and keep it pure + unit-tested. The runner write stays workspace-scoped + idempotent (re-applying the same set_attribute on a retried tick is naturally idempotent for a literal; for an event-sourced value it resolves from the persisted enrollment.state, so a retry yields the same write).',
    ],
    criteria: [
      'A send node clones its template into an independently-editable copy (kind=copy); editing the copy does not touch the library original; the envelope persists on the copy. Cross-workspace template/sender ids are refused (inv.2).',
      'Activating a campaign with a send node missing From/To/Subject is refused with a clear, node-specific message; once all are set (real named sender, no no-reply fallback) + a verified domain exists, it activates. Verified against REAL Postgres.',
      'A campaign send flows through outbox → Dispatcher → messages_log(campaign_id) with subject/To/body merge tags rendered; passes suppression/cap/quiet-hours. AWS/SES mocked.',
      'An update-profile (set_attribute) step writes the profile attribute with a LITERAL value AND with an event-sourced value (e.g. attributes.last_purchase_amount = {{event.amount}} taken from the trigger event persisted on enrollment.state); the write is workspace-scoped + idempotent on retry; an undefined path resolves safely. Verified against REAL Postgres with unit tests for the value resolver.',
    ],
  },
  {
    id: 'phase5-builder-canvas', frontend: true,
    title: 'Builder: constrained downward canvas (auto-layout + connectors)',
    refs: 'CLAUDE.md (UI kit, BroadcastComposer/SegmentBuilder patterns, data-testid e2e contract) + the locked canvas design',
    scope: [
      'Replace the placeholder CampaignBuilder.tsx with a constrained DOWNWARD CANVAS that RENDERS a CampaignDefinition: auto-layout (each node below its parent; condition/multi-way branches fan to the SIDES and re-pack to avoid overlap; positions COMPUTED, not stored), rounded ORTHOGONAL connectors (no diagonals, no up/back arrows), pan/scroll. A node shows its type + summary; an insertion control (+) on each edge inserts a step; nodes are deletable (re-linking the graph so it stays a valid down-only tree with no orphans).',
      'Maintain the no-loop / no-orphan / single-trigger invariants in the editor (you can never create a back-edge or an unconnected node); build/parse between the canvas model and the DSL {startNode, nodes}; save via POST/PUT /campaigns (definition) — reject an invalid graph (validateCampaignDefinition) with a clear message.',
      'Node-type palette for inserting: wait, wait-until, hour-of-day window, if/branch, send-email, update-profile (set_attribute), webhook, exit (editors come in phase 6 — here, inserting creates a node with sensible defaults / a stub config). Keep it on the workspace design system; stable data-testid on every interactive element.',
    ],
    criteria: [
      'The builder renders an existing definition as a downward tree with branches fanning sideways + rounded orthogonal connectors; no diagonal/upward lines; layout is auto-computed (no manual drag). Verified in a REAL browser (Playwright).',
      'A user can assemble trigger → wait → send → exit AND an if-branch (yes/no each ending in a send→exit), save it, reload, and get the same graph back (round-trips through the DSL). Saving an invalid graph is refused.',
      'The editor cannot create a loop, a back-edge, or an orphan node; deleting a node re-links to a valid tree. Workspace-scoped; data-testid contract preserved + extended.',
    ],
  },
  {
    id: 'phase6-node-editors', frontend: true,
    title: 'Builder: per-node editors + publish validation',
    refs: 'CLAUDE.md (segment rule builder for if, broadcast email-instance flow for send, kit Drawer/Field) + the trigger design',
    scope: [
      'Inline/drawer editors for every node: TRIGGER (segment_entry → segment picker; event → event-type + optional filter; manual), WAIT (duration), WAIT-UNTIL (date/time in workspace tz), HOUR-OF-DAY WINDOW (hour range + days), IF (REUSE the segment rule builder → AstNode), SEND (the email-instance picker + "Design email" → editor, reusing the broadcast clone/return flow + envelope), UPDATE-PROFILE (attribute key picker + a value that is either a LITERAL or an expression — customer.* / event.* token, with a hint that event.* pulls from the trigger event), WEBHOOK (url/method/headers/body/timeout/retries; secret header write-only).',
      'PUBLISH flow: a Draft → Active transition that runs validateCampaignDefinition + the send-node envelope gating + trigger validity; surface inline what is missing and BLOCK publish until valid (buttons spinner+lock; no native dialogs).',
      'Wire the editors to save into the definition (autosave or explicit save consistent with the broadcast wizard); preserve the editor return-context for the send-node email (← Back to campaign).',
    ],
    criteria: [
      'Each node type opens a working editor that persists its config into the definition and round-trips; the IF editor reuses the segment rule builder and compiles to a valid AstNode; the SEND editor clones+edits a per-node email copy (envelope) reusing the broadcast flow.',
      'Publish is blocked (with specific, inline reasons) when the graph is invalid or a send node lacks From/To/Subject or the trigger is incomplete; it succeeds once everything is valid. Verified in a REAL browser per node type.',
      'All server-calling buttons spinner+lock; no native dialogs; data-testid on every control; workspace-scoped throughout.',
    ],
  },
  {
    id: 'phase6b-branch-convergence', frontend: true,
    title: 'Builder: converging branches (arms open and rejoin a single trunk)',
    refs: 'CLAUDE.md (the phase-5 canvas: layout.ts/orthogonal-path.ts/mutate.ts/CampaignCanvas.tsx) + the locked converging-diamond design',
    scope: [
      'Redesign the IF/branch (and any future multi-way branch) so its arms OPEN and REJOIN a single trunk (a converging diamond), NOT two separate exits. Inserting an If/branch on an edge A→B produces A→If with BOTH arms (onTrue/onFalse) leading to the continuation B; the trunk continues downward from that single join node. (Today insertBranch wires each arm to its own fresh exit — change it to rejoin.)',
      'Each arm gets its OWN + insertion control to add action nodes into THAT arm only (If.onTrue→New→join); an EMPTY arm passes straight through to the join (matches the user screenshot: one populated arm, one empty, both reunite). An explicit EXIT node dropped on an arm terminates just that arm (that side does not rejoin).',
      'Layout + connectors: the join node has 2+ incoming edges; draw the arms fanning to the SIDES and the connectors CONVERGING back into the single join, trunk continuing below — extend the existing Reingold-Tilford layout (a node with multiple parents laid out ONCE at max parent depth) and the orthogonal-path renderer (still rounded, axis-aligned, no diagonals, no up/back edges). Update mutate.ts (insertBranch rejoins; per-arm insert; delete re-links keeping a valid converging graph), CampaignCanvas.tsx (per-arm + controls + the convergence connectors). validateCampaignDefinition stays the gate (diamonds are already allowed — ensure no false cycle/orphan). The RUNNER is unchanged (it just follows current_node through the join).',
    ],
    criteria: [
      'Inserting an If/branch on an edge yields a converging diamond: both arms lead to the SAME continuation node and the trunk continues below it; rendered with arms fanning sideways and connectors converging into the single join (no diagonal/upward edges, auto-layout). Verified in a REAL browser (Playwright tokenizes the connector paths + asserts convergence into one node).',
      'Each arm has its own + ; adding a node to ONE arm while the other stays empty keeps the diamond and both sides rejoin the trunk (the user screenshot case); placing an Exit on an arm terminates only that arm. Round-trips through the DSL (save+reload same graph).',
      'Delete re-links to a valid converging graph; no loops/orphans; validateCampaignDefinition passes for the diamond; workspace-scoped. No regression in the phase-5/6 canvas + editor e2e.',
    ],
  },
  {
    id: 'phase7-lifecycle-journey', frontend: true,
    title: 'Lifecycle, dashboards + full end-to-end journey',
    refs: '§9B + CLAUDE.md (broadcast list/lifecycle patterns, activity log, dashboards)',
    scope: [
      'Campaigns is a LIST page that MIRRORS Broadcasts (BroadcastComposer): the /campaigns route shows a table/list of campaigns (name, lifecycle status, enrollment counts) with a "New campaign" action; opening/creating a campaign navigates to a SEPARATE edit page at route /campaigns/:id (the canvas builder) — the builder is NOT the top-level campaigns page. REMOVE any top-level "Design email" affordance from the campaigns list/page: email design lives ONLY inside a send-node editor (reached from a send node in the builder), never as a standalone campaigns-page button. Reuse the broadcasts list/detail routing + kit (ActionMenu row actions, etc.).',
      'Campaign LIFECYCLE: draft / active / paused (and the existing completed/exited/failed enrollment states); publish (validate→active), pause/resume, archive. Show per-campaign enrollment counts (active / completed / exited / failed) and optionally per-node counts.',
      'A full END-TO-END journey acceptance test against the local stack: define a campaign in the builder (trigger → wait → hour-window → if → update-profile → send + webhook → exit), enroll a profile (each trigger kind — INCLUDING POSTing to the live local-api /profiles/:id/events path to assert event-trigger enrollment, closing the phase-3 coverage gap), advance via the runner (injected clock), and assert the update-profile step wrote an event-sourced attribute, it sends through the Dispatcher (messages_log) + fires the (mocked) webhook + completes — workspace-scoped, idempotent.',
      'Docs + hygiene: update CLAUDE.md (the campaign builder + new nodes + tz + triggers), bump the root version, ensure migrations applied to cdp + cdp_e2e.',
    ],
    criteria: [
      'The campaigns screen is a LIST (like broadcasts); creating/opening a campaign routes to a SEPARATE /campaigns/:id builder page; there is NO "Design email" button on the campaigns list page (email design is only inside a send-node editor). Verified in a REAL browser.',
      'The campaign list shows lifecycle status + enrollment counts; publish/pause/resume work and are capability-gated + workspace-scoped; an active campaign enrolls + advances profiles. Verified in a REAL browser + against REAL Postgres.',
      'The full journey acceptance test passes: a built campaign enrolls (segment/event/manual), advances through wait/hour-window/if/send/webhook/exit with an injected clock, sends via the Dispatcher (messages_log, campaign_id) and fires the mocked webhook, idempotently, all workspace-scoped.',
      'CLAUDE.md updated; root version bumped; no regression across the full Vitest + e2e suite (cold).',
    ],
  },
];

export async function process(inputs, ctx) {
  const targetQuality = inputs.targetQuality ?? 90;
  const maxIterations = inputs.maxIterations ?? 4;
  const startedAt = ctx.now();

  ctx.log?.('info', 'CDP campaign-builder starting (§9B visual builder, 7 phases, local-only, test-first, browser-gated UI)');

  const phaseResults = [];
  for (const phase of PHASES) {
    const plan = await ctx.task(planPhaseTask, { phase });

    let iteration = 0;
    let prevFeedback = null;
    let converged = false;
    let last = null;
    const history = [];

    while (iteration < maxIterations && !converged) {
      iteration++;
      const impl = await ctx.task(implementPhaseTask, {
        phase, plan, iteration, prevFeedback, firstIteration: iteration === 1,
      });
      const gate = await ctx.task(qualityGateTask, { phase, plan, impl, iteration });
      last = { iteration, impl, gate };
      history.push(last);
      if (gate.score >= targetQuality && gate.testsPass && gate.criteriaAllMet) converged = true;
      else prevFeedback = gate.recommendations;
    }

    const commit = await ctx.task(commitPhaseTask, { phase, converged, score: last?.gate?.score ?? 0 });
    phaseResults.push({
      id: phase.id, title: phase.title,
      converged, finalScore: last?.gate?.score ?? 0, iterations: iteration, commit, history,
    });
  }

  // Final full-journey integration + acceptance pass.
  let integration;
  {
    let iteration = 0;
    let prevFeedback = null;
    let passed = false;
    let last = null;
    while (iteration < maxIterations && !passed) {
      iteration++;
      const impl = await ctx.task(integrationTask, { iteration, prevFeedback, phases: PHASES });
      const gate = await ctx.task(integrationGateTask, { iteration, impl, phases: PHASES });
      last = { iteration, impl, gate };
      if (gate.score >= targetQuality && gate.allCriteriaVerified) passed = true;
      else prevFeedback = gate.recommendations;
    }
    const commit = await ctx.task(commitPhaseTask, {
      phase: { id: 'final-journey', title: 'Full end-to-end campaign journey acceptance' },
      converged: passed, score: last?.gate?.score ?? 0,
    });
    integration = { passed, finalScore: last?.gate?.score ?? 0, iterations: iteration, commit, detail: last };
  }

  return {
    success: phaseResults.every((p) => p.converged) && integration.passed,
    phases: phaseResults,
    integration,
    duration: ctx.now() - startedAt,
    metadata: { processId: 'cdp/campaign-builder', timestamp: startedAt },
  };
}

// ============================================================================
// TASK DEFINITIONS
// ============================================================================

const browserNote = (frontend) =>
  frontend
    ? 'This phase has a FRONTEND/UI surface. The widest quality loop is a REAL BROWSER: build the UI in /web (Preact) and verify with Playwright e2e (pnpm --filter @cdp/web test:e2e) against the e2e stack (cdp_e2e DB, :8788/:5174). Reuse the kit (ActionMenu/Drawer/Button/Field/Select), the broadcast email-instance flow, and the segment rule builder. Seed deterministic data (web/e2e/seed.ts) + stable data-testid selectors. NO native dialogs; server buttons spinner+lock.'
    : 'Backend phase: pure unit tests + DB-integration against REAL local Postgres (DATABASE_URL=postgres://postgres:postgres@localhost:5433/cdp). Mock AWS/SES (aws-sdk-client-mock) / LocalStack; the webhook HTTP client is injected/mocked. No frontend.';

export const planPhaseTask = defineTask('plan-phase', (args, taskCtx) => ({
  kind: 'agent',
  title: `Plan: ${args.phase.title}`,
  agent: {
    name: AGENT,
    prompt: {
      role: 'senior test architect practicing TDD on a serverless multi-tenant CDP (campaign workflow engine + Preact SPA)',
      task: `Turn the acceptance criteria for "${args.phase.title}" into a concrete, test-first plan that REUSES the existing campaign-runner, dispatcher, segment compiler, broadcast email-instance flow, and UI kit.`,
      context: {
        docs: DOCS, phase: args.phase, invariants: INVARIANTS, env: ENV,
        loop: browserNote(args.phase.frontend),
        prior: 'The campaign-runner backend is MATURE: dsl.ts (trigger/wait/condition/action/exit + validateCampaignDefinition), core.ts (processNode, outbox/set_attribute/advance builders), run.ts (one-tx FOR UPDATE tick + legacy CAS), enroll.ts (segment-entry enrollment). The broadcast email-INSTANCE/clone flow + sendBroadcast gating + the Dispatcher campaign path already exist. The current CampaignBuilder.tsx is a 164-line PLACEHOLDER. Read these before planning.',
      },
      instructions: [
        `Read ${DOCS}, plus the cited files for this phase: ${args.phase.refs}. Read the existing campaign-runner + the relevant broadcast/segment code you will reuse.`,
        'For each acceptance criterion, define the test file(s), tier (unit | integration | e2e/browser), and the exact assertions — especially tenant-isolation, idempotency/concurrency, the Dispatcher-gating for sends, webhook SSRF/allowlist, and tz-correctness.',
        'Identify the pure functions and what is mocked (AWS/SES/LocalStack; injected HTTP client for webhook) vs real (Postgres; real browser for UI).',
        'List implementation units + dependency order, and EXACTLY which existing code/components to reuse. For UI phases, specify the Playwright e2e flows.',
        'Return ONLY the JSON.',
      ],
      outputFormat: 'JSON: { testFiles: [{path, tier, criterion, assertions:[...]}], pureFunctions: string[], mocks: string[], e2eFlows: string[], implUnits: string[], reuse: string[], notes: string }',
    },
    outputSchema: {
      type: 'object', required: ['testFiles', 'implUnits'],
      properties: {
        testFiles: { type: 'array', items: { type: 'object' } },
        pureFunctions: { type: 'array', items: { type: 'string' } },
        mocks: { type: 'array', items: { type: 'string' } },
        e2eFlows: { type: 'array', items: { type: 'string' } },
        implUnits: { type: 'array', items: { type: 'string' } },
        reuse: { type: 'array', items: { type: 'string' } },
        notes: { type: 'string' },
      },
    },
  },
  io: { inputJsonPath: `tasks/${taskCtx.effectId}/input.json`, outputJsonPath: `tasks/${taskCtx.effectId}/result.json` },
  labels: ['plan', args.phase.id],
}));

export const implementPhaseTask = defineTask('implement-phase', (args, taskCtx) => ({
  kind: 'agent',
  title: `Implement: ${args.phase.title} (iteration ${args.iteration})`,
  agent: {
    name: AGENT,
    prompt: {
      role: 'senior full-stack TypeScript engineer building a serverless multi-tenant CDP campaign engine + Preact SPA, test-first',
      task: `Implement "${args.phase.title}" to satisfy its test plan and acceptance criteria. Red → green → refactor. REUSE existing infra; do not reinvent.`,
      context: {
        docs: DOCS, phase: args.phase, plan: args.plan, invariants: INVARIANTS, env: ENV,
        iteration: args.iteration, firstIteration: args.firstIteration, previousGateFeedback: args.prevFeedback,
        loop: browserNote(args.phase.frontend),
      },
      instructions: [
        `Read ${DOCS} + the cited files: ${args.phase.refs}. Reuse the existing campaign-runner / dispatcher / segment compiler / broadcast email-instance flow / UI kit per the plan's "reuse" list.`,
        args.firstIteration
          ? 'FIRST write the failing tests from the plan (red), then implement to green. Logic in pure injected functions; handlers/components thin.'
          : 'Address the previousGateFeedback precisely.',
        'Honor every invariant — tenant isolation, workspace_id never client-supplied, all sends through the Dispatcher gating, runner idempotency/concurrency, webhook SSRF/allowlist + injected HTTP, workspace-tz time math, the single DSL graph model (no stored coords/loops/orphans), reuse + UI standing rules.',
        'Mock AWS/SES (aws-sdk-client-mock) or LocalStack; the integration tier uses the REAL local Postgres (never mock the DB). The webhook HTTP client is injected/mocked. For UI phases verify with Playwright (real browser) against the e2e stack; seed deterministic data.',
        'Apply any new SQL migration to BOTH cdp AND cdp_e2e (node pg script; psql unavailable). Run the relevant pnpm test (with DATABASE_URL) + pnpm typecheck + pnpm lint, and Playwright e2e for UI phases. Rebuild a changed package (tsc -b) and RESTART the dev API if you manually exercise it. Iterate until GREEN incl. a COLD run; confirm no regression. Report actual command output.',
        'Bump the root package.json version appropriately and update CLAUDE.md if behavior/architecture changed. Implement ONLY the agreed design — no scope creep. Return ONLY the JSON.',
      ],
      outputFormat: 'JSON: { filesCreated: string[], filesModified: string[], migrationsApplied: string[], versionBump: string, testsPass: boolean, testSummary: string, e2eSummary: string, typecheckOk: boolean, lintOk: boolean, commandsRun: string[], notes: string }',
    },
    outputSchema: {
      type: 'object', required: ['filesCreated', 'filesModified', 'testsPass'],
      properties: {
        filesCreated: { type: 'array', items: { type: 'string' } },
        filesModified: { type: 'array', items: { type: 'string' } },
        migrationsApplied: { type: 'array', items: { type: 'string' } },
        versionBump: { type: 'string' },
        testsPass: { type: 'boolean' },
        testSummary: { type: 'string' },
        e2eSummary: { type: 'string' },
        typecheckOk: { type: 'boolean' },
        lintOk: { type: 'boolean' },
        commandsRun: { type: 'array', items: { type: 'string' } },
        notes: { type: 'string' },
      },
    },
  },
  io: { inputJsonPath: `tasks/${taskCtx.effectId}/input.json`, outputJsonPath: `tasks/${taskCtx.effectId}/result.json` },
  labels: ['implement', args.phase.id, `iteration-${args.iteration}`],
}));

export const qualityGateTask = defineTask('quality-gate', (args, taskCtx) => ({
  kind: 'agent',
  title: `Quality gate: ${args.phase.title} (iteration ${args.iteration})`,
  agent: {
    name: AGENT,
    prompt: {
      role: 'adversarial principal reviewer + QA engineer verifying spec-fidelity, tenant isolation, runner idempotency, webhook safety, and (for UI) real-browser behavior',
      task: `Independently verify "${args.phase.title}" against its criteria. Re-run the tests yourself (cold cache); do not trust the self-report.`,
      context: { docs: DOCS, phase: args.phase, plan: args.plan, implReport: args.impl, invariants: INVARIANTS, env: ENV,
        loop: browserNote(args.phase.frontend) },
      instructions: [
        'Clear the turbo cache and RUN the tests yourself (DATABASE_URL set) twice from cold, plus pnpm typecheck and pnpm lint. For UI phases, RUN the Playwright e2e in a real browser. Record real pass/fail. Confirm the integration tier RUNS (real Postgres, not skipped/mocked) and no regression in earlier phases or the broadcast suite.',
        `Verify EACH acceptance criterion is covered by a passing, non-vacuous test: ${JSON.stringify(args.phase.criteria)}.`,
        'Highest-priority checks: (a) tenant isolation + workspace_id never client-supplied (server-side); (b) all campaign sends route through the Dispatcher gating with the mandatory From/To/Subject envelope (no no-reply); (c) runner idempotency/concurrency (no double-advance / double-send / double-webhook); (d) webhook SSRF + domain allowlist + injected HTTP (no real host) + bounded retries/timeout; (e) workspace-tz time math is DST-correct; (f) the DSL stays the single graph model (no loops/orphans/stored coords); (g) for UI, the flow works in a REAL browser, server buttons spinner+lock, NO native dialogs, data-testid preserved.',
        'If any integration test mocks Postgres, that is a FAIL. If a UI criterion is only unit-tested (no real browser), that is a FAIL. If the webhook test hits a real host, that is a FAIL.',
        'Scope check: flag any feature beyond the agreed design. Confirm the root version was bumped + CLAUDE.md updated when behavior changed.',
        'Score 0-100. Set testsPass and criteriaAllMet honestly. Give concrete prioritized recommendations.',
      ],
      outputFormat: 'JSON: { score: number, testsPass: boolean, criteriaAllMet: boolean, criteriaCoverage: [{criterion, met, evidence}], isolationOk: boolean, idempotencyOk: boolean, webhookSafetyOk: boolean, browserVerified: boolean, scopeCreep: string[], recommendations: string[], criticalIssues: string[] }',
    },
    outputSchema: {
      type: 'object', required: ['score', 'testsPass', 'criteriaAllMet', 'recommendations'],
      properties: {
        score: { type: 'number', minimum: 0, maximum: 100 },
        testsPass: { type: 'boolean' },
        criteriaAllMet: { type: 'boolean' },
        criteriaCoverage: { type: 'array', items: { type: 'object' } },
        isolationOk: { type: 'boolean' },
        idempotencyOk: { type: 'boolean' },
        webhookSafetyOk: { type: 'boolean' },
        browserVerified: { type: 'boolean' },
        scopeCreep: { type: 'array', items: { type: 'string' } },
        recommendations: { type: 'array', items: { type: 'string' } },
        criticalIssues: { type: 'array', items: { type: 'string' } },
      },
    },
  },
  io: { inputJsonPath: `tasks/${taskCtx.effectId}/input.json`, outputJsonPath: `tasks/${taskCtx.effectId}/result.json` },
  labels: ['quality-gate', args.phase.id, `iteration-${args.iteration}`],
}));

export const commitPhaseTask = defineTask('commit-phase', (args, taskCtx) => ({
  kind: 'agent',
  title: `Commit: ${args.phase.title}`,
  agent: {
    name: AGENT,
    prompt: {
      role: 'engineer committing completed, verified work',
      task: `Stage and git-commit the work for "${args.phase.title}".`,
      context: { phase: args.phase, converged: args.converged, score: args.score },
      instructions: [
        'Run `git add -A`. If not on a feature branch and on the default branch, create/use a branch first.',
        `Commit with a clear conventional message describing the phase (${args.phase.title}), gate score (${args.score}), converged=${args.converged}.`,
        'End the commit message body with: Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>',
        'Do NOT push. Return the commit hash. Return ONLY the JSON.',
      ],
      outputFormat: 'JSON: { committed: boolean, commitHash: string, message: string }',
    },
    outputSchema: { type: 'object', required: ['committed'], properties: { committed: { type: 'boolean' }, commitHash: { type: 'string' }, message: { type: 'string' } } },
  },
  io: { inputJsonPath: `tasks/${taskCtx.effectId}/input.json`, outputJsonPath: `tasks/${taskCtx.effectId}/result.json` },
  labels: ['commit', args.phase.id],
}));

export const integrationTask = defineTask('integration', (args, taskCtx) => ({
  kind: 'agent',
  title: `Full end-to-end campaign journey (iteration ${args.iteration})`,
  agent: {
    name: AGENT,
    prompt: {
      role: 'senior engineer building the final full-journey campaign acceptance test',
      task: 'Add a full-journey acceptance test proving a campaign built in the new builder enrolls + advances + sends + webhooks + completes, end-to-end, against real Postgres + a real browser smoke.',
      context: { docs: DOCS, invariants: INVARIANTS, env: ENV,
        phaseCriteria: args.phases.map((p) => ({ id: p.id, criteria: p.criteria })),
        previousGateFeedback: args.prevFeedback },
      instructions: [
        'Assemble a consolidated acceptance pass: a campaign with trigger → wait → hour-of-day window → if → send + webhook → exit. Enroll a profile via EACH trigger kind (segment-entry, event, manual). Advance the runner with an INJECTED clock through every node; assert the send flows through the Dispatcher (messages_log, campaign_id) with rendered merge tags, the (mocked/injected) webhook fires with the allowlist/SSRF guard, and the enrollment completes — idempotently, workspace-scoped, against REAL Postgres.',
        'Add a thin Playwright browser smoke: build (or load a seeded) campaign in the new canvas builder, publish it, and see it active with enrollment counts — proving the UI is wired to the real backend.',
        'Prove the cross-cutting guarantees once more at the system level: tenant isolation across all campaign paths, runner idempotency/concurrency, webhook safety, workspace-tz correctness, and all sends through the Dispatcher gating.',
        'Run until green (cold); report real output. Address previousGateFeedback if present. Return ONLY the JSON.',
      ],
      outputFormat: 'JSON: { filesCreated: string[], filesModified: string[], allPass: boolean, testSummary: string, e2eSummary: string, entrypoint: string, commandsRun: string[], notes: string }',
    },
    outputSchema: {
      type: 'object', required: ['filesCreated', 'allPass'],
      properties: {
        filesCreated: { type: 'array', items: { type: 'string' } },
        filesModified: { type: 'array', items: { type: 'string' } },
        allPass: { type: 'boolean' },
        testSummary: { type: 'string' },
        e2eSummary: { type: 'string' },
        entrypoint: { type: 'string' },
        commandsRun: { type: 'array', items: { type: 'string' } },
        notes: { type: 'string' },
      },
    },
  },
  io: { inputJsonPath: `tasks/${taskCtx.effectId}/input.json`, outputJsonPath: `tasks/${taskCtx.effectId}/result.json` },
  labels: ['integration', `iteration-${args.iteration}`],
}));

export const integrationGateTask = defineTask('integration-gate', (args, taskCtx) => ({
  kind: 'agent',
  title: `Final journey acceptance gate (iteration ${args.iteration})`,
  agent: {
    name: AGENT,
    prompt: {
      role: 'adversarial principal reviewer signing off the campaign builder end-to-end',
      task: 'Independently run the full-journey acceptance test + browser smoke and confirm every criterion across phases 1–7 is verified end-to-end against real Postgres.',
      context: { docs: DOCS, invariants: INVARIANTS, env: ENV, implReport: args.impl,
        phaseCriteria: args.phases.map((p) => ({ id: p.id, criteria: p.criteria })) },
      instructions: [
        'Independently run the acceptance entrypoint + the Playwright browser smoke (cold). Record real results. Confirm a REAL database, AWS/SES mocked, and the webhook HTTP client injected (no real external host).',
        'Confirm each criterion across ALL phases is proven by an assertion: workspace tz + DSL extensions, runner execution of hour-window + webhook, the three trigger/enrollment kinds, the send-node email instance + gating, the canvas builder round-trip + invariants, the per-node editors + publish validation, and the lifecycle + full journey.',
        'Confirm no regression across the full Vitest + e2e suite and no scope creep; confirm the root version was bumped and CLAUDE.md updated.',
        'Score 0-100 and set allCriteriaVerified honestly. Give concrete recommendations for any gap.',
      ],
      outputFormat: 'JSON: { score: number, allCriteriaVerified: boolean, usesRealPostgres: boolean, webhookInjected: boolean, browserVerified: boolean, coverage: [{criterion, verified, evidence}], recommendations: string[], criticalIssues: string[] }',
    },
    outputSchema: {
      type: 'object', required: ['score', 'allCriteriaVerified', 'recommendations'],
      properties: {
        score: { type: 'number', minimum: 0, maximum: 100 },
        allCriteriaVerified: { type: 'boolean' },
        usesRealPostgres: { type: 'boolean' },
        webhookInjected: { type: 'boolean' },
        browserVerified: { type: 'boolean' },
        coverage: { type: 'array', items: { type: 'object' } },
        recommendations: { type: 'array', items: { type: 'string' } },
        criticalIssues: { type: 'array', items: { type: 'string' } },
      },
    },
  },
  io: { inputJsonPath: `tasks/${taskCtx.effectId}/input.json`, outputJsonPath: `tasks/${taskCtx.effectId}/result.json` },
  labels: ['integration', 'quality-gate', `iteration-${args.iteration}`],
}));
