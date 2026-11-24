import { describe, it, expect } from 'vitest';
import {
  computeMailHealth,
  computeMailRoutes,
  parseProbeReport,
  redactAddresses,
  HETZNER_IP,
  LINODE_IP,
  type ProbeReport,
} from '../src/mail-health.js';

const NOW = new Date('2026-11-23T15:00:00Z');
const S3150 =
  "550 5.7.1 Unfortunately, messages from [194.195.243.92] weren't sent. Please contact your Internet service provider since part of their network is on our block list (S3150).";

const accepted = (provider: string, mx = `${provider}.example`) => ({
  provider,
  mx,
  stage: 'mail',
  code: 250,
  reply: '250 2.1.0 OK',
});
const allAccepted = () => [accepted('google'), accepted('microsoft'), accepted('apple')];

/** Every list answers its test point, and nothing is listed. */
const cleanLists = (target: string) =>
  ['zen.spamhaus.org', 'bl.spamcop.net', 'b.barracudacentral.org'].flatMap((zone) => [
    { target: '127.0.0.2', zone, answers: ['127.0.0.2'], error: null },
    { target, zone, answers: [], error: null },
  ]);

function report(ip: string, over: Partial<ProbeReport> = {}): ProbeReport {
  return {
    ip,
    checked_at: '2026-11-23T14:30:00.000Z',
    relayhost: ip === HETZNER_IP ? '[relay1.journeys.on-grow.com]:587' : null,
    smtp: allAccepted(),
    dnsbl: cleanLists(ip),
    ...over,
  };
}
const health = (reports: ProbeReport[], rejections: Parameters<typeof computeMailHealth>[0]['rejections'] = []) =>
  computeMailHealth({ reports, rejections, now: NOW });
const server = (h: ReturnType<typeof health>, ip: string) => h.servers.find((s) => s.ip === ip)!;

