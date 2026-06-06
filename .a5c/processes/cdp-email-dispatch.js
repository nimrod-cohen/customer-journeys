/**
 * @process cdp/email-dispatch
 * @description Build spec §17 phases 6–8 of the CDP on top of the completed
 *   foundation (phases 2–5): (6) email infra + guided domain onboarding (§10/§10A),
 *   (7) dispatch core (§9), (8) feedback + compliance + reputation policing (§10).
 *   Test-first (§16A), per-phase adversarial quality gate, fully autonomous,
 *   LOCAL-only — SES/SNS and DNS/SES-status checks are MOCKED; real Postgres on
 *   localhost:5433 for the integration tier (never mocked).
 *
 *   Flow per phase: plan tests from §18 -> TDD convergence loop (implement ->
 *   independent quality gate) until the gate passes or maxIterations -> commit.
 *   Then a cross-phase integration pass: onboarding -> activate -> dispatch ->
 *   feedback -> suppression/reputation, end-to-end against real Postgres.
 *
 * @inputs { targetQuality?: number, maxIterations?: number }
 * @outputs { success: boolean, phases: array, integration: object }
 */

import { defineTask } from '@a5c-ai/babysitter-sdk';

const SPEC = 'CDP-BUILD-SPEC.md';
const AGENT = 'general-purpose';

const INVARIANTS = [
  'Tenant isolation: every tenant-scoped row carries workspace_id NOT NULL; every query filters by workspace_id. Service-role Lambdas bypass RLS so they MUST scope by workspace_id in code.',
  'workspace_id is NEVER from a client payload — it comes from the API-key/authorizer context or the trusted message body set by an earlier server step.',
  'LOCAL-only: SES (SendEmail), SNS, and the onboarding DNS/SES-status checks are MOCKED (aws-sdk-client-mock + injected resolvers). NEVER send real mail or hit real DNS/SES. Do NOT mock Postgres in the integration tier — use the real local DB on localhost:5433.',
  'Sending is gated on verification: the Dispatcher refuses to send for any workspace whose status is not active/verified (§10). Every send passes suppression -> frequency-cap -> quiet-hours, in that order.',
  'Suppression is per-workspace: keyed (workspace_id, email); an unsubscribe/bounce in workspace A must NOT suppress the same email in workspace B. Hard bounces are ALSO recorded in the cross-workspace global_hard_bounces.',
  'Idempotency: outbox.dedupe_key prevents double-sends; feedback handlers are idempotent on the SES message id / event.',
  'Logic in pure injected functions; Lambda handlers stay thin and are unit-tested via the pure function. Reuse the Phase 2-5 harness (packages/db testutil: adminPool, hasDatabaseUrl, applyMigrations, runPlanInWorkspaceTx) and the SqlStatement {text, values} shape.',
  'Determinism: turbo test task is cache:false — keep it. Unique workspace UUIDs + file-local namespaces per integration file (events.event_id is a GLOBAL PK). No cross-file races.',
  'Scope discipline: implement exactly what the cited sections require for THIS phase — no broadcasts (§9A), campaigns (§9B), image pipeline, frontend, or metering (those are later phases). Leave clean extension points.',
];

