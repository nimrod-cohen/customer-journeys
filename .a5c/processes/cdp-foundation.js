/**
 * @process cdp/foundation
 * @description Build the foundation (spec §17 phases 2–5) of the serverless multi-tenant
 *   marketing CDP described in CDP-BUILD-SPEC.md. Test-first (§16A), quality-gated, fully
 *   autonomous, verified against LOCAL emulation only (LocalStack + Supabase CLI per §15).
 *
 *   Flow:
 *     1. Scaffold the pnpm + Turborepo + Vitest monorepo (§19) + db package (§6 schema/RLS).
 *     2. For each phase 2–5: plan tests from §18 criteria -> TDD convergence loop
 *        (implement -> independent quality gate) until the gate passes or maxIterations.
 *     3. Cross-phase integration + final verification against local Postgres (the widest
 *        loop available pre-frontend: real RLS/ordering/idempotency, NOT mocked — §16A).
 *
 * @inputs { targetQuality?: number, maxIterations?: number }
 * @outputs { success: boolean, phases: array, integration: object }
 */

import { defineTask } from '@a5c-ai/babysitter-sdk';

const SPEC = 'CDP-BUILD-SPEC.md';
const AGENT = 'general-purpose'; // only general-purpose subagent is installed in this repo

// Cross-cutting invariants every agent must honor (echoes CLAUDE.md "Non-negotiable invariants").
const INVARIANTS = [
  'Tenant isolation is the top property: every tenant-scoped row carries workspace_id NOT NULL; every query filters by workspace_id.',
  'Service-role Lambda code bypasses RLS — it MUST scope by workspace_id in code; RLS is only the backstop for user-context (admin app) reads.',
  'workspace_id is NEVER taken from a client payload — derive it from the API key (ingest) or the authorizer-injected claim (admin API).',
  'Per-profile ordering via MessageGroupId=profile_id; code must be idempotent and order-convergent (progress-before-profile_created still converges).',
  'Idempotency: events.event_id is the dedupe key (INSERT ... ON CONFLICT DO NOTHING).',
  'Segment rule-AST -> SQL is compiled with a field/operator whitelist, parameterized SQL only, and ALWAYS prepends workspace_id = $ws. Never interpolate raw input.',
  'Local-only: verify against LocalStack + Supabase CLI/Testcontainers. Do NOT mock Postgres in the integration tier. Mock SES (never send real mail).',
  'Scope discipline: implement exactly what the cited spec sections require — no extra features, no gold-plating.',
];

