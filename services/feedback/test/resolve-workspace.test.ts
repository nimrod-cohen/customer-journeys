import { describe, it, expect } from 'vitest';
import { resolveWorkspaceRef } from '../src/core.js';

// CRITICAL invariant: workspace resolution is SENDER-SIDE ONLY.
//   1. mail.tags.workspace_id (highest priority — set by our own sender)
//   2. mail.tags.configurationSet / configurationSetName
//   3. the from-domain (mail.source / mail.sourceDomain / mail.from)
// It must NEVER read recipient or any client-supplied field. An unresolved
// event returns a null ref (the orchestrator turns that into a batch failure,
// never a guessed/default workspace).

describe('resolveWorkspaceRef (sender-side only)', () => {
  it('prefers mail.tags.workspace_id', () => {
    const ref = resolveWorkspaceRef({
      mail: {
        messageId: 'm',
        source: 'no-reply@mail.acme.com',
        tags: { workspace_id: ['ws-tag-1'], configurationSet: ['cs-acme'] },
      },
    });
    expect(ref).toEqual({ by: 'tag', workspaceId: 'ws-tag-1' });
  });

  it('accepts a scalar (non-array) tag value', () => {
    const ref = resolveWorkspaceRef({
      mail: { messageId: 'm', tags: { workspace_id: 'ws-scalar' } },
    });
    expect(ref).toEqual({ by: 'tag', workspaceId: 'ws-scalar' });
  });

  it('falls back to the configuration set name', () => {
    const ref = resolveWorkspaceRef({
      mail: { messageId: 'm', source: 'no-reply@mail.acme.com', tags: { 'ses:configuration-set': ['cs-acme'] } },
    });
    expect(ref).toEqual({ by: 'config_set', configSet: 'cs-acme' });
  });

  it('falls back to configurationSetName at the top level', () => {
    const ref = resolveWorkspaceRef({
      mail: { messageId: 'm' },
      eventType: 'Bounce',
      configurationSetName: 'cs-top',
    });
    expect(ref).toEqual({ by: 'config_set', configSet: 'cs-top' });
  });

  it('falls back to the from-domain (sender identity)', () => {
    const ref = resolveWorkspaceRef({ mail: { messageId: 'm', source: 'No-Reply@Mail.Acme.com' } });
    expect(ref).toEqual({ by: 'from_domain', fromDomain: 'mail.acme.com' });
  });

  it('NEVER resolves from recipient / destination', () => {
    const ref = resolveWorkspaceRef({
      mail: { messageId: 'm', destination: ['victim@other.com'] },
      bounce: { bouncedRecipients: [{ emailAddress: 'victim@other.com' }] },
    });
    // No sender-side signal at all → unresolved.
    expect(ref).toBeNull();
  });

  it('returns null when nothing sender-side is present', () => {
    expect(resolveWorkspaceRef({ mail: { messageId: 'm' } })).toBeNull();
  });
});
