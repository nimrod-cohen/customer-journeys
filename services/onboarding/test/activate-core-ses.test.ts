import { describe, it, expect, vi } from 'vitest';
import { activate, type ActivateDeps } from '../src/activate.js';
import { buildDnsRecordSet, type DnsRecordType } from '../src/core.js';
import type { SesEmailClient, DkimStatus } from '@cdp/email';
import type {
  DnsResolver,
  PersistedSendingIdentity,
  SendingIdentityReader,
} from '../src/check-domain.js';
import type { SqlStatement } from '../src/core.js';

// §10A step 4 — the `activate` entrypoint wiring with DECOUPLED mocks: an
// injected SES-status reader and an injected DNS resolver. Proves the gate is
// SES status: on deny NO Configuration Set is created and NO status write
// happens; only SES SUCCESS + required DNS resolved creates the cfg set + commits.
const ws = '33333333-0000-0000-0000-000000000003';
const domain = 'mail.acme.com';
const tokens = ['t1', 't2', 't3'];
const mailFrom = 'bounce.mail.acme.com';
const region = 'us-east-1';
const set = buildDnsRecordSet(domain, tokens, mailFrom, region);

const persisted: PersistedSendingIdentity = {
  from_domain: domain,
  ses_identity: domain,
  dkim_tokens: tokens,
  mail_from: mailFrom,
};

function dnsFrom(values: Map<string, string[]>): DnsResolver {
  return {
    async resolve(name: string, type: DnsRecordType): Promise<readonly string[]> {
      return values.get(`${name}|${type}`) ?? [];
    },
  };
}
function dnsAllRequiredNonDkim(): DnsResolver {
  const m = new Map<string, string[]>();
  for (const r of set.records) {
    if (r.required && r.role !== 'dkim') m.set(`${r.name}|${r.type}`, [r.value]);
  }
  return dnsFrom(m);
}
function dnsEmpty(): DnsResolver {
  return dnsFrom(new Map());
}

function makeDeps(opts: {
  ses: SesEmailClient;
  dns: DnsResolver;
  capture?: { ws?: string; statements?: readonly SqlStatement[] };
}): ActivateDeps {
  const identity: SendingIdentityReader = { read: vi.fn(async () => persisted) };
  return {
    ses: opts.ses,
    dns: opts.dns,
    identity,
    region,
    configSetName: (id) => `cdp-ws-${id}`,
    runInWorkspaceTx: async (workspaceId, statements) => {
      if (opts.capture) {
        opts.capture.ws = workspaceId;
        opts.capture.statements = statements;
      }
    },
  };
}

function sesWith(status: DkimStatus): SesEmailClient {
  return {
    createDomainIdentity: vi.fn(),
    getIdentityVerificationAttributes: vi.fn(async () => ({
      dkimStatus: status,
      signingEnabled: status === 'SUCCESS',
      dkimTokens: tokens,
    })),
    createConfigurationSet: vi.fn(async () => {}),
  } as unknown as SesEmailClient;
}

describe('activate entrypoint (decoupled SES + DNS mocks)', () => {
  it('DENY: DNS all-required-found but SES PENDING → no cfg set, no status write', async () => {
    const ses = sesWith('PENDING');
    const capture: { ws?: string; statements?: readonly SqlStatement[] } = {};
    const deps = makeDeps({ ses, dns: dnsAllRequiredNonDkim(), capture });

    const out = await activate(deps, { workspaceId: ws });
    expect(out.decision.allowed).toBe(false);
    expect(ses.createConfigurationSet).not.toHaveBeenCalled();
    expect(capture.statements).toBeUndefined(); // no commit
  });

  it('DENY: SES SUCCESS but required DNS pending → no cfg set, no status write', async () => {
    const ses = sesWith('SUCCESS');
    const capture: { ws?: string; statements?: readonly SqlStatement[] } = {};
    const deps = makeDeps({ ses, dns: dnsEmpty(), capture });

    const out = await activate(deps, { workspaceId: ws });
    expect(out.decision.allowed).toBe(false);
    expect(ses.createConfigurationSet).not.toHaveBeenCalled();
    expect(capture.statements).toBeUndefined();
  });

  it('ALLOW: SES SUCCESS + required DNS resolved → creates cfg set + commits scoped update', async () => {
    const ses = sesWith('SUCCESS');
    const capture: { ws?: string; statements?: readonly SqlStatement[] } = {};
    const deps = makeDeps({ ses, dns: dnsAllRequiredNonDkim(), capture });

    const out = await activate(deps, { workspaceId: ws });
    expect(out.decision.allowed).toBe(true);
    expect(ses.createConfigurationSet).toHaveBeenCalledWith(`cdp-ws-${ws}`);
    expect(capture.ws).toBe(ws);
    expect(capture.statements).toHaveLength(1);
    expect(capture.statements![0]!.values[0]).toBe(ws);
    expect(capture.statements![0]!.text).toMatch(/status = 'active'/);
  });

  it('creates the Configuration Set BEFORE committing the active status', async () => {
    const order: string[] = [];
    const ses = {
      createDomainIdentity: vi.fn(),
      getIdentityVerificationAttributes: vi.fn(async () => ({
        dkimStatus: 'SUCCESS' as DkimStatus,
        signingEnabled: true,
        dkimTokens: tokens,
      })),
      createConfigurationSet: vi.fn(async () => {
        order.push('cfgset');
      }),
    } as unknown as SesEmailClient;
    const deps: ActivateDeps = {
      ...makeDeps({ ses, dns: dnsAllRequiredNonDkim() }),
      runInWorkspaceTx: async () => {
        order.push('commit');
      },
    };
    await activate(deps, { workspaceId: ws });
    expect(order).toEqual(['cfgset', 'commit']);
  });
});
