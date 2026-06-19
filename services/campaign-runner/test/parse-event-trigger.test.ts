// Phase 3: parseEventEnrollmentTrigger — the event-kind analogue of
// parseEnrollmentTrigger. It returns one EnrollmentIntent per active campaign
// whose event trigger's eventType === the event's type (same workspace). The
// payload-filter result is fed in as a boolean (the parse layer is pure; the SQL
// match is the integration test's job).
import { describe, it, expect } from 'vitest';
import { parseEventEnrollmentTrigger, type EventRow, type EventCampaignTriggerRow } from '../src/core.js';

const WS = 'ws-a';
const ev = (over: Partial<EventRow> = {}): EventRow => ({
  workspace_id: WS,
  profile_id: 'prof-1',
  type: 'purchase',
  payload: {},
  event_id: 'evt-1',
  ...over,
});

describe('parseEventEnrollmentTrigger', () => {
  it('returns one intent per active campaign whose eventType matches (same workspace)', () => {
    const campaigns: EventCampaignTriggerRow[] = [
      { id: 'c1', workspace_id: WS, event_type: 'purchase', start_node: 't', matchesFilter: true },
      { id: 'c2', workspace_id: WS, event_type: 'purchase', start_node: 'start', matchesFilter: true },
    ];
    const intents = parseEventEnrollmentTrigger(ev(), campaigns);
    expect(intents).toEqual([
      { workspaceId: WS, campaignId: 'c1', profileId: 'prof-1', startNode: 't' },
      { workspaceId: WS, campaignId: 'c2', profileId: 'prof-1', startNode: 'start' },
    ]);
  });

  it('an event type matching NO campaign eventType yields zero intents', () => {
    const campaigns: EventCampaignTriggerRow[] = [
      { id: 'c1', workspace_id: WS, event_type: 'signup', start_node: 't', matchesFilter: true },
    ];
    expect(parseEventEnrollmentTrigger(ev({ type: 'purchase' }), campaigns)).toEqual([]);
  });

  it('a campaign in another workspace is filtered out (tenant isolation)', () => {
    const campaigns: EventCampaignTriggerRow[] = [
      { id: 'c1', workspace_id: 'ws-b', event_type: 'purchase', start_node: 't', matchesFilter: true },
    ];
    expect(parseEventEnrollmentTrigger(ev(), campaigns)).toEqual([]);
  });

  it('no filter (matchesFilter defaults true) ⇒ a matching-type event always produces an intent', () => {
    const campaigns: EventCampaignTriggerRow[] = [
      { id: 'c1', workspace_id: WS, event_type: 'purchase', start_node: 't' },
    ];
    expect(parseEventEnrollmentTrigger(ev(), campaigns)).toHaveLength(1);
  });

  it('a filter that evaluated false drops the intent', () => {
    const campaigns: EventCampaignTriggerRow[] = [
      { id: 'c1', workspace_id: WS, event_type: 'purchase', start_node: 't', matchesFilter: false },
    ];
    expect(parseEventEnrollmentTrigger(ev(), campaigns)).toEqual([]);
  });

  it('THROWS on a falsy workspace_id (tenant-isolation guard)', () => {
    expect(() => parseEventEnrollmentTrigger(ev({ workspace_id: '' }), [])).toThrow(/workspace_id/);
  });
});
