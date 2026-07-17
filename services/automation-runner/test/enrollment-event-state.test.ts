import { describe, it, expect } from 'vitest';
import {
  buildEnrollmentInsert,
  buildEnrollmentInsertWithState,
  parseEventEnrollmentTrigger,
  type EventRow,
  type EventAutomationTriggerRow,
} from '../src/core.js';

// PURE unit tests for persisting the trigger event onto automation_enrollments.state
// at EVENT enrollment time. The segment/manual paths keep the plain insert (state
// stays the column default '{}'), so a later event.* expression resolves safe-empty.

describe('buildEnrollmentInsertWithState — persists state.event on insert', () => {
  it('writes state = jsonb {event:{...}} and keeps ON CONFLICT DO NOTHING ("once")', () => {
    const stmt = buildEnrollmentInsertWithState('w1', 'c1', 'p1', 't', {
      event: { type: 'purchase', payload: { amount: 19.99 }, event_id: 'evt-1' },
    });
    expect(stmt.text).toMatch(/INSERT INTO automation_enrollments/);
    expect(stmt.text).toMatch(/state/);
    expect(stmt.text).toMatch(/ON CONFLICT \(automation_id, profile_id\) DO NOTHING/);
    // workspace_id is bound at $1 (tenant-isolation guard parity).
    expect(stmt.values[0]).toBe('w1');
    // The state json carries the event payload (+ type/event_id for provenance).
    const stateArg = stmt.values[stmt.values.length - 1] as string;
    expect(JSON.parse(stateArg)).toEqual({
      event: { type: 'purchase', payload: { amount: 19.99 }, event_id: 'evt-1' },
    });
  });

  it('THROWS on a falsy workspaceId (tenant-isolation guard)', () => {
    expect(() => buildEnrollmentInsertWithState('', 'c1', 'p1', 't', { event: {} })).toThrow(/workspaceId/);
  });

  it('the legacy buildEnrollmentInsert (no state) is unchanged — no state column written', () => {
    const stmt = buildEnrollmentInsert('w1', 'c1', 'p1', 't');
    expect(stmt.text).not.toMatch(/state/);
    expect(stmt.text).toMatch(/ON CONFLICT \(automation_id, profile_id\) DO NOTHING/);
  });
});

describe('parseEventEnrollmentTrigger — event payload threaded into the intent', () => {
  const row: EventRow = {
    workspace_id: 'w1',
    profile_id: 'p1',
    type: 'purchase',
    payload: { amount: 5 },
    event_id: 'evt-1',
  };
  const camp: EventAutomationTriggerRow = {
    id: 'c1',
    workspace_id: 'w1',
    event_type: 'purchase',
    start_node: 't',
  };

  it('an event-trigger intent carries the event {type,payload,event_id}', () => {
    const intents = parseEventEnrollmentTrigger(row, [camp]);
    expect(intents).toHaveLength(1);
    expect(intents[0]!.event).toEqual({ type: 'purchase', payload: { amount: 5 }, event_id: 'evt-1' });
  });

  it('a non-matching event yields no intent', () => {
    expect(parseEventEnrollmentTrigger({ ...row, type: 'other' }, [camp])).toHaveLength(0);
  });
});
