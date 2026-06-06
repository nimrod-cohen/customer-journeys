// The Dispatcher send-gate predicate (§10, CLAUDE.md invariant 7).
//
// Sending is gated on verification: a workspace may send ONLY when it is
// `active` AND its sending identity reports `verified === true`. This is the
// single predicate the Phase-7 Dispatcher consults before any SES call — it
// refuses to send for any workspace not active/verified.
import type { WorkspaceStatus } from '@cdp/shared';

/** The `workspaces.sending_identity` jsonb shape we depend on here (§10A). */
export interface SendingIdentity {
  readonly verified?: boolean;
  readonly from_domain?: string;
  readonly ses_identity?: string;
  readonly config_set?: string;
}

/** The minimal workspace shape the send-gate inspects. */
export interface SendableWorkspace {
  readonly status: WorkspaceStatus | string;
  readonly sending_identity: SendingIdentity | null | undefined;
}

/**
 * True iff the workspace is allowed to send mail. BOTH must hold:
 *   - status === 'active'
 *   - sending_identity.verified === true
 * Any other status (onboarding/suspended) or an unverified/missing identity
 * returns false. Defensive against a null/undefined sending_identity.
 */
export function canSend(workspace: SendableWorkspace): boolean {
  return (
    workspace.status === 'active' && workspace.sending_identity?.verified === true
  );
}
