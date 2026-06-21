// Pure preference-center core tests (CLAUDE.md topic-subscriptions): the form
// parser + the parameterized SQL builders. No I/O — the scoping guard (every
// builder binds workspace_id at $1 and throws on a falsy id) is the security
// boundary the service role relies on (RLS is bypassed).
import { describe, it, expect } from 'vitest';
import {
  parsePreferenceUpdate,
  buildActiveTopicsQuery,
  buildTopicStateQuery,
  buildGroupStateQuery,
  buildTopicSubscriptionUpsert,
  buildChannelOptOutWrite,
  buildOptOutAllTopics,
  toTopicChoices,
  isMediumGroup,
  MEDIUM_GROUPS,
} from '../src/preference-center.js';

const WS = 'ws-1';
const T1 = 't-1';
const T2 = 't-2';

describe('parsePreferenceUpdate', () => {
  it('an unchecked topic (absent from the body) is a desired OPT-OUT', () => {
    // Only T1 is checked; T2 is a known topic but absent → opt-out.
    const u = parsePreferenceUpdate(`topic.${T1}=on`, [T1, T2]);
    expect(u.topics.get(T1)).toBe(true);
    expect(u.topics.get(T2)).toBe(false);
    expect(u.unsubscribeAll).toBe(false);
  });

  it('group boxes: checked → subscribed, absent → opted out', () => {
    const u = parsePreferenceUpdate('group.email=on', [T1]);
    expect(u.groups.get('email')).toBe(true);
    expect(u.groups.get('sms_whatsapp')).toBe(false);
  });

  it('detects "unsubscribe from everything"', () => {
    expect(parsePreferenceUpdate('unsubscribe_all=1', []).unsubscribeAll).toBe(true);
    expect(parsePreferenceUpdate('', []).unsubscribeAll).toBe(false);
  });

  it('tolerates an empty/null body', () => {
    const u = parsePreferenceUpdate(null, [T1]);
    expect(u.topics.get(T1)).toBe(false);
    expect(u.groups.get('email')).toBe(false);
  });
});

describe('SQL builders — workspace-scoping guard', () => {
  const builders = [
    () => buildActiveTopicsQuery(''),
    () => buildTopicStateQuery('', 'a@b.com'),
    () => buildGroupStateQuery('', 'a@b.com'),
    () => buildTopicSubscriptionUpsert('', 'a@b.com', T1, true),
    () => buildChannelOptOutWrite('', 'a@b.com', 'email', true),
    () => buildOptOutAllTopics('', 'a@b.com'),
  ];
  it('every builder throws on a falsy workspaceId', () => {
    for (const b of builders) expect(b).toThrow(/workspaceId is required/);
  });
  it('every builder binds workspace_id at $1', () => {
    expect(buildActiveTopicsQuery(WS).values[0]).toBe(WS);
    expect(buildTopicStateQuery(WS, 'a@b.com').values[0]).toBe(WS);
    expect(buildGroupStateQuery(WS, 'a@b.com').values[0]).toBe(WS);
    expect(buildTopicSubscriptionUpsert(WS, 'a@b.com', T1, true).values[0]).toBe(WS);
    expect(buildChannelOptOutWrite(WS, 'a@b.com', 'email', true).values[0]).toBe(WS);
    expect(buildOptOutAllTopics(WS, 'a@b.com').values[0]).toBe(WS);
  });
});

describe('buildChannelOptOutWrite', () => {
  it('optedOut=true INSERTs the opt-out (idempotent upsert)', () => {
    const s = buildChannelOptOutWrite(WS, 'a@b.com', 'sms_whatsapp', true);
    expect(s.text).toMatch(/INSERT INTO channel_optouts/);
    expect(s.text).toMatch(/ON CONFLICT/);
  });
  it('optedOut=false DELETEs the opt-out (re-subscribed)', () => {
    const s = buildChannelOptOutWrite(WS, 'a@b.com', 'email', false);
    expect(s.text).toMatch(/DELETE FROM channel_optouts/);
  });
});

describe('toTopicChoices', () => {
  it('default-on: a topic with no explicit row is subscribed; an explicit false is opted out', () => {
    const choices = toTopicChoices(
      [
        { id: T1, name: 'News' },
        { id: T2, name: 'Digest' },
      ],
      [{ topic_id: T2, subscribed: false }],
    );
    expect(choices.find((c) => c.id === T1)!.subscribed).toBe(true);
    expect(choices.find((c) => c.id === T2)!.subscribed).toBe(false);
  });
});

describe('isMediumGroup / MEDIUM_GROUPS', () => {
  it('recognises the two groups only', () => {
    expect(MEDIUM_GROUPS).toEqual(['email', 'sms_whatsapp']);
    expect(isMediumGroup('email')).toBe(true);
    expect(isMediumGroup('sms_whatsapp')).toBe(true);
    expect(isMediumGroup('push')).toBe(false);
  });
});
