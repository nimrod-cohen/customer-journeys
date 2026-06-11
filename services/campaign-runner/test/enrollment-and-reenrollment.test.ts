import { describe, it, expect } from 'vitest';
import {
  decideReenrollment,
  parseEnrollmentTrigger,
  type SegmentChangeLogRow,
  type CampaignTriggerRow,
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
  const campaigns: CampaignTriggerRow[] = [
    { id: 'c1', workspace_id: 'ws', trigger_segment_id: 'seg-A', start_node: 't' },
    { id: 'c2', workspace_id: 'ws', trigger_segment_id: 'seg-B', start_node: 't' },
    { id: 'c3', workspace_id: 'other', trigger_segment_id: 'seg-A', start_node: 't' },
  ];

  it("'entered' yields an intent per matching campaign (same ws + trigger_segment_id)", () => {
    const row: SegmentChangeLogRow = {
      workspace_id: 'ws',
      segment_id: 'seg-A',
      profile_id: 'p1',
      action: 'entered',
    };
    const intents = parseEnrollmentTrigger(row, campaigns);
    expect(intents).toEqual([
      { workspaceId: 'ws', campaignId: 'c1', profileId: 'p1', startNode: 't' },
    ]);
  });

  it("'exited' yields no intents", () => {
    const row: SegmentChangeLogRow = {
      workspace_id: 'ws',
      segment_id: 'seg-A',
      profile_id: 'p1',
      action: 'exited',
    };
    expect(parseEnrollmentTrigger(row, campaigns)).toEqual([]);
  });

  it('does not cross workspaces (campaign c3 in another ws is ignored)', () => {
    const row: SegmentChangeLogRow = {
      workspace_id: 'ws',
      segment_id: 'seg-A',
      profile_id: 'p1',
      action: 'entered',
    };
    const intents = parseEnrollmentTrigger(row, campaigns);
    expect(intents.map((i) => i.campaignId)).toEqual(['c1']);
  });

  it('throws on a falsy workspace_id', () => {
    const row = { workspace_id: '', segment_id: 's', profile_id: 'p', action: 'entered' };
    expect(() => parseEnrollmentTrigger(row as SegmentChangeLogRow, campaigns)).toThrow();
  });

  describe('trigger_on enter/exit', () => {
    const enterC: CampaignTriggerRow = { id: 'enter', workspace_id: 'ws', trigger_segment_id: 'seg-A', start_node: 't', trigger_on: 'enter' };
    const exitC: CampaignTriggerRow = { id: 'exit', workspace_id: 'ws', trigger_segment_id: 'seg-A', start_node: 't', trigger_on: 'exit' };
    const both = [enterC, exitC];
    const row = (action: string): SegmentChangeLogRow => ({ workspace_id: 'ws', segment_id: 'seg-A', profile_id: 'p1', action });

    it("'entered' enrolls only enter-triggered campaigns", () => {
      expect(parseEnrollmentTrigger(row('entered'), both).map((i) => i.campaignId)).toEqual(['enter']);
    });

    it("'exited' enrolls only exit-triggered campaigns (leaving a segment starts a journey)", () => {
      expect(parseEnrollmentTrigger(row('exited'), both).map((i) => i.campaignId)).toEqual(['exit']);
    });

    it('an unknown action enrolls nobody', () => {
      expect(parseEnrollmentTrigger(row('weird'), both)).toEqual([]);
    });
  });
});