const PHASES = [
  {
    id: 'phase6-email-onboarding',
    title: 'Email infrastructure + guided domain onboarding',
    specSections: '§10 (SES sending identity, gated onboarding, config set, IP strategy), §10A (onboarding wizard start/check/activate, DNS+SES validation), §11 (MJML compile at template save), §6 (workspaces.sending_identity jsonb, email_templates)',
    scope: [
      'packages/email: an injectable SES client wrapper (createDomainIdentity/getIdentityVerificationAttributes/createConfigurationSet — all mockable), MJML->HTML compile (mjml npm) used at template save, and List-Unsubscribe / List-Unsubscribe-Post header builders.',
      'services/onboarding: Onboarding Lambda with three pure-cored entrypoints — start-domain (create SES domain identity + Easy DKIM + MAIL FROM subdomain, return the DNS records to publish: 3 DKIM CNAME, SPF TXT, MAIL FROM MX+SPF, recommended DMARC TXT), check-domain (run DNS lookups + read SES verification status — both injected/mocked — and return per-record pending/found/mismatch state), activate (gate: SES reports DKIM verified + required records resolve -> create the workspace Configuration Set on the SHARED IP pool -> set workspaces.status=active, sending_identity.verified=true).',
      'A Template Lambda path: compile MJML->HTML at save time and store both mjml + compiled_html in email_templates (workspace-scoped).',
      'Extend workspaces.sending_identity jsonb per §10A (from_domain, ses_identity, dkim_tokens, mail_from, dmarc_status, record_checks, verified, config_set, ip_mode=shared).',
    ],
    criteria: [
      'A workspace whose domain is not verified (status != active) cannot send; once DKIM verifies via the (mocked) SES status, activate flips status to active and enables sending from its own domain with aligned DKIM/SPF/DMARC records returned.',
      'start-domain returns the correct set of DNS records to publish (DKIM CNAMEs, SPF, MAIL FROM, DMARC); check-domain reports per-record state from mocked DNS + SES status and is the source of truth gate (SES status), not the registrar.',
      'MJML templates compile to cross-client HTML at save time; both mjml and compiled_html are stored, workspace-scoped.',
      'All onboarding state is workspace-scoped; one workspace activating never affects another.',
    ],
  },
  {
    id: 'phase7-dispatch',
    title: 'Dispatch core',
    specSections: '§9 (outbox -> second SQS queue -> Dispatcher: suppression -> frequency-cap -> quiet-hours -> SES send -> messages_log), §6 (outbox, messages_log, suppressions, email_templates), §10 (send gated on active/verified)',
    scope: [
      'services/dispatcher: SQS-triggered Lambda. For each outbox row id: load profile + template (workspace-scoped); REFUSE if the workspace is not active/verified; check suppressions for (workspace_id, email) AND global_hard_bounces (skip if suppressed); enforce per-workspace frequency cap via messages_log; enforce quiet-hours (defer/re-queue); render template + inject List-Unsubscribe headers; SES SendEmail (MOCKED) with the workspace Configuration Set / sending identity; on success write messages_log (+ usage_counters emails_sent); on failure bounded retries -> DLQ.',
      'The outbox -> second SQS queue -> Dispatcher wiring (enqueue an outbox id; Dispatcher consumes). Idempotent dedupe_key prevents double-sends.',
      'Pure functions for the decision pipeline (suppression decision, frequency-cap, quiet-hours defer) so they are unit-tested without AWS; SES mocked with aws-sdk-client-mock.',
    ],
    criteria: [
      'The Dispatcher refuses to send for a workspace whose status != active/verified.',
      'A recipient on the workspace suppression list (or in global_hard_bounces) is skipped; suppression is checked before sending.',
      'Per-workspace frequency cap holds (a recipient over the cap within the window is not sent again); quiet-hours defer/re-queue rather than send.',
      'A successful send is recorded once in messages_log (+ usage_counters emails_sent); the dedupe_key prevents double-sends on retry; SES is called with the workspace Configuration Set only after suppression/cap/quiet-hours pass.',
    ],
  },
  {
    id: 'phase8-feedback-reputation',
    title: 'Feedback + compliance + reputation policing',
    specSections: '§10 (feedback pipeline SNS->Feedback Lambda, suppression on bounce/complaint, reputation alarms + auto-suspend, one-click unsubscribe), §6 (suppressions, global_hard_bounces, email_events, messages_log, usage_counters)',
    scope: [
      'services/feedback: SNS-triggered Feedback Lambda (resolve workspace from the message/identity). Hard bounce -> suppressions (workspace_id, email, hard_bounce) + profiles.email_status=bounced + add to global_hard_bounces. Complaint -> suppressions (complaint) + email_status=complained. Soft bounce -> count; suppress after N. Record every event in email_events (workspace-scoped). Idempotent on the SES message id.',
      'Per-workspace reputation policing: compute per-workspace bounce/complaint rates from email_events and AUTO-SUSPEND a single workspace (workspaces.status=suspended) on threshold breach, WITHOUT affecting other workspaces.',
      'services/unsubscribe: one-click Unsubscribe Lambda writes suppressions (workspace_id, email, unsubscribe) — workspace-scoped, so unsubscribing from A does not affect B. Honor List-Unsubscribe-Post.',
      'Pure functions for bounce/complaint classification, soft-bounce-after-N, and the reputation threshold decision.',
    ],
    criteria: [
      'A hard bounce suppresses the email in-workspace (and is recorded in global_hard_bounces); a complaint suppresses in-workspace and sets email_status=complained.',
      'Suppression scoping: an unsubscribe in workspace A does NOT suppress the same email in workspace B.',
      'Reputation policing: a workspace exceeding bounce/complaint thresholds is auto-suspended (status=suspended) WITHOUT pausing other workspaces.',
      'The feedback handler is idempotent (re-delivered SES notifications do not double-write suppressions/email_events); soft bounces suppress only after N.',
    ],
  },
];

