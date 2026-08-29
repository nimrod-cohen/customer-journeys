import { describe, it, expect } from 'vitest';
import {
  generateDkimKey,
  dkimTargetHost,
  customerDnsRecords,
  makeCloudflareDns,
  dkimTxtChunks,
  verifyCustomerDomain,
  verifySelfHostedDomain,
  type CloudflareHttp,
  type DnsResolver,
} from '../src/dkim.js';
import { decryptSecret } from '@cdp/db';

const COMPANY = 'c0mpany1';
const MAIL_DOMAIN = 'journeys.on-grow.com';

describe('generateDkimKey', () => {
  it('produces a publishable TXT value and an encrypted private key', () => {
    const k = generateDkimKey('s1');
    expect(k.txtValue).toMatch(/^v=DKIM1; k=rsa; p=[A-Za-z0-9+/=]+$/);
    expect(k.publicKey.length).toBeGreaterThan(300);
    // The private half is never stored in the clear.
    expect(k.privateKeyEnc).not.toContain('BEGIN PRIVATE KEY');
    expect(decryptSecret(k.privateKeyEnc)).toContain('BEGIN PRIVATE KEY');
  });

  // A shared key would mean one compromise affects every tenant.
  it('generates a distinct key each time', () => {
    expect(generateDkimKey('s1').publicKey).not.toBe(generateDkimKey('s1').publicKey);
  });

  // An RSA-2048 value is ~410 chars, over the 255-byte cap on a single DNS TXT
  // string, so it must be published as several strings that resolvers rejoin.
  it('chunks the TXT value to respect the 255-byte DNS string limit', () => {
    const k = generateDkimKey('s1');
    expect(k.txtValue.length).toBeGreaterThan(255);
    const chunks = dkimTxtChunks(k.txtValue);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((c) => c.length <= 255)).toBe(true);
    expect(chunks.join('')).toBe(k.txtValue); // lossless round-trip
  });
});

describe('customer DNS records', () => {
  it('gives three CNAMEs pointing at per-company targets', () => {
    const recs = customerDnsRecords('acme.com', COMPANY, MAIL_DOMAIN);
    expect(recs.map((r) => r.name)).toEqual([
      'bounce.acme.com',
      's1._domainkey.acme.com',
      's2._domainkey.acme.com',
    ]);
    expect(recs.every((r) => r.type === 'CNAME')).toBe(true);
    expect(recs[1]!.value).toBe(`s1.${COMPANY}.dkim.${MAIL_DOMAIN}`);
  });

  it('scopes DKIM targets per company so one customer can be rotated alone', () => {
    expect(dkimTargetHost('s1', 'a', MAIL_DOMAIN)).not.toBe(dkimTargetHost('s1', 'b', MAIL_DOMAIN));
  });
});

function fakeCloudflare() {
  const calls: { method: string; url: string; body?: string }[] = [];
  let existingId: string | null = null;
  const http: CloudflareHttp = {
    async request(method, url, _headers, body) {
      calls.push({ method, url, body });
      if (method === 'GET') {
        return {
          status: 200,
          body: JSON.stringify({ result: existingId ? [{ id: existingId }] : [] }),
        };
      }
      return { status: 200, body: '{"success":true}' };
    },
  };
  return { calls, http, setExisting: (id: string | null) => (existingId = id) };
}

describe('cloudflare DNS provider', () => {
  it('creates a record when none exists', async () => {
    const cf = fakeCloudflare();
    await makeCloudflareDns({ apiToken: 't', zoneId: 'z' }, cf.http).upsertRecord({
      name: `s1.${COMPANY}.dkim.${MAIL_DOMAIN}`,
      type: 'TXT',
      content: 'v=DKIM1; k=rsa; p=AAA',
    });
    const post = cf.calls.find((c) => c.method === 'POST')!;
    expect(post).toBeDefined();
    expect(JSON.parse(post.body!).proxied).toBe(false); // mail records are never proxied
  });

  // Onboarding gets retried; two competing TXT keys at one name would leave
  // receivers unable to tell which is current.
  it('updates in place when the record already exists', async () => {
    const cf = fakeCloudflare();
    cf.setExisting('rec123');
    await makeCloudflareDns({ apiToken: 't', zoneId: 'z' }, cf.http).upsertRecord({
      name: 'x',
      type: 'TXT',
      content: 'v=DKIM1',
    });
    expect(cf.calls.some((c) => c.method === 'PUT' && c.url.endsWith('/rec123'))).toBe(true);
    expect(cf.calls.some((c) => c.method === 'POST')).toBe(false);
  });

  it('treats deleting a missing record as success', async () => {
    const cf = fakeCloudflare();
    await expect(
      makeCloudflareDns({ apiToken: 't', zoneId: 'z' }, cf.http).deleteRecord('gone', 'TXT'),
    ).resolves.toBeUndefined();
  });

  it('throws when the API rejects the write', async () => {
    const http: CloudflareHttp = {
      async request(method) {
        if (method === 'GET') return { status: 200, body: '{"result":[]}' };
        return { status: 403, body: 'forbidden' };
      },
    };
    await expect(
      makeCloudflareDns({ apiToken: 'bad', zoneId: 'z' }, http).upsertRecord({
        name: 'x',
        type: 'TXT',
        content: 'y',
      }),
    ).rejects.toThrow(/403/);
  });
});

