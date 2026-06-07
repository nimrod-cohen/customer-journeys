/**
 * @process cdp/app-completion
 * @description Build spec §17 phases 9–14 to completion on top of phases 2–8:
 *   (9) broadcasts §9A, (10) campaign workflow engine §9B, (11) image pipeline +
 *   WYSIWYG §11, (12) admin frontend §12 (Vite+Preact, Playwright e2e), (13)
 *   usage metering + IP advisor §20/§10, (14) hardening §14. Test-first (§16A),
 *   per-phase adversarial quality gate, fully autonomous. LOCAL-only: AWS
 *   (SES/SNS/S3/SQS) mocked + LocalStack; real Postgres on localhost:5433 for the
 *   integration tier (never mocked); Playwright (real browser) for the UI phases.
 *   Ends with a full-system integration/acceptance pass.
 *
 * @inputs { targetQuality?: number, maxIterations?: number }
 * @outputs { success: boolean, phases: array, integration: object }
 */

import { defineTask } from '@a5c-ai/babysitter-sdk';

const SPEC = 'CDP-BUILD-SPEC.md';
const AGENT = 'general-purpose';

const INVARIANTS = [
  'Tenant isolation: every tenant-scoped row carries workspace_id NOT NULL; every query filters by workspace_id. Service-role Lambdas bypass RLS so they MUST scope by workspace_id in code; the admin app uses the user JWT so RLS applies.',
  'workspace_id is NEVER from a client payload — it comes from the API-key/authorizer context or a trusted server-set field. The frontend sends the active-workspace claim via its JWT; the API resolves scope from the authorizer, never from a body field.',
  'Role enforcement (§3A): owner/marketer/accounting are workspace-scoped; system-admin is the only cross-tenant role and every cross-tenant access is audit-logged. The UI shows only what the role permits; the API enforces it regardless of the UI.',
  'All sends (broadcasts §9A and campaign actions §9B) go through the SAME outbox -> Dispatcher pipeline (§9) and pass suppression -> frequency-cap -> quiet-hours; sending is gated on workspace active/verified.',
  'Idempotency: broadcasts dedupe per (broadcast_id, profile_id); the campaign runner must tolerate retries without double-advancing (optimistic checks / updated_at); image uploads + metering rollups are idempotent.',
  'LOCAL-only: AWS (SES/SNS/S3/SQS) are MOCKED (aws-sdk-client-mock) or run on LocalStack; never hit real AWS. Do NOT mock Postgres in the integration tier — use the real local DB on localhost:5433. The editor must emit MJML, never hand-rolled email HTML.',
  'Logic in pure injected functions; Lambda handlers stay thin. Reuse the prior harness (packages/db testutil: adminPool, hasDatabaseUrl, applyMigrations; runPlanInWorkspaceTx; SqlStatement {text,values}; @cdp/segments resolveAudience; @cdp/email; the dispatcher core).',
  'Determinism: turbo test task is cache:false — keep it. Unique workspace UUIDs + file-local namespaces per integration file (events.event_id / ses_message_id are GLOBAL keys). No cross-file races. Frontend e2e (Playwright) must be deterministic (seeded data, stable selectors).',
  'Scope discipline: implement exactly what the cited sections require for THIS phase — no features beyond the spec. Keep the cost model EXACTLY as §20 (direct usage + even split of fixed costs).',
];

