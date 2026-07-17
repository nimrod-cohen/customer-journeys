import { describe, it, expect } from 'vitest';
import {
  decideReenrollment,
  parseEnrollmentTrigger,
  parseKeepWhileInCancellations,
  buildEnrollmentCancel,
  type SegmentChangeLogRow,
  type AutomationTriggerRow,
  type AutomationKeepRow,
} from '../src/core.js';

describe('decideReenrollment', () => {
  it("default 'once': enrolls only when no existing row", () => {
    expect(decideReenrollment(false)).toBe(true);
    expect(decideReenrollment(true)).toBe(false);
  });
  it("'always' allows re-entry", () => {
    expect(decideReenrollment(true, 'always')).toBe(true);
  });
});

describe('parseEnrollmentTrigger', () => {
  const automations: AutomationTriggerRow[] = [
    { id: 'c1', workspace_id: 'ws', trigger_segment_id: 'seg-A', start_node: 't' },
    { id: 'c2', workspace_id: 'ws', trigger_segment_id: 'seg-B', start_node: 't' },
    { id: 'c3', workspace_id: 'other', trigger_segment_id: 'seg-A', start_node: 't' },
  ];

  it("'entered' yields an intent per matching automation (same ws + trigger_segment_id)", () => {
    const row: SegmentChangeLogRow = {
      workspace_id: 'ws',
      segment_id: 'seg-A',
      profile_id: 'p1',
      action: 'entered',
    };
    const intents = parseEnrollmentTrigger(row, automations);
    expect(intents).toEqual([
      { workspaceId: 'ws', automationId: 'c1', profileId: 'p1', startNode: 't' },
    ]);
  });

  it("'exited' yields no intents", () => {
    const row: SegmentChangeLogRow = {
      workspace_id: 'ws',
      segment_id: 'seg-A',
      profile_id: 'p1',
      action: 'exited',
    };
    expect(parseEnrollmentTrigger(row, automations)).toEqual([]);
  });

  it('does not cross workspaces (automation c3 in another ws is ignored)', () => {
    const row: SegmentChangeLogRow = {
      workspace_id: 'ws',
      segment_id: 'seg-A',
      profile_id: 'p1',
      action: 'entered',
    };
    const intents = parseEnrollmentTrigger(row, automations);
    expect(intents.map((i) => i.automationId)).toEqual(['c1']);
  });

  it('throws on a falsy workspace_id', () => {
    const row = { workspace_id: '', segment_id: 's', profile_id: 'p', action: 'entered' };
    expect(() => parseEnrollmentTrigger(row as SegmentChangeLogRow, automations)).toThrow();
  });

  describe('trigger_on enter/exit', () => {
    const enterC: AutomationTriggerRow = { id: 'enter', workspace_id: 'ws', trigger_segment_id: 'seg-A', start_node: 't', trigger_on: 'enter' };
    const exitC: AutomationTriggerRow = { id: 'exit', workspace_id: 'ws', trigger_segment_id: 'seg-A', start_node: 't', trigger_on: 'exit' };
    const both = [enterC, exitC];
    const row = (action: string): SegmentChangeLogRow => ({ workspace_id: 'ws', segment_id: 'seg-A', profile_id: 'p1', action });

    it("'entered' enrolls only enter-triggered automations", () => {
      expect(parseEnrollmentTrigger(row('entered'), both).map((i) => i.automationId)).toEqual(['enter']);
    });

    it("'exited' enrolls only exit-triggered automations (leaving a segment starts a journey)", () => {
      expect(parseEnrollmentTrigger(row('exited'), both).map((i) => i.automationId)).toEqual(['exit']);
    });

    it('an unknown action enrolls nobody', () => {
      expect(parseEnrollmentTrigger(row('weird'), both)).toEqual([]);
    });
  });
});

describe('parseKeepWhileInCancellations (keep-while-in-segment)', () => {
  const automations: AutomationKeepRow[] = [
    { id: 'gated', workspace_id: 'ws', keep_while_in_segment: 'seg-A' },
    { id: 'other-seg', workspace_id: 'ws', keep_while_in_segment: 'seg-B' },
    { id: 'ungated', workspace_id: 'ws', keep_while_in_segment: null },
    { id: 'cross', workspace_id: 'other', keep_while_in_segment: 'seg-A' },
  ];
  const row = (action: string): SegmentChangeLogRow => ({ workspace_id: 'ws', segment_id: 'seg-A', profile_id: 'p1', action });

  it("'exited' cancels only automations gated on THAT segment in the SAME workspace", () => {
    expect(parseKeepWhileInCancellations(row('exited'), automations).map((c) => c.automationId)).toEqual(['gated']);
  });

  it("'entered' cancels nobody (only leaving the segment ends a gated journey)", () => {
    expect(parseKeepWhileInCancellations(row('entered'), automations)).toEqual([]);
  });

  it('buildEnrollmentCancel only ends ACTIVE enrollments, workspace-scoped', () => {
    const s = buildEnrollmentCancel('ws', 'c', 'p');
    expect(s.text).toMatch(/UPDATE automation_enrollments/);
    expect(s.text).toMatch(/status = 'exited'/);
    expect(s.text).toMatch(/AND status = 'active'/);
    expect(s.values).toEqual(['ws', 'c', 'p']);
  });
});
