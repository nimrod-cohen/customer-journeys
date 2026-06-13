// OnboardingWizard (§10A): the sending-domain stepper. Step 1 enter domain →
// start (SES identity + DKIM, returns records). Step 2 show copy-paste records
// with live status badges → check (re-reads SES DKIM + DNS). Step 3 activate
// (gated on SES DKIM verified). SES/DNS are mocked locally; the gate logic is the
// real onboarding core server-side. (Visual redesign; data-testid preserved.)
import { useState } from 'preact/hooks';
import { api } from '../store/session.js';
import { Badge, Button, Card, Input, PageHeader, toneFor } from '../ui/kit.js';
import { SendingDomains } from './SendingDomains.tsx';
import { DomainSenders } from './DomainSenders.tsx';
import type { ComponentChildren } from 'preact';

interface DnsRecord {
  role: string;
  type: string;
  name: string;
  value: string;
}
interface RecordCheck {
  role: string;
  name: string;
  status: string;
}

function Step({
  n,
  title,
  testId,
  children,
}: {
  n: number;
  title: string;
  testId: string;
  children: ComponentChildren;
}) {
  return (
    <Card data-testid={testId} class="p-5">
      <div class="flex items-center gap-3">
        <span class="grid h-7 w-7 place-items-center rounded-full bg-brand-600 text-sm font-bold text-white">
          {n}
        </span>
        <h2 class="text-base font-bold text-ink-900">{title}</h2>
      </div>
      <div class="mt-4 pl-10">{children}</div>
    </Card>
  );
}

export function OnboardingWizard() {
  const [domain, setDomain] = useState('');
  const [records, setRecords] = useState<DnsRecord[]>([]);
  const [checks, setChecks] = useState<RecordCheck[]>([]);
  const [dkimVerified, setDkimVerified] = useState<boolean | null>(null);
  const [activated, setActivated] = useState<boolean | null>(null);
  const [reason, setReason] = useState('');
  // Bump to re-mount (re-fetch) the domains table after the wizard activates a
  // domain (activate upserts it into the list as verified, server-side).
  const [domainsKey, setDomainsKey] = useState(0);

  const start = async () => {
    const r = await api.post<{ records: { records: DnsRecord[] } }>('/sending-domain/start', {
      body: { from_domain: domain.trim() },
    });
    setRecords(r.records.records);
  };

  const check = async () => {
    const r = await api.post<{ dkimVerified: boolean; recordChecks: RecordCheck[] }>(
      '/sending-domain/check',
      {},
    );
    setDkimVerified(r.dkimVerified);
    setChecks(r.recordChecks);
  };

  const activate = async () => {
    const r = await api.post<{ decision: { allowed: boolean; reason?: string } }>(
      '/sending-domain/activate',
      {},
    );
    setActivated(r.decision.allowed);
    setReason(r.decision.reason ?? '');
    if (r.decision.allowed) setDomainsKey((k) => k + 1); // surfaces the now-verified domain in the table
  };

  const statusFor = (name: string) => checks.find((c) => c.name === name)?.status ?? 'pending';

  return (
    <section data-testid="onboarding-wizard">
      <PageHeader
        title="Sending domains"
        subtitle="Add every domain you send from. Add now, verify when DNS is ready — you can only create senders for a verified domain."
      />

      <div class="space-y-5">
        {/* PRIMARY: the domains list (add + save here) and senders for verified domains. */}
        <SendingDomains key={domainsKey} />
        <DomainSenders />

        <div class="pt-2">
          <h2 class="text-sm font-bold uppercase tracking-wide text-stone-500">Verify a domain via DNS</h2>
          <p class="mt-1 text-sm text-stone-500">
            Generate the DNS records for a domain, publish them, then check &amp; activate. Activating records the
            domain as verified in the list above.
          </p>
        </div>

        <Step n={1} title="Enter sending domain" testId="step-1">
          <div class="flex max-w-lg gap-2">
            <Input
              data-testid="domain-input"
              placeholder="mail.yourcompany.com"
              value={domain}
              onInput={(e: Event) => setDomain((e.target as HTMLInputElement).value)}
            />
            <Button data-testid="start-domain" onClick={start}>
              Start
            </Button>
          </div>
        </Step>

        <Step n={2} title="Publish DNS records" testId="step-2">
          {records.length ? (
            <div class="overflow-hidden rounded-lg border border-stone-200">
              <table class="w-full text-sm">
                <thead class="bg-stone-50 text-left text-xs uppercase tracking-wide text-stone-500">
                  <tr>
                    <th class="px-3 py-2 font-semibold">Type</th>
                    <th class="px-3 py-2 font-semibold">Name</th>
                    <th class="px-3 py-2 font-semibold">Value</th>
                    <th class="px-3 py-2 font-semibold">Status</th>
                  </tr>
                </thead>
                <tbody class="divide-y divide-stone-100 font-mono text-xs">
                  {records.map((rec, i) => (
                    <tr data-testid="dns-record" key={i}>
                      <td class="px-3 py-2 text-stone-500">{rec.type}</td>
                      <td class="px-3 py-2 text-ink-900">{rec.name}</td>
                      <td class="max-w-[18rem] truncate px-3 py-2 text-stone-600">{rec.value}</td>
                      <td class="px-3 py-2">
                        <Badge data-testid="record-status" tone={toneFor(statusFor(rec.name))}>
                          {statusFor(rec.name)}
                        </Badge>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p class="text-sm text-stone-400">Start step 1 to generate records.</p>
          )}
          <div class="mt-3 flex items-center gap-3">
            <Button
              data-testid="check-domain"
              variant="secondary"
              onClick={check}
              disabled={records.length === 0}
            >
              Check now
            </Button>
            {dkimVerified !== null ? (
              <Badge data-testid="dkim-status" tone={dkimVerified ? 'success' : 'warn'}>
                DKIM {dkimVerified ? 'verified' : 'pending'}
              </Badge>
            ) : null}
          </div>
        </Step>

        <Step n={3} title="Activate" testId="step-3">
          <Button data-testid="activate-domain" onClick={activate}>
            Activate sending
          </Button>
          {activated !== null ? (
            <p
              data-testid="activate-result"
              class={`mt-3 rounded-lg px-3 py-2 text-sm ring-1 ring-inset ${
                activated
                  ? 'bg-brand-50 text-brand-700 ring-brand-200'
                  : 'bg-amber-50 text-amber-700 ring-amber-200'
              }`}
            >
              {activated ? 'Activated — sending enabled' : `Not activated: ${reason}`}
            </p>
          ) : null}
        </Step>
      </div>
    </section>
  );
}