const PHASES = [
  {
    id: 'phase9-broadcasts', frontend: false,
    title: 'Broadcasts (one-off send)',
    specSections: '§9A (broadcast: resolve audience at send time, batched enumeration -> outbox, scheduling, status), §9 (Dispatcher), §6 (broadcasts, outbox, messages_log, segment_memberships)',
    scope: [
      'services/broadcast: a Broadcast Lambda (triggered on send / at scheduled_at via EventBridge) that RESOLVES the audience at send time from segment_memberships (dynamic OR manual segment) via @cdp/segments resolveAudience; snapshots the member set.',
      'Enumerate in BATCHES (paginate; large audiences enqueued in chunks) -> insert outbox rows -> the existing Dispatcher (§9) handles per-recipient suppression/cap/quiet-hours and the actual send.',
      'Update broadcasts.status (draft->scheduled->sending->sent / cancelled); record per-recipient sends in messages_log.',
      'Idempotent dedupe_key per (broadcast_id, profile_id) prevents double-sends on retry.',
    ],
    criteria: [
      'A broadcast to a segment or manual group sends once to the resolved audience; each recipient passes suppression/cap/quiet-hours (via the Dispatcher).',
      'Retries do not double-send (dedupe per (broadcast_id, profile_id)).',
      'Audience is resolved at send time from segment_memberships (works for both dynamic and manual segments); large audiences are enumerated in batches.',
      'broadcasts.status transitions correctly (sending -> sent); scheduling at scheduled_at is honored; everything workspace-scoped.',
    ],
  },
  {
    id: 'phase10-campaigns', frontend: false,
    title: 'Campaign workflow engine',
    specSections: '§9B (table-driven per-profile state machine: nodes trigger/wait/condition/action/exit; Campaign-runner sweep on next_run_at; enrollment via segment entry), §8 (reuse compiler for branch conditions), §9 (Dispatcher for action sends), §6 (campaigns, campaign_enrollments, segment_change_log)',
    scope: [
      'A campaign DSL: campaigns.definition is a graph of nodes [trigger|wait|condition|action|exit] + edges. Define the node schema in this phase.',
      'Enrollment: a trigger (segment entry via segment_change_log, an event, or manual) inserts a campaign_enrollments row at the start node (UNIQUE (campaign_id, profile_id)).',
      'services/campaign-runner: scheduled sweep WHERE status=active AND next_run_at <= now(); process the current node: wait -> set next_run_at; condition -> evaluate via the §8 compiler, pick next node, process immediately; action(send) -> insert outbox row -> Dispatcher; exit -> completed.',
      'Idempotent advance (tolerate retries without double-advancing — use updated_at / optimistic checks). Define and implement the re-enrollment policy.',
    ],
    criteria: [
      'An enrolled profile advances through trigger -> wait -> condition -> action -> exit.',
      'A wait defers until next_run_at; a branch (condition) routes correctly using the §8 compiler against profile/features/membership.',
      'The runner is idempotent (no double-advance on retry / concurrent sweep).',
      'Campaign action sends pass through the Dispatcher guards (suppression/cap/quiet-hours); enrollment via segment entry works; re-enrollment policy is enforced. Everything workspace-scoped.',
    ],
  },
  {
    id: 'phase11-image-wysiwyg', frontend: true,
    title: 'Image pipeline + WYSIWYG editor',
    specSections: '§11 (presigned S3 PUT under workspace_id/ prefix, sharp variants via S3-triggered Lambda, CloudFront, GrapesJS+MJML editor emitting MJML), §6 (usage_counters image bytes)',
    scope: [
      'services/image: an Image Lambda that returns a presigned S3 PUT URL keyed under a workspace_id/ prefix (LocalStack S3); an S3-triggered Lambda that makes sharp variants; record bytes in usage_counters (image_storage_bytes). Mock/LocalStack S3.',
      'Frontend (in /web): a GrapesJS + MJML-plugin email editor component (core GrapesJS, BSD-3, NOT the paid Studio SDK) that emits MJML; on save, MJML -> compiled HTML via the existing Template Lambda (@cdp/email compile) stored in email_templates. Images uploaded via the presigned URL flow.',
      'The editor must OUTPUT MJML, not hand-rolled email HTML.',
    ],
    criteria: [
      'The Image Lambda issues a presigned S3 PUT URL under the workspace_id/ key prefix; uploaded image bytes are recorded in usage_counters; variants are produced by the sharp step. (Verified against LocalStack S3 / mocked S3.)',
      'The GrapesJS+MJML editor renders in a real browser (Playwright), lets a user compose a template, and on save emits MJML that compiles to HTML stored in email_templates (workspace-scoped).',
      'Image keys are workspace-prefixed; one workspace cannot read/overwrite another workspace prefix.',
    ],
  },
  {
    id: 'phase12-frontend', frontend: true,
    title: 'Admin frontend (role-aware SPA)',
    specSections: '§12 (Vite SPA, Supabase Auth, workspace switcher, role-aware + workspace-scoped UI, segment builder dynamic+manual, broadcast composer, campaign/workflow builder, email editor, dashboards, suppression list, profile explorer, billing/usage view, system-admin console), §3A (roles), §10A (onboarding wizard UI)',
    scope: [
      'A Vite + Preact (or React) SPA in /web wired to the API Gateway REST API (via the Lambda handlers; stand up a LOCAL API — e.g. a thin adapter/serverless-offline + LocalStack — so the SPA + Playwright run end-to-end locally). Supabase Auth login + a workspace switcher that sets the active workspace_id claim and re-scopes the app.',
      'Role-aware, workspace-scoped screens (§3A capability matrix): workspace onboarding wizard (§10A), workspace settings (members+roles, sending domain status), segment builder (dynamic rule-AST + manual hand-pick/CSV) with live size preview, broadcast composer, campaign/workflow visual builder (trigger/wait/condition/action/exit), email editor (GrapesJS+MJML from phase 11), dashboards (deliverability/segment sizes/send volume), suppression list, profile explorer, billing/usage view (owner+accounting), system-admin cross-company console (system-admin only).',
      'The UI shows only what the role permits AND is scoped to the active workspace; the API still enforces roles + scope independently.',
    ],
    criteria: [
      'Login (Supabase Auth) + a workspace switcher: a user in two workspaces sees only the active workspace; switching re-scopes all reads/writes (no cross-bleed). Verified in a real browser (Playwright).',
      'Role-aware UI (§3A): marketer cannot see/use user/domain/billing admin; accounting sees billing but cannot edit segments/campaigns; owner can do both; system-admin sees the cross-company console. Verified in-browser per role.',
      'The core screens work end-to-end against the local API: build a segment (dynamic + manual), compose+send a broadcast, build a campaign, view dashboards/suppressions/profiles — exercising the real phase 2–11 backends.',
      'The API enforces role + workspace scope regardless of the UI (a forbidden action is rejected server-side, not just hidden).',
    ],
  },
  {
    id: 'phase13-metering', frontend: false,
    title: 'Usage metering + cost attribution + IP advisor',
    specSections: '§20 (metering into usage_counters, hybrid cost model: direct usage + even split of fixed costs; per-workspace cost view), §10 (dedicated-IP recommendation engine + upgrade-ip migration with warmup), §6 (usage_counters, messages_log, email_events)',
    scope: [
      'services/metering: a scheduled rollup job populating usage_counters (emails_sent from messages_log, events_ingested, image bytes) and a per-workspace monthly cost computation using the EXACT §20 hybrid policy: direct/variable costs attributed to the workspace (emails_sent x $0.0001, dedicated IP $24.95 if upgraded, image bytes) PLUS an EQUAL share of the fixed pool (fixed_total / active_workspace_count). Per-workspace figures must sum to the true total.',
      'A monthly IP-advisor job that recommends a dedicated IP only when ALL hold: sustained volume (~100k/mo for 2-3 consecutive months), consistent cadence, healthy reputation. Surfaces a recommendation (no auto-upgrade).',
      'An upgrade-ip flow: provision a dedicated IP/pool, gradual warmup (split routing), track ip_mode/warmup_status per workspace; ~$24.95/mo becomes a direct cost only for upgraded workspaces.',
    ],
    criteria: [
      'Per-workspace emails_sent / events_ingested reconcile with messages_log / events.',
      'The cost view = direct usage cost + an equal share of fixed costs; per-workspace figures sum to the true total (worked example from §20 holds).',
      'The IP-advisor recommends a dedicated IP only when sustained-volume + cadence + reputation criteria are all met; one-off spikes do not trigger it.',
      'The upgrade-ip flow provisions a dedicated IP, warms it gradually (split routing), and tracks ip_mode/warmup_status; the $24.95 lands only on upgraded workspaces.',
    ],
  },
  {
    id: 'phase14-hardening', frontend: false,
    title: 'Hardening (acceptance suite, WAF, DLQ runbook, load)',
    specSections: '§13 (security/tenancy), §14 (IaC: WAF, least-privilege IAM, alarms), §16 (observability, DLQ runbook), §18 (full acceptance criteria), §17 phase 14',
    scope: [
      'A consolidated §18 ACCEPTANCE test suite (the isolation + role + ordering + suppression + reputation + broadcast + campaign + cost criteria) runnable as one gate — the pass/fail merge gate.',
      'CDK hardening (infra): WAF on the REST API stage, per-function least-privilege IAM, CloudWatch alarms (account + per-workspace reputation, DLQ depth, Lambda errors, SQS oldest-message age). Verify via CDK synth/assertions (no real deploy).',
      'A DLQ runbook + replay script (scripts/) and a /health check; a lightweight load/perf sanity check of the ingest->processor path (local).',
      'An isolation/role pen-test style test asserting no cross-workspace read/write is possible via any service path (incl. the system-admin audited exception).',
    ],
    criteria: [
      'The full §18 acceptance suite passes as one gate (tenant isolation, roles, ordering, no-loss, idempotency, segmentation, suppression scoping, reputation policing, broadcasts, campaigns, cost attribution).',
      'CDK synth produces a WAF-protected REST API, least-privilege IAM per function, and the required alarms (verified by CDK assertions, no real deploy).',
      'A DLQ replay script + /health exist; an isolation/role pen-test asserts no cross-workspace bleed via any path (system-admin access is audited).',
    ],
  },
];

