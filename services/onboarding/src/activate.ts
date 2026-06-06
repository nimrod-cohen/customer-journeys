// activate entrypoint (§10A step 4). Thin wiring: re-run the domain check, apply
// the pure activate gate (SES DKIM SUCCESS + required DNS resolved), and ONLY
// when allowed create the workspace's Configuration Set on the shared pool and
// flip status→active + verified=true in one workspace-scoped tx (one row).
import {
  activateDecision,
  buildActivateUpdate,
  type ActivateDecision,
  type SqlStatement,
} from './core.js';
import { checkDomain, type CheckDomainDeps } from './check-domain.js';
import type { SesEmailClient } from '@cdp/email';

/** Run a set of statements inside ONE workspace-scoped transaction. */
export type RunInWorkspaceTx = (
  workspaceId: string,
  statements: readonly SqlStatement[],
) => Promise<void>;

/** Injected dependencies for activate (superset of check-domain's). */
export interface ActivateDeps extends CheckDomainDeps {
  readonly ses: SesEmailClient;
  readonly runInWorkspaceTx: RunInWorkspaceTx;
  /** Derive the Configuration Set name for a workspace (default impl in deps.ts). */
  readonly configSetName: (workspaceId: string) => string;
}

export interface ActivateInput {
  readonly workspaceId: string;
}

export interface ActivateOutput {
  readonly decision: ActivateDecision;
}

/**
 * Attempt activation. Re-runs the live domain check, then the pure gate:
 *   - SES DKIM must be SUCCESS (the gate — NOT DNS), AND
 *   - required non-DKIM DNS records (SPF + MAIL FROM) must resolve.
 * When allowed: create the Configuration Set on the shared pool (idempotent at
 * the SES layer) and commit status='active' + verified=true (one row, scoped).
 * When denied: NO Configuration Set is created and NO status change is made.
 */
export async function activate(
  deps: ActivateDeps,
  input: ActivateInput,
): Promise<ActivateOutput> {
  if (!input.workspaceId) {
    throw new Error('activate: workspaceId is required (tenant-isolation guard)');
  }
  const check = await checkDomain(deps, { workspaceId: input.workspaceId });
  const configSet = deps.configSetName(input.workspaceId);
  const decision = activateDecision(check.dkimStatus, check, configSet);

  if (!decision.allowed) {
    return { decision };
  }

  // Allowed → create the Configuration Set on the shared pool, then flip status.
  await deps.ses.createConfigurationSet(decision.configSetName!);
  const update = buildActivateUpdate(
    input.workspaceId,
    decision.configSetName!,
    check.recordChecks,
  );
  await deps.runInWorkspaceTx(input.workspaceId, [update]);

  return { decision };
}