export async function process(inputs, ctx) {
  const targetQuality = inputs.targetQuality ?? 90;
  const maxIterations = inputs.maxIterations ?? 4;
  const startedAt = ctx.now();

  ctx.log?.('info', 'CDP email/dispatch build starting (phases 6–8, local-only, SES/SNS mocked, TDD-gated, autonomous)');

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

  // Cross-phase integration: onboarding -> activate -> dispatch -> feedback -> suppression/reputation.
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
      phase: { id: 'integration-email-dispatch', title: 'Cross-phase email/dispatch integration' },
      converged: passed, score: last?.gate?.score ?? 0,
    });
    integration = { passed, finalScore: last?.gate?.score ?? 0, iterations: iteration, commit, detail: last };
  }

  return {
    success: phaseResults.every((p) => p.converged) && integration.passed,
    phases: phaseResults,
    integration,
    duration: ctx.now() - startedAt,
    metadata: { processId: 'cdp/email-dispatch', timestamp: startedAt },
  };
}

// ============================================================================
// TASK DEFINITIONS
// ============================================================================

export const planPhaseTask = defineTask('plan-phase', (args, taskCtx) => ({
  kind: 'agent',
  title: `Plan tests: ${args.phase.title}`,
  agent: {
    name: AGENT,
    prompt: {
      role: 'senior test architect practicing TDD on a serverless multi-tenant CDP',
      task: `Turn the §18 acceptance criteria for "${args.phase.title}" into a concrete, test-first plan.`,
      context: {
        spec: SPEC, phase: args.phase, invariants: INVARIANTS,
        testingStrategy: '§16A serverless pyramid: many pure unit tests; DB-integration against REAL local Postgres (localhost:5433, no mocking the DB); thin LocalStack E2E. Mock SES/SNS and DNS/SES-status checks.',
        prior: 'Phases 2-5 are done. Reuse packages/db testutil harness (adminPool, hasDatabaseUrl, applyMigrations, runPlanInWorkspaceTx) and the SqlStatement {text,values} shape. packages/email, services/{onboarding,dispatcher,feedback,unsubscribe} are placeholder scaffolds to fill in.',
      },
      instructions: [
        `Read ${SPEC} sections: ${args.phase.specSections}, plus §16A and §18.`,
        'For each acceptance criterion, define the test file(s), tier (unit | integration | e2e), and the exact assertions — especially tenant-isolation/suppression-scoping, the verification gate, and idempotency assertions.',
        'Identify the pure functions that hold the logic (so handlers stay thin) and exactly what is mocked (SES/SNS/DNS) vs real (Postgres).',
        'List the implementation units and their dependency order.',
        'Return ONLY the JSON.',
      ],
      outputFormat: 'JSON: { testFiles: [{path, tier, criterion, assertions:[...]}], pureFunctions: string[], mocks: string[], implUnits: string[], notes: string }',
    },
    outputSchema: {
      type: 'object',
      required: ['testFiles', 'implUnits'],
      properties: {
        testFiles: { type: 'array', items: { type: 'object' } },
        pureFunctions: { type: 'array', items: { type: 'string' } },
        mocks: { type: 'array', items: { type: 'string' } },
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
      role: 'senior TypeScript engineer building a serverless multi-tenant CDP, test-first',
      task: `Implement "${args.phase.title}" to satisfy its test plan and §18 criteria. Red -> green -> refactor.`,
      context: {
        spec: SPEC, phase: args.phase, plan: args.plan, invariants: INVARIANTS,
        iteration: args.iteration, firstIteration: args.firstIteration, previousGateFeedback: args.prevFeedback,
        env: 'Real Postgres: DATABASE_URL=postgres://postgres:postgres@localhost:5433/cdp (migrations 0001-0006 applied). turbo test task is cache:false.',
      },
      instructions: [
        `Read ${SPEC} sections: ${args.phase.specSections}.`,
        args.firstIteration
          ? 'FIRST write the failing tests from the plan (red), then implement to green. Logic lives in pure injected functions; handlers only wire them up.'
          : 'Address the previousGateFeedback precisely; adjust tests/impl as needed.',
        'Honor every invariant in context.invariants — tenant isolation, suppression scoping, the verification gate, and idempotency are pass/fail.',
        'MOCK SES (SendEmail/identity/config-set), SNS, and DNS/SES-status checks (aws-sdk-client-mock + injected resolvers). NEVER send real mail or hit real DNS/SES. Integration tests run against the REAL local Postgres; do NOT mock the DB. Reuse the Phase 2-5 testutil harness.',
        'Run the relevant `pnpm test` (with DATABASE_URL set), `pnpm typecheck`, `pnpm lint`. Iterate until GREEN, including a COLD turbo run. Confirm no regression in phases 2-5. Report the actual command output summary.',
        'Implement ONLY what the cited sections require — no broadcasts/campaigns/image/frontend/metering.',
        'Return ONLY the JSON.',
      ],
      outputFormat: 'JSON: { filesCreated: string[], filesModified: string[], testsPass: boolean, testSummary: string, typecheckOk: boolean, lintOk: boolean, commandsRun: string[], notes: string }',
    },
    outputSchema: {
      type: 'object',
      required: ['filesCreated', 'filesModified', 'testsPass'],
      properties: {
        filesCreated: { type: 'array', items: { type: 'string' } },
        filesModified: { type: 'array', items: { type: 'string' } },
        testsPass: { type: 'boolean' },
        testSummary: { type: 'string' },
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
      role: 'adversarial principal reviewer + QA engineer verifying spec-fidelity, tenant isolation, and compliance',
      task: `Independently verify "${args.phase.title}" against its §18 criteria. Re-run the tests yourself (cold cache); do not trust the self-report.`,
      context: { spec: SPEC, phase: args.phase, plan: args.plan, implReport: args.impl, invariants: INVARIANTS,
        env: 'Real Postgres: DATABASE_URL=postgres://postgres:postgres@localhost:5433/cdp.' },
      instructions: [
        'Clear the turbo cache and RUN the tests yourself (DATABASE_URL set) twice from cold, plus pnpm typecheck and pnpm lint. Record real pass/fail. Confirm the integration tier RUNS (not skipped) and there is no regression in phases 2-5.',
        `Verify EACH acceptance criterion is actually covered by a passing, non-vacuous test: ${JSON.stringify(args.phase.criteria)}.`,
        'Highest-priority checks: (a) tenant isolation + suppression is per-(workspace_id,email) and never cross-workspace; (b) the verification/active gate genuinely blocks sends; (c) SES/SNS/DNS are MOCKED (no real mail/calls) yet asserted (e.g. SES SendEmail called with the right Configuration Set only AFTER suppression/cap/quiet-hours); (d) idempotency (re-delivered feedback / outbox retry does not double-write).',
        'If any integration test mocks Postgres, that is a FAIL (must use real local Postgres per §16A).',
        'Scope check: flag any feature beyond the cited sections (broadcasts/campaigns/image/frontend/metering).',
        'Score 0-100. Set testsPass and criteriaAllMet honestly. Give concrete prioritized recommendations.',
      ],
      outputFormat: 'JSON: { score: number, testsPass: boolean, criteriaAllMet: boolean, criteriaCoverage: [{criterion, met, evidence}], isolationOk: boolean, mocksOk: boolean, scopeCreep: string[], recommendations: string[], criticalIssues: string[] }',
    },
    outputSchema: {
      type: 'object',
      required: ['score', 'testsPass', 'criteriaAllMet', 'recommendations'],
      properties: {
        score: { type: 'number', minimum: 0, maximum: 100 },
        testsPass: { type: 'boolean' },
        criteriaAllMet: { type: 'boolean' },
        criteriaCoverage: { type: 'array', items: { type: 'object' } },
        isolationOk: { type: 'boolean' },
        mocksOk: { type: 'boolean' },
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
        `Commit with a clear conventional message describing the phase (${args.phase.title}), noting the gate score (${args.score}) and whether it fully converged (${args.converged}).`,
        'End the commit message body with: Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>',
        'Do NOT push. Return the resulting commit hash.',
        'Return ONLY the JSON.',
      ],
      outputFormat: 'JSON: { committed: boolean, commitHash: string, message: string }',
    },
    outputSchema: {
      type: 'object', required: ['committed'],
      properties: { committed: { type: 'boolean' }, commitHash: { type: 'string' }, message: { type: 'string' } },
    },
  },
  io: { inputJsonPath: `tasks/${taskCtx.effectId}/input.json`, outputJsonPath: `tasks/${taskCtx.effectId}/result.json` },
  labels: ['commit', args.phase.id],
}));

export const integrationTask = defineTask('integration', (args, taskCtx) => ({
  kind: 'agent',
  title: `Cross-phase email/dispatch integration (iteration ${args.iteration})`,
  agent: {
    name: AGENT,
    prompt: {
      role: 'senior engineer writing end-to-end integration tests for the email/dispatch pipeline',
      task: 'Write/repair cross-phase integration tests proving onboarding -> dispatch -> feedback work together against real local Postgres (SES/SNS mocked).',
      context: { spec: SPEC, invariants: INVARIANTS,
        phaseCriteria: args.phases.map((p) => ({ id: p.id, criteria: p.criteria })),
        previousGateFeedback: args.prevFeedback,
        env: 'Real Postgres: DATABASE_URL=postgres://postgres:postgres@localhost:5433/cdp. Extend the existing /tests integration suite.' },
      instructions: [
        `Read ${SPEC} §9, §10, §10A, §16A, §18.`,
        'Extend /tests with an end-to-end email/dispatch flow driving the REAL service cores: onboard a workspace (start-domain -> check-domain with mocked DNS/SES -> activate to status=active) -> enqueue an outbox send -> Dispatcher (SES mocked) applies suppression/cap/quiet-hours and writes messages_log -> a (mocked) SNS bounce/complaint flows through the Feedback Lambda to per-workspace suppressions + email_events + (hard bounce) global_hard_bounces -> a subsequent send to that recipient is skipped.',
        'Prove end-to-end: a workspace not yet active cannot send; suppression is per-workspace (A bounce/unsubscribe does not suppress B); a workspace breaching reputation thresholds is auto-suspended without pausing others; feedback handling is idempotent.',
        'DB is REAL; SES/SNS/DNS are mocked at the boundary. Provide/extend a single `pnpm test:integration` entrypoint. Run until green (cold); report real output. Address previousGateFeedback if present.',
        'Return ONLY the JSON.',
      ],
      outputFormat: 'JSON: { filesCreated: string[], filesModified: string[], allPass: boolean, testSummary: string, entrypoint: string, commandsRun: string[], notes: string }',
    },
    outputSchema: {
      type: 'object', required: ['filesCreated', 'allPass'],
      properties: {
        filesCreated: { type: 'array', items: { type: 'string' } },
        filesModified: { type: 'array', items: { type: 'string' } },
        allPass: { type: 'boolean' },
        testSummary: { type: 'string' },
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
  title: `Integration gate (iteration ${args.iteration})`,
  agent: {
    name: AGENT,
    prompt: {
      role: 'adversarial principal reviewer verifying the email/dispatch pipeline is production-trustworthy',
      task: 'Independently run the integration suite and confirm every phase-6-8 acceptance criterion is verified end-to-end against real Postgres with SES/SNS mocked.',
      context: { spec: SPEC, invariants: INVARIANTS, implReport: args.impl,
        phaseCriteria: args.phases.map((p) => ({ id: p.id, criteria: p.criteria })),
        env: 'Real Postgres: DATABASE_URL=postgres://postgres:postgres@localhost:5433/cdp.' },
      instructions: [
        'Independently run the integration entrypoint (cold). Record real results; do not trust the self-report. Confirm the suite uses a REAL database and that SES/SNS/DNS are mocked (no real mail/calls).',
        'Confirm each is proven by an assertion: send gated on active/verified; per-workspace suppression scoping (A does not affect B); reputation auto-suspend isolates the offender; feedback idempotency; dispatcher orders suppression->cap->quiet-hours->send.',
        'Confirm no regression in phases 2-5 and no scope creep (no broadcasts/campaigns/image/frontend/metering).',
        'Score 0-100 and set allCriteriaVerified honestly. Give concrete recommendations for any gap.',
      ],
      outputFormat: 'JSON: { score: number, allCriteriaVerified: boolean, usesRealPostgres: boolean, mocksOk: boolean, coverage: [{criterion, verified, evidence}], recommendations: string[], criticalIssues: string[] }',
    },
    outputSchema: {
      type: 'object', required: ['score', 'allCriteriaVerified', 'recommendations'],
      properties: {
        score: { type: 'number', minimum: 0, maximum: 100 },
        allCriteriaVerified: { type: 'boolean' },
        usesRealPostgres: { type: 'boolean' },
        mocksOk: { type: 'boolean' },
        coverage: { type: 'array', items: { type: 'object' } },
        recommendations: { type: 'array', items: { type: 'string' } },
        criticalIssues: { type: 'array', items: { type: 'string' } },
      },
    },
  },
  io: { inputJsonPath: `tasks/${taskCtx.effectId}/input.json`, outputJsonPath: `tasks/${taskCtx.effectId}/result.json` },
  labels: ['integration', 'quality-gate', `iteration-${args.iteration}`],
}));