describe('computeMailHealth', () => {
  it('is ok when both servers are accepted and clean', () => {
    const h = health([report(HETZNER_IP), report(LINODE_IP)]);
    expect(h.status).toBe('ok');
    expect(h.issues).toEqual([]);
  });

  it('names who blocks the IP that is delivering, as critical', () => {
    const h = health([
      report(HETZNER_IP),
      report(LINODE_IP, {
        smtp: [accepted('google'), { provider: 'microsoft', mx: 'm', stage: 'mail', code: 550, reply: S3150 }, accepted('apple')],
      }),
    ]);
    expect(h.status).toBe('critical');
    expect(h.delivering_ip).toBe(LINODE_IP);
    const ms = server(h, LINODE_IP).providers.find((p) => p.provider === 'microsoft')!;
    expect(ms).toMatchObject({ status: 'blocked', code: 550, block_code: 'S3150' });
    expect(h.issues[0]!.title).toMatch(/Microsoft.*Linode/);
  });

  it('treats a block on the idle server as a warning', () => {
    const h = health([
      report(HETZNER_IP, {
        smtp: [accepted('google'), { provider: 'microsoft', mx: 'm', stage: 'mail', code: 550, reply: S3150 }, accepted('apple')],
      }),
      report(LINODE_IP),
    ]);
    expect(h.status).toBe('warning');
  });

  it('follows the route when Hetzner stops using the relay', () => {
    const h = health([report(HETZNER_IP, { relayhost: '' }), report(LINODE_IP)]);
    expect(h.delivering_ip).toBe(HETZNER_IP);
  });

  it('one bad Microsoft host makes the provider blocked', () => {
    const h = health([
      report(HETZNER_IP),
      report(LINODE_IP, {
        smtp: [
          accepted('google'),
          accepted('microsoft', 'hotmail'),
          { provider: 'microsoft', mx: 'outlook', stage: 'mail', code: 550, reply: S3150 },
          accepted('apple'),
        ],
      }),
    ]);
    expect(server(h, LINODE_IP).providers.find((p) => p.provider === 'microsoft')!.status).toBe('blocked');
  });

  it('reports a 4xx as throttled, never as blocked', () => {
    const h = health([
      report(HETZNER_IP),
      report(LINODE_IP, {
        smtp: [{ provider: 'google', mx: 'g', stage: 'mail', code: 421, reply: '421 4.7.0 try later' }, accepted('microsoft'), accepted('apple')],
      }),
    ]);
    expect(server(h, LINODE_IP).providers.find((p) => p.provider === 'google')!.status).toBe('throttled');
    expect(h.status).toBe('warning');
  });

  it('reports a closed connection as unreachable', () => {
    const h = health([
      report(HETZNER_IP),
      report(LINODE_IP, {
        smtp: [{ provider: 'google', mx: 'g', stage: 'connect', code: null, reply: 'timed out' }, accepted('microsoft'), accepted('apple')],
      }),
    ]);
    expect(server(h, LINODE_IP).providers.find((p) => p.provider === 'google')!.status).toBe('unreachable');
  });

  it('names the Spamhaus list an IP is on', () => {
    const dnsbl = cleanLists(LINODE_IP).map((r) =>
      r.target === LINODE_IP && r.zone === 'zen.spamhaus.org' ? { ...r, answers: ['127.0.0.2'] } : r,
    );
    const h = health([report(HETZNER_IP), report(LINODE_IP, { dnsbl })]);
    const zen = server(h, LINODE_IP).blocklists.find((l) => l.zone === 'zen.spamhaus.org')!;
    expect(zen.status).toBe('listed');
    expect(zen.detail).toMatch(/SBL/);
    expect(h.status).toBe('critical');
  });

  // Spamhaus refuses shared resolvers with this answer. It is NOT a listing, and an
  // empty answer from a resolver that fails the test point is NOT "clean".
  it('never reads a refused Spamhaus answer as listed or clean', () => {
    const dnsbl = [
      { target: '127.0.0.2', zone: 'zen.spamhaus.org', answers: ['127.255.255.254'], error: null },
      { target: HETZNER_IP, zone: 'zen.spamhaus.org', answers: ['127.255.255.254'], error: null },
    ];
    const h = health([report(HETZNER_IP, { dnsbl })]);
    expect(server(h, HETZNER_IP).blocklists.find((l) => l.zone === 'zen.spamhaus.org')!.status).toBe('unknown');
  });

  it('uses the other server when only one has a working resolver', () => {
    const refused = [
      { target: '127.0.0.2', zone: 'zen.spamhaus.org', answers: ['127.255.255.254'], error: null },
      { target: HETZNER_IP, zone: 'zen.spamhaus.org', answers: ['127.255.255.254'], error: null },
    ];
    const fromLinode = [
      ...cleanLists(LINODE_IP),
      { target: HETZNER_IP, zone: 'zen.spamhaus.org', answers: [], error: null },
    ];
    const h = health([report(HETZNER_IP, { dnsbl: refused }), report(LINODE_IP, { dnsbl: fromLinode })]);
    expect(server(h, HETZNER_IP).blocklists.find((l) => l.zone === 'zen.spamhaus.org')!.status).toBe('clean');
  });

  // A dead probe must never look like a healthy server.
  it('flags a server whose checks stopped arriving', () => {
    const h = health([report(HETZNER_IP), report(LINODE_IP, { checked_at: '2026-11-23T09:00:00.000Z' })]);
    expect(server(h, LINODE_IP).stale).toBe(true);
    expect(h.status).not.toBe('ok');
    expect(h.issues.some((i) => /Linode/.test(i.title) && /stopped/i.test(i.title))).toBe(true);
  });

  it('flags a server that has never reported', () => {
    const h = health([report(HETZNER_IP)]);
    expect(server(h, LINODE_IP).checked_at).toBeNull();
    expect(h.status).not.toBe('ok');
  });

  // Apple's HM08 arrives after the message body, so only real bounces can show it.
  it('raises real provider rejections from the last day as critical', () => {
    const h = health([report(HETZNER_IP), report(LINODE_IP)], [
      { provider: 'apple', count: 1, workspaces: 1, last_at: '2026-11-23T12:00:00.000Z', sample: '554 5.7.1 [HM08] rejected' },
    ]);
    expect(h.status).toBe('critical');
    expect(h.issues[0]!.title).toMatch(/Apple/);
  });

  it('keeps older real rejections as a warning', () => {
    const h = health([report(HETZNER_IP), report(LINODE_IP)], [
      { provider: 'apple', count: 1, workspaces: 1, last_at: '2026-11-19T12:00:00.000Z', sample: null },
    ]);
    expect(h.status).toBe('warning');
  });
});

