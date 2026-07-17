import { describe, it, expect } from 'vitest';
import { processNode, type EnrollmentState } from '../src/core.js';
import type { Node } from '../src/dsl.js';

const NOW = new Date('2026-06-07T12:00:00.000Z');

function state(over: Partial<EnrollmentState> = {}): EnrollmentState {
  return {
    id: 'e1',
    workspace_id: 'ws1',
    automation_id: 'c1',
    profile_id: 'p1',
    current_node: 'n',
    status: 'active',
    next_run_at: null,
    updated_at: NOW,
    ...over,
  };
}

describe('processNode', () => {
  it('trigger advances to next', () => {
    const node: Node = { type: 'trigger', kind: 'manual', next: 'w' };
    const r = processNode(node, state(), false, NOW);
    expect(r).toMatchObject({ disposition: 'advance', nextNode: 'w' });
    expect(r.sideEffects).toEqual([]);
  });

  it('exit completes', () => {
    const node: Node = { type: 'exit' };
    expect(processNode(node, state(), false, NOW)).toMatchObject({ disposition: 'complete' });
  });

  it('condition routes onTrue when matched, onFalse otherwise', () => {
    const node: Node = {
      type: 'condition',
      ast: { field: 'total_events', operator: '>', value: 0 },
      onTrue: 'yes',
      onFalse: 'no',
    };
    expect(processNode(node, state(), true, NOW).disposition).toBe('advance');
    expect((processNode(node, state(), true, NOW) as { nextNode: string }).nextNode).toBe('yes');
    expect((processNode(node, state(), false, NOW) as { nextNode: string }).nextNode).toBe('no');
  });

  it('action send emits a send side effect and advances (email default)', () => {
    const node: Node = { type: 'action', kind: 'send', template_id: 'tpl', next: 'x' };
    const r = processNode(node, state(), false, NOW);
    expect(r.disposition).toBe('advance');
    expect(r.sideEffects).toEqual([{ kind: 'send', medium: 'email', templateId: 'tpl', textBody: null, waTemplate: null, topicId: null, nodeId: '' }]);
  });

  it('action send with an sms medium emits a TEXT send side effect (body, no template)', () => {
    const node: Node = { type: 'action', kind: 'send', medium: 'sms', text_body: 'Hi {{customer.first_name}}', next: 'x' };
    const r = processNode(node, state(), false, NOW);
    expect(r.disposition).toBe('advance');
    expect(r.sideEffects).toEqual([
      { kind: 'send', medium: 'sms', templateId: null, textBody: 'Hi {{customer.first_name}}', waTemplate: null, topicId: null, nodeId: '' },
    ]);
  });

  it('action send carries a per-node topic_id onto the SendEffect', () => {
    const node: Node = { type: 'action', kind: 'send', template_id: 'tpl', topic_id: 'tpc-1', next: 'x' };
    const r = processNode(node, state(), false, NOW);
    expect(r.sideEffects).toEqual([{ kind: 'send', medium: 'email', templateId: 'tpl', textBody: null, waTemplate: null, topicId: 'tpc-1', nodeId: '' }]);
  });

  it('action set_attribute emits a set_attribute side effect', () => {
    const node: Node = { type: 'action', kind: 'set_attribute', key: 'vip', value: true, next: 'x' };
    const r = processNode(node, state(), false, NOW);
    expect(r.sideEffects).toEqual([{ kind: 'set_attribute', assignments: [{ key: 'vip', value: true }] }]);
  });

  it('wait on first arrival parks (stay) with a computed next_run_at', () => {
    const node: Node = { type: 'wait', delay: { seconds: 3600 }, next: 'x' };
    const r = processNode(node, state(), false, NOW, 'arrived');
    expect(r.disposition).toBe('stay');
    expect((r as { nextRunAt: Date }).nextRunAt.toISOString()).toBe('2026-06-07T13:00:00.000Z');
  });

  it('wait resumed by the sweep with an elapsed next_run_at advances', () => {
    const node: Node = { type: 'wait', delay: { seconds: 3600 }, next: 'x' };
    const r = processNode(
      node,
      state({ next_run_at: '2026-06-07T11:00:00.000Z' }),
      false,
      NOW,
      'resumed',
    );
    expect(r).toMatchObject({ disposition: 'advance', nextNode: 'x' });
  });

  it('wait resumed but NOT yet elapsed stays', () => {
    const node: Node = { type: 'wait', delay: { seconds: 3600 }, next: 'x' };
    const r = processNode(
      node,
      state({ next_run_at: '2026-06-07T13:00:00.000Z' }),
      false,
      NOW,
      'resumed',
    );
    expect(r.disposition).toBe('stay');
  });
});
