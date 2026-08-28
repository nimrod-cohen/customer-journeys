// DKIM key management for self-hosted sending.
//
// Each sending domain gets its OWN keypair per selector — never a shared platform
// key. A shared key would mean one compromise affects every tenant, and no single
// customer could be rotated alone.
//
// The customer publishes CNAMEs pointing at us:
//
//     s1._domainkey.customer.com  CNAME  s1.<company-id>.dkim.<mail-domain>
//     s2._domainkey.customer.com  CNAME  s2.<company-id>.dkim.<mail-domain>
//     bounce.customer.com         CNAME  bounce.<mail-domain>
//
// so the TXT value stays under OUR control. That is what makes key rotation
// possible at all: with a customer-hosted TXT record, rotating means asking every
// customer to edit DNS, which in practice means never rotating.
//
// The bounce CNAME does double duty — a CNAME applies to every record type at that
// name, so it inherits both our SPF and our MX. The envelope sender then sits in
// the customer's own organisational domain, giving SPF alignment under DMARC's
// relaxed rule alongside DKIM, and bounces still route back to us.
import { generateKeyPairSync } from 'node:crypto';
import { encryptSecret } from '@cdp/db';

/** A freshly generated DKIM keypair, private half already encrypted at rest. */
export interface GeneratedDkimKey {
  readonly selector: 's1' | 's2';
  /** Base64 SPKI public key, as it appears in the published TXT value. */
  readonly publicKey: string;
  /** Envelope-encrypted PKCS#8 private key. Never returned over the API. */
  readonly privateKeyEnc: string;
  /** The full TXT record value to publish. */
  readonly txtValue: string;
}

/**
 * Generate an RSA-2048 DKIM keypair — the size Gmail and Yahoo expect. RSA-1024
 * still validates but is deprecated and reads as a weak signal.
 *
 * Note the DNS consequence: a 2048-bit key yields a TXT value of ~410 characters,
 * while a single DNS TXT *string* is capped at 255. A TXT *record* may hold
 * several strings which the resolver concatenates, so the value must be published
 * in chunks — see `dkimTxtChunks`. Verification joins them back before comparing.
 */
export function generateDkimKey(selector: 's1' | 's2'): GeneratedDkimKey {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  const pubBase64 = publicKey
    .replace(/-----(BEGIN|END) PUBLIC KEY-----/g, '')
    .replace(/\s+/g, '');
  return {
    selector,
    publicKey: pubBase64,
    privateKeyEnc: encryptSecret(privateKey),
    txtValue: `v=DKIM1; k=rsa; p=${pubBase64}`,
  };
}

/**
 * Split a DKIM TXT value into <=255-character chunks for publication.
 *
 * Cloudflare happens to chunk long TXT content itself, but relying on that makes
 * the code silently provider-specific; doing it explicitly keeps the DNS seam
 * portable and makes the 255-byte rule visible where it matters.
 */
export function dkimTxtChunks(value: string, size = 255): string[] {
  const out: string[] = [];
  for (let i = 0; i < value.length; i += size) out.push(value.slice(i, i + size));
  return out;
}

/** The DNS name we host for a company's selector — the CNAME target. */
export function dkimTargetHost(selector: 's1' | 's2', companyId: string, mailDomain: string): string {
  return `${selector}.${companyId}.dkim.${mailDomain}`;
}

/** The three records a customer publishes to authorise us for their domain. */
export interface CustomerDnsRecord {
  readonly name: string;
  readonly type: 'CNAME';
  readonly value: string;
  readonly purpose: string;
}

export function customerDnsRecords(
  customerDomain: string,
  companyId: string,
  mailDomain: string,
): CustomerDnsRecord[] {
  return [
    {
      name: `bounce.${customerDomain}`,
      type: 'CNAME',
      value: `bounce.${mailDomain}`,
      purpose: 'Return path — inherits our SPF and MX, so bounces come back to us and SPF aligns with your domain',
    },
    {
      name: `s1._domainkey.${customerDomain}`,
      type: 'CNAME',
      value: dkimTargetHost('s1', companyId, mailDomain),
      purpose: 'DKIM signing key',
    },
    {
      name: `s2._domainkey.${customerDomain}`,
      type: 'CNAME',
      value: dkimTargetHost('s2', companyId, mailDomain),
      purpose: 'DKIM rotation key — lets us rotate without you touching DNS again',
    },
  ];
}

// ── DNS provider seam ────────────────────────────────────────────────────────
// Publishing the TXT targets is injectable so tests never touch the network and
// the provider can be swapped. Cloudflare is the implementation today.

export interface DnsRecordSpec {
  readonly name: string;
  readonly type: 'TXT' | 'CNAME';
  readonly content: string;
  readonly ttl?: number;
}

export interface DnsProvider {
  upsertRecord(spec: DnsRecordSpec): Promise<void>;
  deleteRecord(name: string, type: 'TXT' | 'CNAME'): Promise<void>;
}

export interface CloudflareHttp {
  request(
    method: string,
    url: string,
    headers: Record<string, string>,
    body?: string,
  ): Promise<{ status: number; body: string }>;
}

export function fetchCloudflareHttp(): CloudflareHttp {
  return {
    async request(method, url, headers, body) {
      const res = await fetch(url, { method, headers, ...(body === undefined ? {} : { body }) });
      return { status: res.status, body: await res.text() };
    },
  };
}

