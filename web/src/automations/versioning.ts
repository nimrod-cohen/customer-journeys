// Pure helpers for the automation VERSIONING UI (§9B builder). The builder edits a
// DRAFT (the in-progress working copy) and publishes append-only VERSIONS. These
// functions hold the no-I/O decisions the screen needs:
//   - backfillAllowed(def): may a publish backfill existing profiles? Only when the
//     trigger is segment_entry WITH a segment selected (else forward-only).
//   - draftDiffersFrom(a, b): does the local model differ from the last published
//     definition? (drives the "unsaved draft" indicator). Compares the SERIALIZED
//     DSL so node-order / key-order noise never trips a false "dirty".
// Everything here is pure and unit-tested first; the screen wires these to state.
import type { AutomationDefinition } from './model.js';

/** A automation's publish scope — forward (new entrants only) or backfill (also
 *  enroll the segment's CURRENT members). */
export type PublishScope = 'forward' | 'backfill';

/**
 * Whether a publish of `def` may offer BACKFILL. Backfill enrolls the current
 * members of the trigger segment, so it is only meaningful when the start node is
 * a `segment_entry` trigger AND a `triggerSegmentId` is selected. Event / manual /
 * segment-exit triggers are forward-only (there is no "current membership" to
 * enroll). Mirrors the server's `shouldBackfill` gate.
 */
export function backfillAllowed(def: AutomationDefinition, triggerSegmentId: string | null): boolean {
  if (!triggerSegmentId) return false;
  const start = def.nodes[def.startNode] as { type?: string; kind?: string } | undefined;
  return start?.type === 'trigger' && start.kind === 'segment_entry';
}

/**
 * Whether the local working copy differs from the last PUBLISHED definition (the
 * live one). Returns true when there is no published baseline yet (a never-published
 * draft is always "unsaved"). Compares the canonical JSON so re-ordered keys / nodes
 * don't read as a spurious change — buildDefinition is deterministic per graph, and
 * the live definition came from the same serializer.
 */
export function draftDiffersFrom(
  localDefinition: AutomationDefinition,
  liveDefinition: AutomationDefinition | null | undefined,
  localTriggerSegmentId: string | null,
  liveTriggerSegmentId: string | null,
  localTriggerOn?: 'enter' | 'exit',
  liveTriggerOn?: 'enter' | 'exit',
): boolean {
  if (!liveDefinition) return true;
  if ((localTriggerSegmentId ?? null) !== (liveTriggerSegmentId ?? null)) return true;
  // The trigger DIRECTION (enter|exit) is part of the draft — a change marks it dirty.
  if (localTriggerOn !== undefined && (localTriggerOn ?? 'enter') !== (liveTriggerOn ?? 'enter')) return true;
  return stableStringify(localDefinition) !== stableStringify(liveDefinition);
}

/** Deterministic JSON: object keys sorted recursively so key-order never matters. */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortDeep(value));
}

function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      out[k] = sortDeep((value as Record<string, unknown>)[k]);
    }
    return out;
  }
  return value;
}
