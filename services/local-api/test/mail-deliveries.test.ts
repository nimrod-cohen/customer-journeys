import { describe, it, expect } from 'vitest';
import { verpReturnPath } from '@cdp/email';
import { parseDeliveryLog, attributeDeliveries } from '../src/mail-deliveries.js';

const SECRET = 'verp-test-secret';
const MSG = '0c0d0f33-0000-4000-8000-0000000000f1';
const RP = verpReturnPath('bounce.journeys.on-grow.com', SECRET, MSG);
const H = 'mail.journeys.on-grow.com';

const from = (qid: string, rp = RP) =>
  `2026-11-17T19:23:02+00:00 ${H} postfix/qmgr[43844]: ${qid}: from=<${rp}>, size=12270, nrcpt=1 (queue active)`;
const sent = (qid: string, dsn = '2.0.0', status = 'sent') =>
  `2026-11-17T19:23:03+00:00 ${H} postfix/smtp[2892496]: ${qid}: to=<a@gmail.com>, relay=relay1.journeys.on-grow.com[194.195.243.92]:587, delay=0.41, delays=0.12/0.02/0.21/0.05, dsn=${dsn}, status=${status} (250 2.0.0 Ok: queued as B37D625BB3F)`;

describe('parseDeliveryLog', () => {
  it('pairs a sent line with its queue id’s from= and keeps the log time', () => {
    const [d, ...rest] = parseDeliveryLog([
      from('55B2C3EAF1'),
      `2026-11-17T19:23:02+00:00 ${H} postfix/cleanup[1]: 55B2C3EAF1: message-id=<x@y>`,
      sent('55B2C3EAF1'),
      `2026-11-17T19:23:03+00:00 ${H} postfix/qmgr[43844]: 55B2C3EAF1: removed`,
    ]);
    expect(rest).toEqual([]);
    expect(d).toMatchObject({ queueId: '55B2C3EAF1', to: 'a@gmail.com', dsn: '2.0.0', at: '2026-11-17T19:23:03.000Z' });
    expect(d!.relay).toBe('relay1.journeys.on-grow.com[194.195.243.92]:587');
    expect(RP).toContain(d!.verpToken);
  });

  it('ignores deferrals, bounces, and mail that is not ours (no VERP sender)', () => {
    expect(
      parseDeliveryLog([
        from('A1'), sent('A1', '4.4.1', 'deferred'),
        from('A2'), sent('A2', '5.1.1', 'bounced'),
        from('A3', ''), sent('A3'), // a DSN Postfix generated itself: from=<>
        sent('A4'), // its from= is outside this window
        'garbage',
      ]),
    ).toEqual([]);
  });
});

describe('attributeDeliveries', () => {
  const ref = { workspaceId: 'ws-1', profileId: 'p-1', recipient: 'a@gmail.com' };

  it('verifies the token and resolves the message, once per message', async () => {
    const lookups: string[] = [];
    const r = await attributeDeliveries(parseDeliveryLog([from('Q1'), sent('Q1'), sent('Q1')]), SECRET, async (id) => {
      lookups.push(id);
      return ref;
    });
    expect(r.ignored).toBe(0);
    expect(r.attributed).toEqual([
      { workspaceId: 'ws-1', messageId: MSG, profileId: 'p-1', relay: expect.any(String), dsn: '2.0.0', at: expect.any(String) },
    ]);
    expect(lookups).toEqual([MSG]);
  });

  it('drops a token signed with another secret without looking anything up', async () => {
    let looked = false;
    const r = await attributeDeliveries(parseDeliveryLog([from('Q1'), sent('Q1')]), 'other-secret', async () => {
      looked = true;
      return ref;
    });
    expect(r).toEqual({ attributed: [], ignored: 1 });
    expect(looked).toBe(false);
  });

  it('drops a message we have no record of', async () => {
    const r = await attributeDeliveries(parseDeliveryLog([from('Q1'), sent('Q1')]), SECRET, async () => null);
    expect(r).toEqual({ attributed: [], ignored: 1 });
  });
});
