// The visual campaign builder assembles editable nodes into a §9B
// CampaignDefinition. We assert the assembly + that the emitted graph passes the
// REAL backend validator (validateCampaignDefinition) — proving the UI emits a
// graph the server accepts, and rejects malformed graphs (no/many triggers).
import { describe, it, expect } from 'vitest';
import {
  buildDefinition,
  starterNodes,
  nodeToDef,
  type BuilderNode,
} from '../src/campaigns/builder.js';
import { validateCampaignDefinition } from '@cdp/service-campaign-runner';

const TPL = '00000000-0000-4000-8000-0000000000aa';

describe('campaign workflow builder', () => {
  it('the starter graph (trigger→send→exit) validates against the backend', () => {
    const def = buildDefinition(starterNodes(TPL));
    expect(def.startNode).toBe('trigger');
    expect(() => validateCampaignDefinition(def)).not.toThrow();
  });

  it('assembles a branching graph (trigger→wait→condition→send/exit) that validates', () => {
    const nodes: BuilderNode[] = [
      { id: 'trigger', type: 'trigger', kind: 'segment_entry', next: 'wait1' },
      { id: 'wait1', type: 'wait', delaySeconds: 172800, next: 'cond' },
      {
        id: 'cond',
        type: 'condition',
        ast: { field: 'last_email_open_at', operator: 'exists' },
        onTrue: 'sendB',
        onFalse: 'done',
      },
      { id: 'sendB', type: 'action', kind: 'send', templateId: TPL, next: 'done' },
      { id: 'done', type: 'exit' },
    ];
    const def = buildDefinition(nodes);
    expect(() => validateCampaignDefinition(def)).not.toThrow();
  });

  it('throws if there is not exactly one trigger node', () => {
    expect(() => buildDefinition([{ id: 'x', type: 'exit' }])).toThrow(/trigger/);
    expect(() =>
      buildDefinition([
        { id: 't1', type: 'trigger', kind: 'segment_entry', next: 'e' },
        { id: 't2', type: 'trigger', kind: 'segment_entry', next: 'e' },
        { id: 'e', type: 'exit' },
      ]),
    ).toThrow(/trigger/);
  });

  it('compiles a wait node to a {seconds} delay and a send action to template_id', () => {
    expect(nodeToDef({ id: 'w', type: 'wait', delaySeconds: 60, next: 'n' })).toEqual({
      type: 'wait',
      delay: { seconds: 60 },
      next: 'n',
    });
    expect(
      nodeToDef({ id: 's', type: 'action', kind: 'send', templateId: TPL, next: 'n' }),
    ).toEqual({ type: 'action', kind: 'send', template_id: TPL, next: 'n' });
  });

  it('threads the send envelope (subject + sender_id) onto the send action def', () => {
    const def = nodeToDef({
      id: 's',
      type: 'action',
      kind: 'send',
      templateId: TPL,
      subject: 'Welcome aboard',
      senderId: 'snd-1',
      next: 'n',
    });
    expect(def).toEqual({
      type: 'action',
      kind: 'send',
      template_id: TPL,
      subject: 'Welcome aboard',
      sender_id: 'snd-1',
      next: 'n',
    });
    // And the emitted graph still passes the backend validator.
    const full = buildDefinition([
      { id: 'trigger', type: 'trigger', kind: 'segment_entry', next: 's' },
      { id: 's', type: 'action', kind: 'send', templateId: TPL, subject: 'Hi', senderId: 'snd-1', next: 'done' },
      { id: 'done', type: 'exit' },
    ]);
    expect(() => validateCampaignDefinition(full)).not.toThrow();
  });
});