// The foundation phases (spec §17). Each maps to §18 acceptance criteria that become tests first.
const PHASES = [
  {
    id: 'phase2-auth',
    title: 'Auth + authorizer + roles',
    specSections: '§3 (multi-tenancy + RLS caveat), §3A (4-role model), §6 (workspaces, workspace_users, platform_admins, admin_audit_log, workspace_api_keys), §12 (role-aware API), §13 (security)',
    scope: [
      'packages/db: workspaces, workspace_users, platform_admins, admin_audit_log, workspace_api_keys tables + RLS policies (workspace_id = auth.jwt()->>workspace_id) with the narrow system-admin (is_platform_admin) exception.',
      'packages/tenancy: workspace-context + role-check helpers (owner/marketer/accounting capability matrix from §3A).',
      'services/authorizer: Lambda authorizer that validates a Supabase JWT (JWKS), resolves workspace membership + role (or is_platform_admin), and injects workspace_id + role into request context. Logic in a pure injected function.',
      'Multi-workspace membership + active-workspace switching (claim re-issue).',
    ],
    criteria: [
      'A Workspace-A JWT cannot read/modify Workspace-B rows under RLS; service-role code paths still scope by workspace_id in code.',
      'Two workspaces with the same external_id/email keep fully separate profiles (UNIQUE(workspace_id, external_id)).',
      'Roles (§3A): marketer cannot manage users/domains/billing; accounting can read billing but cannot edit segments/campaigns; owner can do both within the workspace.',
      'system-admin can view across companies and every cross-tenant access is recorded in admin_audit_log.',
      'Multi-workspace switching: a user in two workspaces sees only the active workspace; switching changes the workspace_id claim and re-scopes; no cross-bleed.',
    ],
  },
  {
    id: 'phase3-ingest',
    title: 'Ingestion + tenancy + ordering',
    specSections: '§7 (event envelope, ingest, processor, ordering), §6 (events, profiles)',
    scope: [
      'API Gateway REST request model + per-workspace API key resolution (workspace_api_keys).',
      'services/ingest: resolve workspace_id from API key (never payload), upsert profile by (workspace_id, external_id), enqueue SQS FIFO (MessageGroupId=profile_id, MessageDeduplicationId=event_id, workspace_id in body), return 200 only after SQS accepts.',
      'services/processor: FIFO consumer — INSERT events ON CONFLICT(event_id) DO NOTHING, upsert profile (stub if progress arrives first), workspace-scoped throughout, DLQ on repeated failure.',
      'Logic in pure injected functions; mock SQS/AWS with aws-sdk-client-mock; integration against local Postgres.',
    ],
    criteria: [
      'profile_created then immediately progress (same external_id+workspace) -> profile exists, progress applied, in order.',
      'progress-first -> idempotent upsert still correct (stub profile created, converges).',
      'No loss: forced Processor failures retried then processed or sent to DLQ; none vanish.',
      'Idempotency: repeated event_id applied once.',
      'An API key for Workspace A can only create events in Workspace A.',
    ],
  },
  {
    id: 'phase4-profiles',
    title: 'Profiles + features',
    specSections: '§6 (profile_features), §7 step 3 (update profile_features, scoped)',
    scope: [
      'packages/db: profile_features table.',
      'processor feature-update step: total_events, last_event_at, last_email_open_at, counters (jsonb rolling aggregates), monetary_total — all workspace-scoped, idempotent under event replay.',
      'Pure, unit-tested aggregate-update functions.',
    ],
    criteria: [
      'Feature aggregates update correctly and idempotently as events are processed (replaying an event does not double-count).',
      'profile_features rows are always workspace-scoped and never mix workspaces.',
    ],
  },
  {
    id: 'phase5-segments',
    title: 'Segmentation engine',
    specSections: '§8 (rule AST + SQL compiler, dynamic realtime/batch, manual), §6 (segments, segment_memberships, segment_change_log)',
    scope: [
      'packages/segments: rule-AST -> parameterized SQL WHERE compiler over profiles JOIN profile_features, with a field/operator WHITELIST and workspace_id = $ws ALWAYS prepended. Reject unknown fields/operators.',
      'Dynamic realtime eval in the processor on profile change; dynamic batch eval (EventBridge-style scheduled entrypoint); membership diff + segment_change_log (entered/exited).',
      'Manual segments: membership rows (source=manual) added/removed by user (hand-pick + CSV import); evaluator never touches them.',
    ],
    criteria: [
      'Given an AST, the compiler emits the exact parameterized SQL, ALWAYS injects workspace_id, and REJECTS unknown fields/operators (security-critical).',
      'Crossing a predicate -> exactly one entered; crossing back -> one exited; never matches another workspace\'s profiles.',
      'Manual segments change only via user edit/CSV and are not touched by the evaluator; both dynamic and manual are usable as audiences.',
    ],
  },
];