export async function process(inputs, ctx) {
  const targetQuality = inputs.targetQuality ?? 90;
  const maxIterations = inputs.maxIterations ?? 4;
  const startedAt = ctx.now();

  ctx.log?.('info', 'CDP app-completion build starting (phases 9–14, local-only, autonomous, browser-gated UI)');

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

  // Final full-system integration + §18 acceptance pass.
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
      phase: { id: 'final-acceptance', title: 'Full-system integration + §18 acceptance' },
      converged: passed, score: last?.gate?.score ?? 0,
    });
    integration = { passed, finalScore: last?.gate?.score ?? 0, iterations: iteration, commit, detail: last };
  }

  return {
    success: phaseResults.every((p) => p.converged) && integration.passed,
    phases: phaseResults,
    integration,
    duration: ctx.now() - startedAt,
    metadata: { processId: 'cdp/app-completion', timestamp: startedAt },
  };
}

// ============================================================================
// TASK DEFINITIONS
// ============================================================================

const browserNote = (frontend) =>
  frontend
    ? 'This phase has a FRONTEND/UI surface. The widest quality loop is a REAL BROWSER: build the UI with Vite + Preact (or React) and verify with Playwright e2e against a locally-running app + local API (thin adapter/serverless-offline over the Lambda handlers + LocalStack). Use the core GrapesJS + MJML plugin (BSD-3, free) — never the paid Studio SDK; the editor must emit MJML. Seed deterministic data and use stable selectors so the e2e is reliable.'
    : 'Backend phase: pure unit tests + DB-integration against REAL local Postgres (localhost:5433); mock AWS (aws-sdk-client-mock) / LocalStack. No frontend.';

