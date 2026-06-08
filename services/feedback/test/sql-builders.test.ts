import { describe, it, expect } from 'vitest';
import {
  buildEmailEventInsert,
  buildSuppressionUpsert,
  buildGlobalHardBounceUpsert,
  buildProfileEmailStatusUpdate,
  buildMessagesLogMarkFailed,
  buildSoftBounceCountQuery,
  buildReputationRateQuery,
  buildWorkspaceSuspend,
} from '../src/core.js';

const WS = '11111111-1111-1111-1111-111111111111';

describe('feedback SqlStatement builders', () => {
  describe('buildEmailEventInsert', () => {
    it('inserts with ON CONFLICT (workspace_id, ses_message_id, type) DO NOTHING', () => {
      const s = buildEmailEventInsert(WS, {
        sesMessageId: 'ses-1',
        type: 'bounce',
        subType: 'Permanent',
        profileId: null,
        raw: { a: 1 },
      });
      expect(s.text).toMatch(/INSERT INTO email_events/i);
      expect(s.text).toMatch(/ON CONFLICT \(workspace_id, ses_message_id, type\) DO NOTHING/i);
      expect(s.values[0]).toBe(WS);
      expect(s.values).toContain('ses-1');
      expect(s.values).toContain('bounce');
    });
    it('throws on falsy workspaceId', () => {
      expect(() => buildEmailEventInsert('', { sesMessageId: 'x', type: 'bounce', subType: null, profileId: null, raw: {} })).toThrow(/workspace/i);
    });
  });

  describe('buildSuppressionUpsert', () => {
    it('upserts with ON CONFLICT (workspace_id, email) DO NOTHING', () => {
      const s = buildSuppressionUpsert(WS, 'a@b.com', 'hard_bounce', 'feedback');
      expect(s.text).toMatch(/INSERT INTO suppressions/i);
      expect(s.text).toMatch(/ON CONFLICT \(workspace_id, email\) DO NOTHING/i);
      expect(s.values).toEqual([WS, 'a@b.com', 'hard_bounce', 'feedback']);
    });
    it('throws on falsy workspaceId', () => {
      expect(() => buildSuppressionUpsert('', 'a@b.com', 'complaint')).toThrow(/workspace/i);
    });
  });

  describe('buildGlobalHardBounceUpsert', () => {
    it('upserts with ON CONFLICT (email) DO NOTHING (no workspace column)', () => {
      const s = buildGlobalHardBounceUpsert('a@b.com');
      expect(s.text).toMatch(/INSERT INTO global_hard_bounces/i);
      expect(s.text).toMatch(/ON CONFLICT \(email\) DO NOTHING/i);
      expect(s.values).toEqual(['a@b.com']);
    });
  });

  describe('buildProfileEmailStatusUpdate', () => {
    it('updates the profile status scoped by workspace_id + email', () => {
      const s = buildProfileEmailStatusUpdate(WS, 'a@b.com', 'bounced');
      expect(s.text).toMatch(/UPDATE profiles/i);
      expect(s.text).toMatch(/workspace_id = \$1/);
      expect(s.values).toEqual([WS, 'a@b.com', 'bounced']);
    });
    it('throws on falsy workspaceId', () => {
      expect(() => buildProfileEmailStatusUpdate('', 'a@b.com', 'bounced')).toThrow(/workspace/i);
    });
  });

  describe('buildSoftBounceCountQuery', () => {
    it('counts CONSECUTIVE soft bounces since the last delivery, workspace-scoped', () => {
      const s = buildSoftBounceCountQuery(WS, 'a@b.com');
      expect(s.text).toMatch(/FROM email_events/i);
      expect(s.text).toMatch(/workspace_id = \$1/);
      // A delivery resets the window (the count only includes later soft bounces).
      expect(s.text).toMatch(/type = 'delivery'/i);
      expect(s.text).toMatch(/occurred_at >/i);
      expect(s.values[0]).toBe(WS);
    });
    it('throws on falsy workspaceId', () => {
      expect(() => buildSoftBounceCountQuery('', 'a@b.com')).toThrow(/workspace/i);
    });
  });

  describe('buildMessagesLogMarkFailed', () => {
    it('marks the message failed by ses_message_id, workspace-scoped', () => {
      const s = buildMessagesLogMarkFailed(WS, 'ses-9', 'bounced');
      expect(s.text).toMatch(/UPDATE messages_log SET status = \$3/i);
      expect(s.text).toMatch(/workspace_id = \$1 AND ses_message_id = \$2/i);
      expect(s.values).toEqual([WS, 'ses-9', 'bounced']);
    });
    it('throws on falsy workspaceId', () => {
      expect(() => buildMessagesLogMarkFailed('', 'ses-9', 'bounced')).toThrow(/workspace/i);
    });
  });

  describe('buildReputationRateQuery', () => {
    it('reads email_events numerator + messages_log denominator, workspace-scoped', () => {
      const s = buildReputationRateQuery(WS);
      expect(s.text).toMatch(/email_events/i);
      expect(s.text).toMatch(/messages_log/i);
      expect(s.text).toMatch(/workspace_id = \$1/);
      expect(s.values[0]).toBe(WS);
    });
    it('throws on falsy workspaceId', () => {
      expect(() => buildReputationRateQuery('')).toThrow(/workspace/i);
    });
  });

  describe('buildWorkspaceSuspend', () => {
    it("sets workspaces.status = 'suspended' for ONLY that workspace id", () => {
      const s = buildWorkspaceSuspend(WS);
      expect(s.text).toMatch(/UPDATE workspaces/i);
      expect(s.text).toMatch(/status = 'suspended'/i);
      expect(s.text).toMatch(/WHERE id = \$1/);
      expect(s.values).toEqual([WS]);
    });
    it('throws on falsy workspaceId', () => {
      expect(() => buildWorkspaceSuspend('')).toThrow(/workspace/i);
    });
  });
});