export async function process(inputs, ctx) {
  const targetQuality = inputs.targetQuality ?? 90;
  const maxIterations = inputs.maxIterations ?? 4;
  const startedAt = ctx.now();

  ctx.log?.('info', 'CDP foundation build starting (phases 2–5, local-only, TDD-gated, autonomous)');

  // ==========================================================================
  // STEP 0: SCAFFOLD the monorepo + db package, converge until the gate passes.
  // ==========================================================================
  let scaffold;
  {
    let iteration = 0;
    let prevFeedback = null;
    let passed = false;
    while (iteration < maxIterations && !passed) {
      iteration++;
      const impl = await ctx.task(scaffoldTask, { iteration, prevFeedback });
      const gate = await ctx.task(scaffoldGateTask, { iteration, impl });
      scaffold = { iteration, impl, gate };
      if (gate.score >= targetQuality && gate.installOk && gate.typecheckOk) passed = true;
      else prevFeedback = gate.recommendations;
    }
    if (!passed) {
      ctx.log?.('warn', 'Scaffold did not reach target quality; proceeding with best effort.');
    }
  }

  // ==========================================================================
  // STEP 1: PHASES 2–5 — each a test-first convergence loop with an independent gate.
  // ==========================================================================
  const phaseResults = [];
  for (const phase of PHASES) {
    // Plan the tests (map §18 criteria -> concrete test files) before any implementation.
    const plan = await ctx.task(planPhaseTask, { phase });

    let iteration = 0;
    let prevFeedback = null;
    let converged = false;
    let last = null;
    const history = [];

    while (iteration < maxIterations && !converged) {
      iteration++;
      const impl = await ctx.task(implementPhaseTask, {
        phase, plan, iteration, prevFeedback,
        firstIteration: iteration === 1,
      });
      const gate = await ctx.task(qualityGateTask, { phase, plan, impl, iteration });
      last = { iteration, impl, gate };
      history.push(last);
      if (gate.score >= targetQuality && gate.testsPass && gate.criteriaAllMet) {
        converged = true;
      } else {
        prevFeedback = gate.recommendations;
      }
    }

    // Commit the phase's work so progress is durable regardless of later phases.
    const commit = await ctx.task(commitPhaseTask, { phase, converged, score: last?.gate?.score ?? 0 });

    phaseResults.push({
      id: phase.id, title: phase.title,
      converged, finalScore: last?.gate?.score ?? 0,
      iterations: iteration, commit, history,
    });
  }

  // ==========================================================================
  // STEP 2: CROSS-PHASE INTEGRATION + FINAL VERIFICATION (widest available loop:
  // real local Postgres for isolation/ordering/idempotency; mocked AWS for wiring).
  // ==========================================================================
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
      phase: { id: 'integration', title: 'Cross-phase integration + verification' },
      converged: passed, score: last?.gate?.score ?? 0,
    });
    integration = { passed, finalScore: last?.gate?.score ?? 0, iterations: iteration, commit, detail: last };
  }

  return {
    success: phaseResults.every((p) => p.converged) && integration.passed,
    phases: phaseResults,
    integration,
    duration: ctx.now() - startedAt,
    metadata: { processId: 'cdp/foundation', timestamp: startedAt },
  };
}

// ============================================================================
// TASK DEFINITIONS
// ============================================================================