describe('computeMailRoutes', () => {
  const blocked = (provider: string) => ({ provider, mx: 'm', stage: 'mail', code: 550, reply: S3150 });
  const without = (provider: string) => allAccepted().filter((r) => r.provider !== provider);
  const route = (r: ReturnType<typeof computeMailRoutes>, provider: string) => r.routes.find((x) => x.provider === provider)!;
  const routes = (reports: ProbeReport[]) => computeMailRoutes(reports, NOW);
  const MICROSOFT_DIRECT = ['hotmail.com', 'outlook.com', 'live.com', 'msn.com'];

  it('leaves every provider on the relay while it is accepted', () => {
    const r = routes([report(HETZNER_IP), report(LINODE_IP)]);
    expect(r.direct_domains).toEqual([]);
    expect(route(r, 'microsoft')).toMatchObject({ via_ip: LINODE_IP, planned_ip: LINODE_IP });
  });

  it('moves only the blocked provider to the healthy server', () => {
    const r = routes([report(HETZNER_IP), report(LINODE_IP, { smtp: [...without('microsoft'), blocked('microsoft')] })]);
    expect(route(r, 'microsoft').planned_ip).toBe(HETZNER_IP);
    expect(route(r, 'google').planned_ip).toBe(LINODE_IP);
    expect(r.direct_domains).toEqual(expect.arrayContaining(MICROSOFT_DIRECT));
    expect(r.direct_domains).not.toContain('gmail.com');
  });

  it('moves a provider back when its direct route becomes blocked', () => {
    const r = routes([
      report(HETZNER_IP, { direct_domains: ['hotmail.com'], smtp: [...without('microsoft'), blocked('microsoft')] }),
      report(LINODE_IP),
    ]);
    expect(route(r, 'microsoft')).toMatchObject({ via_ip: HETZNER_IP, planned_ip: LINODE_IP });
    expect(r.direct_domains).toEqual([]);
  });

  // Moving back on recovery would flip a provider between IPs and hurt both reputations.
  it('stays on the working route after the old server recovers', () => {
    const r = routes([report(HETZNER_IP, { direct_domains: MICROSOFT_DIRECT }), report(LINODE_IP)]);
    expect(route(r, 'microsoft').planned_ip).toBe(HETZNER_IP);
  });

  it('holds the route when both servers are blocked', () => {
    const smtp = [...without('microsoft'), blocked('microsoft')];
    const r = routes([report(HETZNER_IP, { smtp }), report(LINODE_IP, { smtp })]);
    expect(route(r, 'microsoft').planned_ip).toBe(LINODE_IP);
    expect(route(r, 'microsoft').reason).toMatch(/no healthy/i);
  });

  it.each([
    ['is stale', { checked_at: '2026-11-23T09:00:00.000Z' }],
    ['cannot be reached', { smtp: [...allAccepted().filter((x) => x.provider !== 'microsoft'), { provider: 'microsoft', mx: 'm', stage: 'connect', code: null, reply: 'timed out' }] }],
    ['is throttled', { smtp: [...allAccepted().filter((x) => x.provider !== 'microsoft'), { provider: 'microsoft', mx: 'm', stage: 'mail', code: 421, reply: 'later' }] }],
    ['is on a blocklist', { dnsbl: cleanLists(HETZNER_IP).map((x) => (x.target === HETZNER_IP && x.zone === 'bl.spamcop.net' ? { ...x, answers: ['127.0.0.2'] } : x)) }],
  ])('never moves mail to a server that %s', (_name, over) => {
    const r = routes([report(HETZNER_IP, over as Partial<ProbeReport>), report(LINODE_IP, { smtp: [...without('microsoft'), blocked('microsoft')] })]);
    expect(route(r, 'microsoft').planned_ip).toBe(LINODE_IP);
  });

  it('does not act on a stale block', () => {
    const r = routes([
      report(HETZNER_IP),
      report(LINODE_IP, { checked_at: '2026-11-23T09:00:00.000Z', smtp: [...without('microsoft'), blocked('microsoft')] }),
    ]);
    expect(route(r, 'microsoft').planned_ip).toBe(LINODE_IP);
  });

  it('issues no plan without a Hetzner report or when it has no relay', () => {
    expect(routes([report(LINODE_IP)]).direct_domains).toBeNull();
    expect(routes([report(HETZNER_IP, { relayhost: '' }), report(LINODE_IP)]).direct_domains).toBeNull();
  });

  it('does not call a block critical once that provider is routed elsewhere', () => {
    const h = health([
      report(HETZNER_IP, { direct_domains: MICROSOFT_DIRECT }),
      report(LINODE_IP, { smtp: [...without('microsoft'), blocked('microsoft')] }),
    ]);
    expect(h.status).toBe('warning');
    expect(h.routes.find((x) => x.provider === 'microsoft')!.via_ip).toBe(HETZNER_IP);
    expect(server(h, HETZNER_IP).delivering).toBe(true);
    expect(server(h, LINODE_IP).delivering).toBe(true);
  });
});

describe('parseProbeReport', () => {
  it('keeps valid direct domains and refuses unsafe ones', () => {
    const ok = parseProbeReport({ ...report(HETZNER_IP), direct_domains: ['hotmail.com'] });
    expect(ok.ok && ok.report.direct_domains).toEqual(['hotmail.com']);
    expect(parseProbeReport({ ...report(HETZNER_IP), direct_domains: ['bad domain\nx'] }).ok).toBe(false);
  });
  it('accepts a report from a known server', () => {
    expect(parseProbeReport(report(LINODE_IP)).ok).toBe(true);
  });
  it('refuses an unknown IP', () => {
    expect(parseProbeReport(report('203.0.113.9')).ok).toBe(false);
  });
  it('refuses a malformed or oversized report', () => {
    expect(parseProbeReport(null).ok).toBe(false);
    expect(parseProbeReport({ ...report(LINODE_IP), smtp: 'x' }).ok).toBe(false);
    expect(parseProbeReport({ ...report(LINODE_IP), checked_at: 'yesterday' }).ok).toBe(false);
    expect(parseProbeReport({ ...report(LINODE_IP), smtp: Array(100).fill(accepted('google')) }).ok).toBe(false);
  });
  it('refuses a provider it does not know', () => {
    expect(parseProbeReport({ ...report(LINODE_IP), smtp: [accepted('yahoo')] }).ok).toBe(false);
  });
});

describe('redactAddresses', () => {
  it('removes recipient addresses from a server reply', () => {
    expect(redactAddresses('550 5.7.1 <person@live.com> refused')).toBe('550 5.7.1 <address> refused');
  });
});