function resolverFor(opts: {
  cnames?: Record<string, string[]>;
  txt?: Record<string, string[][]>;
}): DnsResolver {
  return {
    async resolveCname(name) {
      const v = opts.cnames?.[name];
      if (!v) throw new Error('ENOTFOUND');
      return v;
    },
    async resolveTxt(name) {
      const v = opts.txt?.[name];
      if (!v) throw new Error('ENOTFOUND');
      return v;
    },
  };
}

describe('verifyCustomerDomain', () => {
  const KEY = 'PUBLICKEYAAA';
  const good = {
    cnames: {
      'bounce.acme.com': [`bounce.${MAIL_DOMAIN}`],
      's1._domainkey.acme.com': [`s1.${COMPANY}.dkim.${MAIL_DOMAIN}`],
      's2._domainkey.acme.com': [`s2.${COMPANY}.dkim.${MAIL_DOMAIN}`],
    },
    txt: {
      's1._domainkey.acme.com': [[`v=DKIM1; k=rsa; p=${KEY}`]],
      '_dmarc.acme.com': [['v=DMARC1; p=none']],
    },
  };
  const args = {
    customerDomain: 'acme.com',
    companyId: COMPANY,
    mailDomain: MAIL_DOMAIN,
    expectedPublicKey: KEY,
  };

  it('verifies a fully delegated domain', async () => {
    const r = await verifyCustomerDomain(resolverFor(good), args);
    expect(r.verified).toBe(true);
    expect(r.checks.every((c) => c.ok)).toBe(true);
  });

  it('fails when the bounce delegation is missing', async () => {
    const cnames = { ...good.cnames };
    delete (cnames as Record<string, unknown>)['bounce.acme.com'];
    const r = await verifyCustomerDomain(resolverFor({ ...good, cnames }), args);
    expect(r.verified).toBe(false);
    expect(r.checks.find((c) => c.label === 'Return path delegated')!.ok).toBe(false);
  });

  // Verifying a domain that Gmail will refuse is worse than refusing it ourselves.
  it('refuses a domain with no DMARC record', async () => {
    const txt = { ...good.txt };
    delete (txt as Record<string, unknown>)['_dmarc.acme.com'];
    const r = await verifyCustomerDomain(resolverFor({ ...good, txt }), args);
    expect(r.verified).toBe(false);
    expect(r.checks.find((c) => c.label === 'DMARC published')!.ok).toBe(false);
  });

  it('fails when the delegation resolves to a different key than we hold', async () => {
    const txt = { ...good.txt, 's1._domainkey.acme.com': [['v=DKIM1; k=rsa; p=SOMEONEELSE']] };
    const r = await verifyCustomerDomain(resolverFor({ ...good, txt }), args);
    expect(r.verified).toBe(false);
    expect(r.checks.find((c) => c.label === 'DKIM key resolves')!.ok).toBe(false);
  });

  it('accepts a trailing dot and case differences in the CNAME target', async () => {
    const cnames = {
      ...good.cnames,
      'bounce.acme.com': [`BOUNCE.${MAIL_DOMAIN.toUpperCase()}.`],
    };
    const r = await verifyCustomerDomain(resolverFor({ ...good, cnames }), args);
    expect(r.checks.find((c) => c.label === 'Return path delegated')!.ok).toBe(true);
  });

  it('never throws when DNS lookups fail entirely', async () => {
    const r = await verifyCustomerDomain(resolverFor({}), args);
    expect(r.verified).toBe(false);
    expect(r.checks).toHaveLength(5);
  });
});