/**
 * Cloudflare DNS provider. The API token needs only Zone.DNS:Edit on the zone
 * hosting the mail domain — never an account-wide token.
 *
 * Upsert rather than create: onboarding is retried in practice (a failed
 * verification, a re-run), and a duplicate TXT at the same name would leave two
 * competing keys with no way for a receiver to know which is current.
 */
export function makeCloudflareDns(
  cfg: { apiToken: string; zoneId: string },
  http: CloudflareHttp = fetchCloudflareHttp(),
): DnsProvider {
  const base = `https://api.cloudflare.com/client/v4/zones/${cfg.zoneId}/dns_records`;
  const headers = {
    Authorization: `Bearer ${cfg.apiToken}`,
    'Content-Type': 'application/json',
  };

  const findId = async (name: string, type: string): Promise<string | null> => {
    const res = await http.request(
      'GET',
      `${base}?name=${encodeURIComponent(name)}&type=${type}`,
      headers,
    );
    if (res.status !== 200) return null;
    try {
      const parsed = JSON.parse(res.body) as { result?: { id?: string }[] };
      return parsed.result?.[0]?.id ?? null;
    } catch {
      return null;
    }
  };

  return {
    async upsertRecord(spec) {
      const payload = JSON.stringify({
        type: spec.type,
        name: spec.name,
        content: spec.content,
        ttl: spec.ttl ?? 3600,
        proxied: false, // mail records must never be CDN-proxied
      });
      const existing = await findId(spec.name, spec.type);
      const res = existing
        ? await http.request('PUT', `${base}/${existing}`, headers, payload)
        : await http.request('POST', base, headers, payload);
      if (res.status < 200 || res.status >= 300) {
        throw new Error(`cloudflare: ${spec.type} ${spec.name} failed (${res.status})`);
      }
    },
    async deleteRecord(name, type) {
      const id = await findId(name, type);
      if (!id) return; // already gone — deletion is idempotent
      const res = await http.request('DELETE', `${base}/${id}`, headers);
      if (res.status < 200 || res.status >= 300) {
        throw new Error(`cloudflare: delete ${type} ${name} failed (${res.status})`);
      }
    },
  };
}

// ── verification ─────────────────────────────────────────────────────────────

export interface DnsResolver {
  resolveCname(name: string): Promise<string[]>;
  resolveTxt(name: string): Promise<string[][]>;
}

/** One verification step and whether it passed. */
export interface DomainCheck {
  readonly label: string;
  readonly ok: boolean;
  /** Why it failed. Explicitly `| undefined` for exactOptionalPropertyTypes. */
  readonly detail?: string | undefined;
}

/** What a domain still needs before it may send. */
export interface DomainVerification {
  readonly verified: boolean;
  readonly checks: DomainCheck[];
}

/**
 * Verify a customer domain by FOLLOWING the CNAMEs rather than reading a TXT
 * value directly — the records live on our zone, so what we assert is that the
 * customer has delegated to us and the delegation resolves to the key we hold.
 *
 * DMARC is required, not advisory: since 2024 Gmail and Yahoo refuse bulk mail
 * from domains without it, so a domain lacking DMARC would be verified-but-
 * undeliverable, which is a worse failure than refusing up front.
 */
export async function verifyCustomerDomain(
  resolver: DnsResolver,
  opts: { customerDomain: string; companyId: string; mailDomain: string; expectedPublicKey: string },
): Promise<DomainVerification> {
  const checks: DomainCheck[] = [];

  const expectCname = async (name: string, want: string, label: string) => {
    try {
      const got = await resolver.resolveCname(name);
      const ok = got.some((c) => c.replace(/\.$/, '').toLowerCase() === want.toLowerCase());
      checks.push({ label, ok, detail: ok ? undefined : `expected CNAME to ${want}` });
    } catch {
      checks.push({ label, ok: false, detail: `no CNAME found at ${name}` });
    }
  };

  await expectCname(
    `bounce.${opts.customerDomain}`,
    `bounce.${opts.mailDomain}`,
    'Return path delegated',
  );
  await expectCname(
    `s1._domainkey.${opts.customerDomain}`,
    dkimTargetHost('s1', opts.companyId, opts.mailDomain),
    'DKIM key s1 delegated',
  );
  await expectCname(
    `s2._domainkey.${opts.customerDomain}`,
    dkimTargetHost('s2', opts.companyId, opts.mailDomain),
    'DKIM key s2 delegated',
  );

  // Resolve the signing key THROUGH the delegation, so we prove the chain a
  // receiver will actually walk, not merely that a CNAME exists.
  try {
    const txt = await resolver.resolveTxt(`s1._domainkey.${opts.customerDomain}`);
    const joined = txt.map((parts) => parts.join(''));
    const ok = joined.some((v) => v.includes(opts.expectedPublicKey));
    checks.push({
      label: 'DKIM key resolves',
      ok,
      detail: ok ? undefined : 'the published key does not match the one we hold',
    });
  } catch {
    checks.push({ label: 'DKIM key resolves', ok: false, detail: 'no TXT resolved through the CNAME' });
  }

  try {
    const txt = await resolver.resolveTxt(`_dmarc.${opts.customerDomain}`);
    const ok = txt.map((p) => p.join('')).some((v) => /^v=DMARC1/i.test(v.trim()));
    checks.push({
      label: 'DMARC published',
      ok,
      detail: ok ? undefined : 'Gmail and Yahoo require DMARC for bulk senders',
    });
  } catch {
    checks.push({ label: 'DMARC published', ok: false, detail: 'no _dmarc record found' });
  }

  return { verified: checks.every((c) => c.ok), checks };
}
