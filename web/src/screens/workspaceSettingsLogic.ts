// Pure save logic for the Workspace settings timezone picker, extracted so it is
// unit-testable without a DOM (web unit tests are pure-logic). The picker sets the
// value OPTIMISTICALLY, then PUTs; on failure it rolls back to the previous value
// and surfaces a toast (never a native alert) — mirroring toggleLinkTracking.
import type { ToastTone } from '../ui/toast.tsx';

export interface SaveTimezoneDeps {
  /** The value to revert to if the PUT fails. */
  readonly previous: string;
  /** Commit/rollback the displayed value (the controlled Select state setter). */
  readonly setTimezone: (tz: string) => void;
  /** The api.put binding: PUT /workspace/settings. */
  readonly put: (path: string, opts: { body: unknown }) => Promise<unknown>;
  /** Toast surface (showToast). */
  readonly toast: (message: string, opts?: { tone?: ToastTone }) => void;
}

/**
 * Persist the workspace timezone. The caller has already set the optimistic value;
 * this PUTs it and, on failure, rolls back + toasts. Returns the PUT promise so the
 * kit Button auto-locks while in flight (standing button rule).
 */
export async function saveWorkspaceTimezone(timezone: string, deps: SaveTimezoneDeps): Promise<void> {
  try {
    await deps.put('/workspace/settings', { body: { timezone } });
  } catch {
    deps.setTimezone(deps.previous); // revert optimistic change
    deps.toast('Could not save the timezone — please try again.', { tone: 'error' });
  }
}

/** The PUBLIC unsubscribe/preference-center page language setting. */
export type FrontFacingLanguage = 'auto' | 'en' | 'he';

export interface SaveLanguageDeps {
  /** The value to revert to if the PUT fails. */
  readonly previous: FrontFacingLanguage;
  /** Commit/rollback the displayed value (the controlled Select state setter). */
  readonly setLanguage: (lang: FrontFacingLanguage) => void;
  /** The api.put binding: PUT /workspace/settings. */
  readonly put: (path: string, opts: { body: unknown }) => Promise<unknown>;
  /** Toast surface (showToast). */
  readonly toast: (message: string, opts?: { tone?: ToastTone }) => void;
}

/**
 * Persist the workspace front-facing language. The caller has already set the
 * optimistic value; this PUTs it and, on failure, rolls back + toasts. Returns the
 * PUT promise so the kit Button auto-locks while in flight (standing button rule).
 */
export async function saveWorkspaceLanguage(
  language: FrontFacingLanguage,
  deps: SaveLanguageDeps,
): Promise<void> {
  try {
    await deps.put('/workspace/settings', { body: { front_facing_language: language } });
  } catch {
    deps.setLanguage(deps.previous); // revert optimistic change
    deps.toast('Could not save the language — please try again.', { tone: 'error' });
  }
}
