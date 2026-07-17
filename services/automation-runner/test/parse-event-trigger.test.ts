// Phase 3: parseEventEnrollmentTrigger — the event-kind analogue of
// parseEnrollmentTrigger. It returns one EnrollmentIntent per active automation
// whose event trigger's eventType === the event's type (same workspace). The
// payload-filter result is fed in as a boolean (the parse layer is pure; the SQL
// match is the integration test's job).
import { describe, it, expect } from 'vitest';
import { parseEventEnrollmentTrigger, type EventRow, type EventAutomationTriggerRow } from '../src/core.js';

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
  it('returns one intent per active automation whose eventType matches (same workspace)', () => {
    const automations: EventAutomationTriggerRow[] = [
      { id: 'c1', workspace_id: WS, event_type: 'purchase', start_node: 't', matchesFilter: true },
      { id: 'c2', workspace_id: WS, event_type: 'purchase', start_node: 'start', matchesFilter: true },
    ];
    const intents = parseEventEnrollmentTrigger(ev(), automations);
    // Each event-trigger intent now also carries the trigger event (persisted onto
    // enrollment.state.event so a later set_attribute can read {{event.*}}).
    const event = { type: 'purchase', payload: {}, event_id: 'evt-1' };
    expect(intents).toEqual([
      { workspaceId: WS, automationId: 'c1', profileId: 'prof-1', startNode: 't', event },
      { workspaceId: WS, automationId: 'c2', profileId: 'prof-1', startNode: 'start', event },
    ]);
  });

  it('an event type matching NO automation eventType yields zero intents', () => {
    const automations: EventAutomationTriggerRow[] = [
      { id: 'c1', workspace_id: WS, event_type: 'signup', start_node: 't', matchesFilter: true },
    ];
    expect(parseEventEnrollmentTrigger(ev({ type: 'purchase' }), automations)).toEqual([]);
  });

  it('a automation in another workspace is filtered out (tenant isolation)', () => {
    const automations: EventAutomationTriggerRow[] = [
      { id: 'c1', workspace_id: 'ws-b', event_type: 'purchase', start_node: 't', matchesFilter: true },
    ];
    expect(parseEventEnrollmentTrigger(ev(), automations)).toEqual([]);
  });

  it('no filter (matchesFilter defaults true) ⇒ a matching-type event always produces an intent', () => {
    const automations: EventAutomationTriggerRow[] = [
      { id: 'c1', workspace_id: WS, event_type: 'purchase', start_node: 't' },
    ];
    expect(parseEventEnrollmentTrigger(ev(), automations)).toHaveLength(1);
  });

  it('a filter that evaluated false drops the intent', () => {
    const automations: EventAutomationTriggerRow[] = [
      { id: 'c1', workspace_id: WS, event_type: 'purchase', start_node: 't', matchesFilter: false },
    ];
    expect(parseEventEnrollmentTrigger(ev(), automations)).toEqual([]);
  });

  it('THROWS on a falsy workspace_id (tenant-isolation guard)', () => {
    expect(() => parseEventEnrollmentTrigger(ev({ workspace_id: '' }), [])).toThrow(/workspace_id/);
  });
});
