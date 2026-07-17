// parseProfileEnrollmentTrigger (pure): a profile-change row + profile-trigger
// automations → enrollment intents. A 'created' row matches profileChange in
// {created, any}; an 'updated' row matches {updated, any}; tenant isolation drops a
// cross-workspace automation; a falsy workspace_id throws.
import { describe, it, expect } from 'vitest';
import {
  parseProfileEnrollmentTrigger,
  type ProfileChangeRow,
  type ProfileAutomationTriggerRow,
} from '../src/core.js';

const WS = 'ws-1';
const PROF = 'prof-1';

const camp = (
  id: string,
  profileChange: ProfileAutomationTriggerRow['profileChange'],
  workspace_id = WS,
): ProfileAutomationTriggerRow => ({ id, workspace_id, start_node: 'trig', profileChange });

const row = (change: ProfileChangeRow['change']): ProfileChangeRow => ({
  workspace_id: WS,
  profile_id: PROF,
  change,
});

describe('parseProfileEnrollmentTrigger', () => {
  it('a CREATED row enrolls automations with profileChange created OR any (not updated-only)', () => {
    const intents = parseProfileEnrollmentTrigger(row('created'), [
      camp('c-created', 'created'),
      camp('c-any', 'any'),
      camp('c-updated', 'updated'),
    ]);
    expect(intents.map((i) => i.automationId).sort()).toEqual(['c-any', 'c-created']);
    expect(intents[0]!.startNode).toBe('trig');
    expect(intents.every((i) => i.workspaceId === WS && i.profileId === PROF)).toBe(true);
    // No event state persisted on a profile trigger.
    expect(intents.every((i) => i.event === undefined)).toBe(true);
  });

  it('an UPDATED row enrolls automations with profileChange updated OR any (not created-only)', () => {
    const intents = parseProfileEnrollmentTrigger(row('updated'), [
      camp('c-created', 'created'),
      camp('c-any', 'any'),
      camp('c-updated', 'updated'),
    ]);
    expect(intents.map((i) => i.automationId).sort()).toEqual(['c-any', 'c-updated']);
  });

  it('TENANT ISOLATION: a automation in a different workspace is dropped', () => {
    const intents = parseProfileEnrollmentTrigger(row('created'), [camp('c-other', 'any', 'ws-2')]);
    expect(intents).toHaveLength(0);
  });

  it('THROWS on a falsy workspace_id', () => {
    expect(() =>
      parseProfileEnrollmentTrigger({ workspace_id: '', profile_id: PROF, change: 'created' }, []),
    ).toThrow(/workspace_id/);
  });
});