export const scaffoldTask = defineTask('scaffold-monorepo', (args, taskCtx) => ({
  kind: 'agent',
  title: `Scaffold monorepo (iteration ${args.iteration})`,
  agent: {
    name: AGENT,
    prompt: {
      role: 'senior platform engineer setting up a TypeScript serverless monorepo',
      task: 'Scaffold the CDP monorepo and the database package so all later phases build cleanly.',
      context: {
        spec: SPEC,
        readSections: ['§4 (stack)', '§6 (full SQL data model + RLS)', '§14 (CDK)', '§15 (local dev)', '§19 (repo structure)'],
        tooling: 'pnpm workspaces + Turborepo + Vitest + TypeScript (strict). AWS CDK (TypeScript) for /infra.',
        environment: 'LOCAL ONLY — Supabase CLI for Postgres + migrations + RLS; LocalStack for SQS/S3/SNS/API GW. Docker-based.',
        invariants: INVARIANTS,
        previousGateFeedback: args.prevFeedback,
      },
      instructions: [
        `Read ${SPEC} sections §4, §6, §14, §15, §19 before doing anything.`,
        'Create the §19 layout: /infra, /services/{ingest,processor,dispatcher,broadcast,campaign-runner,feedback,unsubscribe,image,onboarding,batch-eval,metering,api,authorizer}, /packages/{shared,db,segments,email,tenancy}, /web, /scripts, /tests. Service/package dirs that belong to later phases may be created empty with a placeholder package.json.',
        'Root: pnpm-workspace.yaml, turbo.json (build/test/typecheck/lint pipelines), root package.json with scripts (build, test, typecheck, lint), strict tsconfig base, vitest config, .gitignore (node_modules, .env*, dist, coverage, .a5c/runs/*/state, supabase/.temp, cdk.out).',
        'packages/db: encode the ENTIRE §6 SQL schema as ordered migration files (UUID PKs, timestamptz, citext, RLS ENABLED on every tenant-scoped table with policy workspace_id = (auth.jwt()->>workspace_id)::uuid plus the narrow is_platform_admin exception, workspace_id as the leading index column). Provide a pooled pg client helper. Wire Supabase CLI config (supabase/config.toml) and a script to start local Postgres + apply migrations.',
        'Add a docker-compose or scripts for LocalStack (SQS/S3/SNS). Add aws-sdk-client-mock and supabase/testcontainers dev deps for the test tiers (§16A).',
        'Run `pnpm install` and `pnpm typecheck` (and `pnpm -w build` if defined). Fix issues until both succeed. Do NOT write feature/business logic yet — only scaffolding + the db schema/migrations.',
        'If addressing previousGateFeedback, fix exactly those items.',
        'Return ONLY the JSON result described in outputFormat — concise, no prose.',
      ],
      outputFormat: 'JSON: { filesCreated: string[], scripts: object, installOk: boolean, typecheckOk: boolean, notes: string, commandsRun: string[] }',
    },
    outputSchema: {
      type: 'object',
      required: ['filesCreated', 'installOk', 'typecheckOk'],
      properties: {
        filesCreated: { type: 'array', items: { type: 'string' } },
        scripts: { type: 'object' },
        installOk: { type: 'boolean' },
        typecheckOk: { type: 'boolean' },
        notes: { type: 'string' },
        commandsRun: { type: 'array', items: { type: 'string' } },
      },
    },
  },
  io: { inputJsonPath: `tasks/${taskCtx.effectId}/input.json`, outputJsonPath: `tasks/${taskCtx.effectId}/result.json` },
  labels: ['scaffold', `iteration-${args.iteration}`],
}));

export const scaffoldGateTask = defineTask('scaffold-gate', (args, taskCtx) => ({
  kind: 'agent',
  title: `Scaffold quality gate (iteration ${args.iteration})`,
  agent: {
    name: AGENT,
    prompt: {
      role: 'principal engineer reviewing project scaffolding for correctness and spec-fidelity',
      task: 'Independently verify the scaffold: install works, typecheck passes, layout matches §19, db schema matches §6 with RLS, no premature feature code.',
      context: { spec: SPEC, invariants: INVARIANTS, implReport: args.impl },
      instructions: [
        `Independently RUN: pnpm install, pnpm typecheck (and pnpm -w build if present). Do not trust the implementer's self-report — verify.`,
        `Open packages/db migrations and confirm EVERY §6 tenant-scoped table exists with workspace_id NOT NULL, RLS enabled, the correct policy + narrow is_platform_admin exception, and workspace_id-leading indexes.`,
        'Confirm the §19 directory layout and that pnpm-workspace.yaml + turbo.json + vitest are wired. Confirm Supabase CLI + LocalStack local-dev scripts exist.',
        'Confirm NO business/feature logic was written yet (scaffolding + schema only).',
        'Score 0-100. List concrete, prioritized recommendations for anything missing or wrong.',
      ],
      outputFormat: 'JSON: { score: number, installOk: boolean, typecheckOk: boolean, layoutOk: boolean, schemaOk: boolean, recommendations: string[], criticalIssues: string[] }',
    },
    outputSchema: {
      type: 'object',
      required: ['score', 'installOk', 'typecheckOk', 'recommendations'],
      properties: {
        score: { type: 'number', minimum: 0, maximum: 100 },
        installOk: { type: 'boolean' },
        typecheckOk: { type: 'boolean' },
        layoutOk: { type: 'boolean' },
        schemaOk: { type: 'boolean' },
        recommendations: { type: 'array', items: { type: 'string' } },
        criticalIssues: { type: 'array', items: { type: 'string' } },
      },
    },
  },
  io: { inputJsonPath: `tasks/${taskCtx.effectId}/input.json`, outputJsonPath: `tasks/${taskCtx.effectId}/result.json` },
  labels: ['scaffold', 'quality-gate', `iteration-${args.iteration}`],
}));