export const planPhaseTask = defineTask('plan-phase', (args, taskCtx) => ({
  kind: 'agent',
  title: `Plan: ${args.phase.title}`,
  agent: {
    name: AGENT,
    prompt: {
      role: 'senior test architect practicing TDD on a serverless multi-tenant CDP (with a Preact SPA for UI phases)',
      task: `Turn the §18 acceptance criteria for "${args.phase.title}" into a concrete, test-first plan.`,
      context: {
        spec: SPEC, phase: args.phase, invariants: INVARIANTS,
        loop: browserNote(args.phase.frontend),
        prior: 'Phases 2-8 done (tenancy/auth, ingest, profiles, segments, email/onboarding, dispatch, feedback). Reuse the packages/db testutil harness, runPlanInWorkspaceTx, scopedQuery, SqlStatement, @cdp/segments resolveAudience, @cdp/email, the dispatcher core + outbox->Dispatcher pipeline, and the per-workspace suppression query.',
      },
      instructions: [
        `Read ${SPEC} sections: ${args.phase.specSections}, plus §16A and §18.`,
        'For each acceptance criterion, define the test file(s), tier (unit | integration | e2e/browser), and the exact assertions — especially tenant-isolation/role, idempotency, and (for sends) that everything routes through the Dispatcher guards.',
        'Identify the pure functions and what is mocked (AWS/LocalStack) vs real (Postgres; real browser for UI).',
        'List implementation units + dependency order. For UI phases, specify the Playwright e2e flows and how the local API is stood up.',
        'Return ONLY the JSON.',
      ],
      outputFormat: 'JSON: { testFiles: [{path, tier, criterion, assertions:[...]}], pureFunctions: string[], mocks: string[], e2eFlows: string[], implUnits: string[], notes: string }',
    },
    outputSchema: {
      type: 'object', required: ['testFiles', 'implUnits'],
      properties: {
        testFiles: { type: 'array', items: { type: 'object' } },
        pureFunctions: { type: 'array', items: { type: 'string' } },
        mocks: { type: 'array', items: { type: 'string' } },
        e2eFlows: { type: 'array', items: { type: 'string' } },
        implUnits: { type: 'array', items: { type: 'string' } },
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
      role: 'senior full-stack TypeScript engineer building a serverless multi-tenant CDP + Preact SPA, test-first',
      task: `Implement "${args.phase.title}" to satisfy its test plan and §18 criteria. Red -> green -> refactor.`,
      context: {
        spec: SPEC, phase: args.phase, plan: args.plan, invariants: INVARIANTS,
        iteration: args.iteration, firstIteration: args.firstIteration, previousGateFeedback: args.prevFeedback,
        loop: browserNote(args.phase.frontend),
        env: 'Real Postgres: DATABASE_URL=postgres://postgres:postgres@localhost:5433/cdp (migrations applied). turbo test task is cache:false. Docker is available for LocalStack. For UI: build a runnable local app + local API adapter so Playwright can drive it.',
      },
      instructions: [
        `Read ${SPEC} sections: ${args.phase.specSections}.`,
        args.firstIteration
          ? 'FIRST write the failing tests from the plan (red), then implement to green. Logic in pure injected functions; handlers/components thin.'
          : 'Address the previousGateFeedback precisely.',
        'Honor every invariant — tenant isolation, role enforcement, idempotency, and "all sends go through the Dispatcher guards" are pass/fail.',
        'Mock AWS (aws-sdk-client-mock) or use LocalStack; integration tier uses the REAL local Postgres (never mock the DB). For UI phases, verify with Playwright in a real browser against the locally-running app + local API; seed deterministic data.',
        'Run the relevant `pnpm test` (with DATABASE_URL), plus Playwright e2e for UI phases, `pnpm typecheck`, `pnpm lint`. Iterate until GREEN including a COLD turbo run. Confirm no regression in earlier phases. Report actual command output.',
        'Implement ONLY what the cited sections require. Keep the §20 cost model exact. The editor must emit MJML, not hand-rolled HTML.',
        'Return ONLY the JSON.',
      ],
      outputFormat: 'JSON: { filesCreated: string[], filesModified: string[], testsPass: boolean, testSummary: string, e2eSummary: string, typecheckOk: boolean, lintOk: boolean, commandsRun: string[], notes: string }',
    },
    outputSchema: {
      type: 'object', required: ['filesCreated', 'filesModified', 'testsPass'],
      properties: {
        filesCreated: { type: 'array', items: { type: 'string' } },
        filesModified: { type: 'array', items: { type: 'string' } },
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
      role: 'adversarial principal reviewer + QA engineer verifying spec-fidelity, tenant isolation, roles, and (for UI) real-browser behavior',
      task: `Independently verify "${args.phase.title}" against its §18 criteria. Re-run the tests yourself (cold cache); do not trust the self-report.`,
      context: { spec: SPEC, phase: args.phase, plan: args.plan, implReport: args.impl, invariants: INVARIANTS,
        loop: browserNote(args.phase.frontend),
        env: 'Real Postgres: DATABASE_URL=postgres://postgres:postgres@localhost:5433/cdp.' },
      instructions: [
        'Clear the turbo cache and RUN the tests yourself (DATABASE_URL set) twice from cold, plus pnpm typecheck and pnpm lint. For UI phases, RUN the Playwright e2e in a real browser. Record real pass/fail. Confirm the integration tier RUNS (not skipped) and no regression in earlier phases.',
        `Verify EACH acceptance criterion is covered by a passing, non-vacuous test: ${JSON.stringify(args.phase.criteria)}.`,
        'Highest-priority checks: (a) tenant isolation + role enforcement (server-side, not just UI-hidden); (b) all sends route through the Dispatcher guards; (c) idempotency (broadcast dedupe / no double-advance / idempotent rollups); (d) AWS mocked/LocalStack (no real AWS) yet asserted; (e) for UI, the flow actually works in a real browser against the real backend, not a stub.',
        'If any integration test mocks Postgres, that is a FAIL. If a UI criterion is only unit-tested (no real browser), that is a FAIL.',
        'Scope check: flag any feature beyond the cited sections; verify the §20 cost model is exact.',
        'Score 0-100. Set testsPass and criteriaAllMet honestly. Give concrete prioritized recommendations.',
      ],
      outputFormat: 'JSON: { score: number, testsPass: boolean, criteriaAllMet: boolean, criteriaCoverage: [{criterion, met, evidence}], isolationOk: boolean, browserVerified: boolean, scopeCreep: string[], recommendations: string[], criticalIssues: string[] }',
    },
    outputSchema: {
      type: 'object', required: ['score', 'testsPass', 'criteriaAllMet', 'recommendations'],
      properties: {
        score: { type: 'number', minimum: 0, maximum: 100 },
        testsPass: { type: 'boolean' },
        criteriaAllMet: { type: 'boolean' },
        criteriaCoverage: { type: 'array', items: { type: 'object' } },
        isolationOk: { type: 'boolean' },
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
        'Run `git add -A`.',
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
  title: `Full-system integration + §18 acceptance (iteration ${args.iteration})`,
  agent: {
    name: AGENT,
    prompt: {
      role: 'senior engineer building the final full-system integration + §18 acceptance suite',
      task: 'Extend /tests with a full-system acceptance pass proving the WHOLE CDP (phases 2–14) works together against real Postgres, with a browser e2e smoke of the admin app.',
      context: { spec: SPEC, invariants: INVARIANTS,
        phaseCriteria: args.phases.map((p) => ({ id: p.id, criteria: p.criteria })),
        previousGateFeedback: args.prevFeedback,
        env: 'Real Postgres: DATABASE_URL=postgres://postgres:postgres@localhost:5433/cdp. Extend the existing /tests suites + pnpm test:integration.' },
      instructions: [
        `Read ${SPEC} §18 (all acceptance criteria) and §16A.`,
        'Assemble a consolidated §18 acceptance suite that exercises the real cores end-to-end: ingest->processor->features->segments->(broadcast & campaign)->outbox->Dispatcher->messages_log, plus feedback->suppression->reputation, plus metering/cost attribution — all workspace-scoped, against real Postgres. AWS mocked/LocalStack.',
        'Add a thin Playwright browser smoke of the admin app (login -> workspace switch -> a core screen) against the local app + API, proving the UI is wired to the real backend.',
        'Prove the headline cross-cutting guarantees one more time at the system level: tenant isolation across ALL paths, role enforcement server-side, all sends through the Dispatcher, idempotency, and the §20 cost figures summing to the true total.',
        'Provide/extend `pnpm test:integration` (and a `pnpm test:e2e` for browser). Run until green (cold); report real output. Address previousGateFeedback if present. Return ONLY the JSON.',
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
  title: `Final acceptance gate (iteration ${args.iteration})`,
  agent: {
    name: AGENT,
    prompt: {
      role: 'adversarial principal reviewer signing off the whole CDP against §18',
      task: 'Independently run the full acceptance suite + browser smoke and confirm every §18 criterion across phases 2–14 is verified end-to-end against real Postgres.',
      context: { spec: SPEC, invariants: INVARIANTS, implReport: args.impl,
        phaseCriteria: args.phases.map((p) => ({ id: p.id, criteria: p.criteria })),
        env: 'Real Postgres: DATABASE_URL=postgres://postgres:postgres@localhost:5433/cdp.' },
      instructions: [
        'Independently run the acceptance entrypoint + the Playwright browser smoke (cold). Record real results. Confirm a REAL database and that AWS is mocked/LocalStack (no real AWS/mail).',
        'Confirm each §18 criterion across ALL phases is proven by an assertion: tenant isolation, roles, ordering, no-loss, idempotency, segmentation, suppression scoping, reputation policing, broadcasts, campaigns, cost attribution, and the UI wired to the backend.',
        'Confirm no regression and no scope creep, and that the §20 cost figures reconcile and sum to the true total.',
        'Score 0-100 and set allCriteriaVerified honestly. Give concrete recommendations for any gap.',
      ],
      outputFormat: 'JSON: { score: number, allCriteriaVerified: boolean, usesRealPostgres: boolean, browserVerified: boolean, coverage: [{criterion, verified, evidence}], recommendations: string[], criticalIssues: string[] }',
    },
    outputSchema: {
      type: 'object', required: ['score', 'allCriteriaVerified', 'recommendations'],
      properties: {
        score: { type: 'number', minimum: 0, maximum: 100 },
        allCriteriaVerified: { type: 'boolean' },
        usesRealPostgres: { type: 'boolean' },
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