describe('Google Postmaster Tools verification', () => {
  const KEY = 'PUBKEY';
  const GPT = 'google-site-verification=abc123xyz';
  const base = {
    cnames: {
      'bounce.acme.com': [`bounce.${MAIL_DOMAIN}`],
      's1._domainkey.acme.com': [`s1.${COMPANY}.dkim.${MAIL_DOMAIN}`],
      's2._domainkey.acme.com': [`s2.${COMPANY}.dkim.${MAIL_DOMAIN}`],
    },
    txt: {
      's1._domainkey.acme.com': [[`v=DKIM1; k=rsa; p=${KEY}`]],
      '_dmarc.acme.com': [['v=DMARC1; p=none']],
      'acme.com': [[GPT]],
    },
  };
  const args = {
    customerDomain: 'acme.com',
    companyId: COMPANY,
    mailDomain: MAIL_DOMAIN,
    expectedPublicKey: KEY,
  };

  it('adds a fourth record when a token has been issued', () => {
    const recs = customerDnsRecords('acme.com', COMPANY, MAIL_DOMAIN, GPT);
    expect(recs).toHaveLength(4);
    const gpt = recs[3]!;
    expect(gpt.type).toBe('TXT');
    expect(gpt.name).toBe('acme.com'); // apex
    expect(gpt.value).toBe(GPT);
    expect(gpt.required).toBe(false);
  });

  it('omits it when no token exists yet', () => {
    expect(customerDnsRecords('acme.com', COMPANY, MAIL_DOMAIN)).toHaveLength(3);
    expect(customerDnsRecords('acme.com', COMPANY, MAIL_DOMAIN, '  ')).toHaveLength(3);
  });

  it('reports it verified when the TXT resolves', async () => {
    const r = await verifyCustomerDomain(resolverFor(base), { ...args, gptToken: GPT });
    expect(r.gptVerified).toBe(true);
    expect(r.verified).toBe(true);
  });

  // Reputation VISIBILITY must never be a prerequisite for sending — that would
  // block onboarding on a Google-side step unrelated to authorisation.
  it('does NOT block sending when Postmaster verification is missing', async () => {
    const txt = { ...base.txt };
    delete (txt as Record<string, unknown>)['acme.com'];
    const r = await verifyCustomerDomain(resolverFor({ ...base, txt }), { ...args, gptToken: GPT });
    expect(r.gptVerified).toBe(false);
    expect(r.verified).toBe(true); // still sendable
    expect(r.checks.find((c) => c.label === 'Google Postmaster verification')!.ok).toBe(false);
  });

  it('reports null and adds no check when no token was issued', async () => {
    const r = await verifyCustomerDomain(resolverFor(base), args);
    expect(r.gptVerified).toBeNull();
    expect(r.checks.some((c) => c.label === 'Google Postmaster verification')).toBe(false);
  });

  it('still fails a domain whose DKIM is wrong, token present or not', async () => {
    const txt = { ...base.txt, 's1._domainkey.acme.com': [['v=DKIM1; k=rsa; p=WRONG']] };
    const r = await verifyCustomerDomain(resolverFor({ ...base, txt }), { ...args, gptToken: GPT });
    expect(r.verified).toBe(false);
  });
});

describe('verifySelfHostedDomain (the day-one model)', () => {
  const KEY = 'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8ABBBB';
  const args = { customerDomain: 'acme.com', selector: 'cdp', expectedPublicKey: KEY };
  const good = {
    txt: {
      'cdp._domainkey.acme.com': [[`v=DKIM1; h=sha256; k=rsa; p=${KEY}`]],
      '_dmarc.acme.com': [['v=DMARC1; p=none']],
    },
  };

  it('verifies a domain that published our key', async () => {
    const r = await verifySelfHostedDomain(resolverFor(good), args);
    expect(r.verified).toBe(true);
  });

  // A 2048-bit key is published as several strings the resolver rejoins.
  it('rejoins a multi-string TXT record before comparing', async () => {
    const half = Math.floor(KEY.length / 2);
    const txt = {
      ...good.txt,
      'cdp._domainkey.acme.com': [['v=DKIM1; k=rsa; p=' + KEY.slice(0, half), KEY.slice(half)]],
    };
    expect((await verifySelfHostedDomain(resolverFor({ txt }), args)).verified).toBe(true);
  });

  it('fails when the record is missing', async () => {
    const r = await verifySelfHostedDomain(resolverFor({ txt: good.txt ? { '_dmarc.acme.com': good.txt['_dmarc.acme.com']! } : {} }), args);
    expect(r.verified).toBe(false);
    expect(r.checks.find((c) => c.label === 'DKIM key published')!.detail).toMatch(/cdp\._domainkey\.acme\.com/);
  });

  it('fails when a DIFFERENT key is published', async () => {
    const txt = { ...good.txt, 'cdp._domainkey.acme.com': [['v=DKIM1; k=rsa; p=SOMEONEELSESKEY']] };
    expect((await verifySelfHostedDomain(resolverFor({ txt }), args)).verified).toBe(false);
  });

  // Verifying a domain Gmail will refuse is worse than refusing it ourselves.
  it('requires DMARC', async () => {
    const txt = { 'cdp._domainkey.acme.com': good.txt['cdp._domainkey.acme.com']! };
    const r = await verifySelfHostedDomain(resolverFor({ txt }), args);
    expect(r.verified).toBe(false);
    expect(r.checks.find((c) => c.label === 'DMARC published')!.ok).toBe(false);
  });

  it('never throws when DNS is unavailable', async () => {
    const r = await verifySelfHostedDomain(resolverFor({}), args);
    expect(r.verified).toBe(false);
    expect(r.checks).toHaveLength(2);
  });
});