export const planPhaseTask = defineTask('plan-phase', (args, taskCtx) => ({
  kind: 'agent',
  title: `Plan tests: ${args.phase.title}`,
  agent: {
    name: AGENT,
    prompt: {
      role: 'senior test architect practicing TDD on a serverless multi-tenant system',
      task: `Turn the §18 acceptance criteria for "${args.phase.title}" into a concrete, test-first plan.`,
      context: {
        spec: SPEC, phase: args.phase, invariants: INVARIANTS,
        testingStrategy: '§16A serverless pyramid: many pure unit tests; DB-integration tests against REAL local Postgres (no mocking the DB); thin LocalStack E2E. Mock SES.',
      },
      instructions: [
        `Read ${SPEC} sections: ${args.phase.specSections}, plus §16A and §18.`,
        'For each acceptance criterion, define the test file(s), tier (unit | integration | e2e), and the exact assertions — especially the tenant-isolation and ordering/idempotency assertions.',
        'Identify the pure functions that should hold the logic (so handlers stay thin and unit-testable).',
        'List the implementation units required and their dependency order.',
        'Return ONLY the JSON.',
      ],
      outputFormat: 'JSON: { testFiles: [{path, tier, criterion, assertions:[...]}], pureFunctions: string[], implUnits: string[], notes: string }',
    },
    outputSchema: {
      type: 'object',
      required: ['testFiles', 'implUnits'],
      properties: {
        testFiles: { type: 'array', items: { type: 'object' } },
        pureFunctions: { type: 'array', items: { type: 'string' } },
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
        iteration: args.iteration, firstIteration: args.firstIteration,
        previousGateFeedback: args.prevFeedback,
      },
      instructions: [
        `Read ${SPEC} sections: ${args.phase.specSections}.`,
        args.firstIteration
          ? 'FIRST write the failing tests from the plan (red), then implement to green. Logic lives in pure injected functions; handlers only wire them up.'
          : 'Address the previousGateFeedback precisely; adjust tests/impl as needed.',
        'Honor every invariant in context.invariants — tenant isolation and the workspace_id rules are pass/fail.',
        'Integration tests MUST run against a real local Postgres (Supabase CLI/Testcontainers); do NOT mock the DB. Mock SES and AWS SDK (aws-sdk-client-mock).',
        'Run `pnpm test` (the relevant package/filter), `pnpm typecheck`, `pnpm lint`. Iterate until tests are GREEN. Report the actual command output summary.',
        'Implement ONLY what the cited sections require — no out-of-scope features.',
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
      role: 'adversarial principal reviewer + QA engineer verifying spec-fidelity and tenant isolation',
      task: `Independently verify "${args.phase.title}" against its §18 criteria. Re-run the tests yourself; do not trust the self-report.`,
      context: { spec: SPEC, phase: args.phase, plan: args.plan, implReport: args.impl, invariants: INVARIANTS },
      instructions: [
        `Independently RUN the tests (pnpm test for the phase scope), pnpm typecheck, pnpm lint. Record real pass/fail.`,
        `Verify EACH acceptance criterion is actually covered by a passing test: ${JSON.stringify(args.phase.criteria)}.`,
        'Tenant-isolation review (highest priority): confirm workspace_id scoping in code on every query, that RLS policies are correct, that service-role paths still scope in code, and that workspace_id is never read from client input. For phase5, verify the SQL compiler whitelists fields/operators, parameterizes, and ALWAYS injects workspace_id.',
        'Scope check: flag any feature implemented beyond the cited spec sections.',
        'If integration tests mock Postgres, that is a FAIL (must use real local Postgres per §16A).',
        'Score 0-100. Set testsPass and criteriaAllMet honestly. Give concrete prioritized recommendations.',
      ],
      outputFormat: 'JSON: { score: number, testsPass: boolean, criteriaAllMet: boolean, criteriaCoverage: [{criterion, met:boolean, evidence}], isolationOk: boolean, scopeCreep: string[], recommendations: string[], criticalIssues: string[] }',
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
      type: 'object',
      required: ['committed'],
      properties: { committed: { type: 'boolean' }, commitHash: { type: 'string' }, message: { type: 'string' } },
    },
  },
  io: { inputJsonPath: `tasks/${taskCtx.effectId}/input.json`, outputJsonPath: `tasks/${taskCtx.effectId}/result.json` },
  labels: ['commit', args.phase.id],
}));

export const integrationTask = defineTask('integration', (args, taskCtx) => ({
  kind: 'agent',
  title: `Cross-phase integration tests (iteration ${args.iteration})`,
  agent: {
    name: AGENT,
    prompt: {
      role: 'senior engineer writing end-to-end integration tests for a multi-tenant pipeline',
      task: 'Write/repair cross-phase integration + thin E2E tests proving the foundation works together against real local Postgres.',
      context: {
        spec: SPEC, invariants: INVARIANTS,
        phaseCriteria: args.phases.map((p) => ({ id: p.id, criteria: p.criteria })),
        previousGateFeedback: args.prevFeedback,
      },
      instructions: [
        `Read ${SPEC} §16A (testing) and §18 (acceptance).`,
        'Build the /tests integration + thin E2E layer: ingest(API key -> workspace) -> SQS FIFO -> Processor -> profile/features -> segment membership + change_log, all workspace-scoped.',
        'Prove the end-to-end guarantees against a REAL local Postgres (Supabase CLI/Testcontainers): tenant isolation across two workspaces with overlapping external_ids; profile_created->progress AND progress-first convergence; repeated event_id applied once; segment enter/exit fires exactly once and never matches another workspace.',
        'Mock SES/AWS only at the boundaries (aws-sdk-client-mock); the DB must be real.',
        'Provide a single `pnpm test:integration` (or turbo task) entrypoint that boots local Postgres, applies migrations, and runs the suite. Run it until green; report real output.',
        'Address previousGateFeedback if present. Return ONLY the JSON.',
      ],
      outputFormat: 'JSON: { filesCreated: string[], filesModified: string[], allPass: boolean, testSummary: string, entrypoint: string, commandsRun: string[], notes: string }',
    },
    outputSchema: {
      type: 'object',
      required: ['filesCreated', 'allPass'],
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
      role: 'adversarial principal reviewer verifying the foundation is production-trustworthy',
      task: 'Independently run the integration suite and confirm every foundation acceptance criterion is verified end-to-end against real Postgres.',
      context: {
        spec: SPEC, invariants: INVARIANTS, implReport: args.impl,
        phaseCriteria: args.phases.map((p) => ({ id: p.id, criteria: p.criteria })),
      },
      instructions: [
        'Independently boot local Postgres + run the integration entrypoint. Record real results; do not trust the self-report.',
        'Confirm the suite actually uses a REAL database (not mocked) and that isolation, ordering, idempotency, and segment enter/exit are each proven by an assertion.',
        'Confirm SES/AWS are mocked (no real mail/calls).',
        'Score 0-100 and set allCriteriaVerified honestly. Give concrete recommendations for any gap.',
      ],
      outputFormat: 'JSON: { score: number, allCriteriaVerified: boolean, usesRealPostgres: boolean, coverage: [{criterion, verified:boolean, evidence}], recommendations: string[], criticalIssues: string[] }',
    },
    outputSchema: {
      type: 'object',
      required: ['score', 'allCriteriaVerified', 'recommendations'],
      properties: {
        score: { type: 'number', minimum: 0, maximum: 100 },
        allCriteriaVerified: { type: 'boolean' },
        usesRealPostgres: { type: 'boolean' },
        coverage: { type: 'array', items: { type: 'object' } },
        recommendations: { type: 'array', items: { type: 'string' } },
        criticalIssues: { type: 'array', items: { type: 'string' } },
      },
    },
  },
  io: { inputJsonPath: `tasks/${taskCtx.effectId}/input.json`, outputJsonPath: `tasks/${taskCtx.effectId}/result.json` },
  labels: ['integration', 'quality-gate', `iteration-${args.iteration}`],
}));
